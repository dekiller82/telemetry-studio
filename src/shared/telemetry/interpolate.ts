import type { TelemetrySample } from '../types'
import { canConnectGpsSamples } from './gpsContinuity'

export interface ProjectedPoint {
  x: number
  y: number
  /** Begins a new path: never smooth or draw across its preceding edge. */
  breakBefore?: boolean
}

const EARTH_RADIUS_M = 6371000

/** Flattens lat/lon into local planar meters via an equirectangular projection centered on the track's mean latitude. */
export function projectTrack(samples: TelemetrySample[]): ProjectedPoint[] {
  if (samples.length === 0) return []
  const meanLat = samples.reduce((sum, s) => sum + s.lat, 0) / samples.length
  const cosMeanLat = Math.cos((meanLat * Math.PI) / 180)

  return samples.map((s, i) => ({
    x: ((s.lon * Math.PI) / 180) * cosMeanLat * EARTH_RADIUS_M,
    y: ((s.lat * Math.PI) / 180) * EARTH_RADIUS_M,
    ...(i > 0 && !canConnectGpsSamples(samples[i - 1], s) ? { breakBefore: true } : {})
  }))
}

/**
 * Smooths a sequence of points with a moving average over `windowRadius` neighbors on each side
 * (by index, not time -- GPS samples arrive at a roughly fixed rate so index proximity tracks
 * time proximity closely enough). Raw consumer-grade GPS position has real point-to-point scatter
 * (a few meters even in a straight line), which the Catmull-Rom spline in `positionAt` would
 * otherwise faithfully reproduce as jitter since it passes exactly through every raw sample.
 * Window shrinks near the ends so the start/finish of the track isn't flattened or cut short.
 */
export function smoothTrackPoints(points: ProjectedPoint[], windowRadius = 3): ProjectedPoint[] {
  const n = points.length
  if (n <= 2 || windowRadius <= 0) return points

  const smoothed: ProjectedPoint[] = new Array(n)
  for (let i = 0; i < n; i++) {
    let lo = i
    let hi = i
    while (lo > Math.max(0, i - windowRadius) && !points[lo].breakBefore) lo--
    while (hi < Math.min(n - 1, i + windowRadius) && !points[hi + 1].breakBefore) hi++
    let sumX = 0
    let sumY = 0
    for (let j = lo; j <= hi; j++) {
      sumX += points[j].x
      sumY += points[j].y
    }
    const count = hi - lo + 1
    smoothed[i] = { ...points[i], x: sumX / count, y: sumY / count }
  }
  return smoothed
}

/** Returns the largest index i such that samples[i].cts <= cts, clamped to [0, length-1]. Generic
 *  over anything with a `cts` field (TelemetrySample, ImuSample, ...) -- one bracket-search
 *  implementation shared by every cts-ordered sample array in this app. */
export function findBracketIndex<T extends { cts: number }>(samples: T[], cts: number): number {
  const n = samples.length
  if (n === 0) return -1
  if (cts <= samples[0].cts) return 0
  if (cts >= samples[n - 1].cts) return n - 1

  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].cts <= cts) lo = mid
    else hi = mid - 1
  }
  return lo
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

/**
 * Smooth curved position at time `cts`, via Catmull-Rom spline through the two bracketing
 * samples and their neighbors. GPS runs ~10-18Hz while video runs 60-240fps, so naive
 * linear interpolation would look faceted as the dot moves between fixes.
 */
export function positionAt(samples: TelemetrySample[], points: ProjectedPoint[], cts: number): ProjectedPoint {
  const n = samples.length
  if (n === 0) return { x: 0, y: 0 }
  if (n === 1) return points[0]

  const i1 = findBracketIndex(samples, cts)
  const i2 = Math.min(i1 + 1, n - 1)
  if (i1 !== i2 && !canConnectGpsSamples(samples[i1], samples[i2])) return points[i1]
  const i0 = i1 > 0 && canConnectGpsSamples(samples[i1 - 1], samples[i1]) ? i1 - 1 : i1
  const i3 = i2 + 1 < n && canConnectGpsSamples(samples[i2], samples[i2 + 1]) ? i2 + 1 : i2

  const t0 = samples[i1].cts
  const t1 = samples[i2].cts
  const t = t1 > t0 ? Math.min(1, Math.max(0, (cts - t0) / (t1 - t0))) : 0

  return {
    x: catmullRom(points[i0].x, points[i1].x, points[i2].x, points[i3].x, t),
    y: catmullRom(points[i0].y, points[i1].y, points[i2].y, points[i3].y, t)
  }
}

/**
 * Monotone cubic (Fritsch-Carlson-style) Hermite interpolant: passes exactly through every
 * (x, y) point with a continuous curve that never overshoots past its local min/max, unlike
 * a plain cubic/Catmull-Rom spline. Used as the base curve for values like speed before smoothing.
 */
export function createMonotoneCubicInterpolant(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length
  if (n === 0) return () => 0
  if (n === 1) return () => ys[0]

  const dxs: number[] = []
  const ms: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i]
    const dy = ys[i + 1] - ys[i]
    dxs.push(dx)
    ms.push(dx === 0 ? 0 : dy / dx)
  }

  const c1s: number[] = [ms[0]]
  for (let i = 0; i < dxs.length - 1; i++) {
    const m0 = ms[i]
    const m1 = ms[i + 1]
    if (m0 * m1 <= 0) {
      c1s.push(0)
    } else {
      const dx0 = dxs[i]
      const dx1 = dxs[i + 1]
      const common = dx0 + dx1
      c1s.push((3 * common) / ((common + dx1) / m0 + (common + dx0) / m1))
    }
  }
  c1s.push(ms[ms.length - 1])

  const c2s: number[] = []
  const c3s: number[] = []
  for (let i = 0; i < c1s.length - 1; i++) {
    const c1 = c1s[i]
    const m = ms[i]
    const invDx = dxs[i] === 0 ? 0 : 1 / dxs[i]
    const common = c1 + c1s[i + 1] - 2 * m
    c2s.push((m - c1 - common) * invDx)
    c3s.push(common * invDx * invDx)
  }

  return (x: number): number => {
    const last = n - 1
    if (x <= xs[0]) return ys[0]
    if (x >= xs[last]) return ys[last]

    let lo = 0
    let hi = n - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (xs[mid] <= x) lo = mid
      else hi = mid - 1
    }

    const diff = x - xs[lo]
    return ys[lo] + c1s[lo] * diff + c2s[lo] * diff * diff + c3s[lo] * diff * diff * diff
  }
}

/**
 * Stateless Gaussian-weighted average of raw samples around `cts`. Chosen over a causal EMA
 * because the editor needs random-access scrubbing (not just forward playback) — a windowed
 * kernel is a pure function of time with no history, is symmetric (no lag), and its weights
 * taper to ~0 at the window edges so the result stays continuous as samples enter/exit range.
 * `sigmaMs` doubles as the user-facing "smoothing" amount.
 */
export function gaussianSmoothedValueAt<T extends { cts: number }>(
  samples: T[],
  cts: number,
  sigmaMs: number,
  selectValue: (s: T) => number,
  /** Inclusive bounds of the current continuous segment, if the stream has gaps. */
  range?: { start: number; end: number }
): number {
  const n = samples.length
  if (n === 0) return 0
  if (n === 1) return selectValue(samples[0])

  const sigma = Math.max(1, sigmaMs)
  const radius = sigma * 3

  const center = findBracketIndex(samples, cts)
  let lo = center
  while (lo > (range?.start ?? 0) && samples[lo - 1].cts >= cts - radius) lo--
  let hi = center
  while (hi < (range?.end ?? n - 1) && samples[hi + 1].cts <= cts + radius) hi++

  let weightedSum = 0
  let weightTotal = 0
  for (let i = lo; i <= hi; i++) {
    const dt = samples[i].cts - cts
    const weight = Math.exp(-0.5 * (dt / sigma) * (dt / sigma))
    weightedSum += weight * selectValue(samples[i])
    weightTotal += weight
  }

  if (weightTotal === 0) return selectValue(samples[center])
  return weightedSum / weightTotal
}
