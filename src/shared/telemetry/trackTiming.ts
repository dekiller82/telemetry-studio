import type { LatLon, SectorTimingSettings, TelemetrySample } from '../types'
import type { DeltaState, LapDistanceCurve } from './deltaTime'
import { canConnectGpsSamples, distanceMeters, isGpsRangeContinuous } from './gpsContinuity'
import { findBracketIndex } from './interpolate'
import { getSectorStateAt, type SectorBoundary, type SectorState } from './sectors'

export const DEFAULT_SECTOR_TIMING: SectorTimingSettings = { s1: null, s2: null }
const CORRIDOR_M = 30
const STOP_SPEED_MPS = 1
const STOP_DURATION_MS = 10_000

interface RoutePoint extends LatLon { x: number; y: number; distance: number }
interface Route {
  points: RoutePoint[]
  length: number
  origin: LatLon
  project: (point: LatLon, lower?: number, upper?: number) => { distance: number; error: number } | null
}
export interface TimingGate extends LatLon { distanceM: number; manual: boolean }
export interface TimingLap {
  lapNumber: number
  start: number
  end: number
  completed: boolean
  validUntil: number
  reason: 'gps-gap' | 'off-route' | 'incomplete-circuit' | null
  excluded: boolean
  /** Advisory only: slow/stopped for 10 seconds is not an automatic results decision. */
  longStopAt: number | null
  times: number[]
  distances: number[]
  s1: number | null
  s2: number | null
}
export interface TrackTimingModel {
  crossings: number[]
  referenceLapNumber: number | null
  route: LatLon[]
  routeLengthM: number
  gates: { s1: TimingGate; s2: TimingGate } | null
  error: string | null
  laps: TimingLap[]
  boundaries: SectorBoundary[]
  curves: LapDistanceCurve[]
}

function positionAt(samples: TelemetrySample[], time: number): TelemetrySample | null {
  if (!samples.length || time < samples[0].cts || time > samples[samples.length - 1].cts) return null
  const i = findBracketIndex(samples, time)
  const a = samples[i]
  if (a.cts === time) return a
  const b = samples[i + 1]
  if (!b || !canConnectGpsSamples(a, b)) return null
  const f = (time - a.cts) / (b.cts - a.cts)
  return { ...a, cts: time, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f,
    speed2D: a.speed2D + (b.speed2D - a.speed2D) * f }
}

function lapSamples(samples: TelemetrySample[], start: number, end: number): TelemetrySample[] {
  const first = positionAt(samples, start)
  const last = positionAt(samples, end)
  if (!first || !last || end <= start) return []
  const result = [first]
  for (let i = findBracketIndex(samples, start) + 1; i < samples.length && samples[i].cts < end; i++) result.push(samples[i])
  result.push(last)
  return result
}

function stoppedAt(samples: TelemetrySample[]): number | null {
  let since: number | null = null
  for (let i = 1; i < samples.length; i++) {
    if (Math.max(samples[i - 1].speed2D, samples[i].speed2D) < STOP_SPEED_MPS) {
      since ??= samples[i - 1].cts
      if (samples[i].cts - since >= STOP_DURATION_MS) return since + STOP_DURATION_MS
    } else since = null
  }
  return null
}

function makeRoute(samples: TelemetrySample[]): Route | null {
  if (samples.length < 3) return null
  const origin = samples[0]
  const mx = Math.cos(origin.lat * Math.PI / 180) * Math.PI * 6371000 / 180
  const my = Math.PI * 6371000 / 180
  const xy = (p: LatLon): { x: number; y: number } => ({ x: (p.lon - origin.lon) * mx, y: (p.lat - origin.lat) * my })
  const points: RoutePoint[] = [{ ...origin, ...xy(origin), distance: 0 }]
  // Bound the reference geometry, avoiding an O(source samples squared) projection scan.
  for (let i = 1; i < samples.length; i++) {
    const previous = points[points.length - 1]
    const length = distanceMeters(previous, samples[i])
    if (length < 2 && i < samples.length - 1) continue
    if (length <= 0) continue
    points.push({ ...samples[i], ...xy(samples[i]), distance: previous.distance + length })
  }
  const length = points[points.length - 1].distance
  if (length < 50 || distanceMeters(samples[0], samples[samples.length - 1]) > Math.max(30, length * 0.05)) return null
  const cells = new Map<string, number[]>()
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    for (let x = Math.floor(Math.min(a.x, b.x) / CORRIDOR_M); x <= Math.floor(Math.max(a.x, b.x) / CORRIDOR_M); x++) {
      for (let y = Math.floor(Math.min(a.y, b.y) / CORRIDOR_M); y <= Math.floor(Math.max(a.y, b.y) / CORRIDOR_M); y++) {
        const key = `${x},${y}`
        const indices = cells.get(key) ?? []
        indices.push(i)
        cells.set(key, indices)
      }
    }
  }
  return {
    points, length, origin,
    project(point, lower = 0, upper = length) {
      const p = xy(point)
      const cx = Math.floor(p.x / CORRIDOR_M), cy = Math.floor(p.y / CORRIDOR_M)
      const candidates = new Set<number>()
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
        for (const i of cells.get(`${x},${y}`) ?? []) candidates.add(i)
      }
      let best: { distance: number; error: number } | null = null
      for (const i of candidates) {
        const a = points[i - 1], b = points[i]
        if (b.distance < lower || a.distance > upper) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const fraction = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
        const distance = a.distance + fraction * (b.distance - a.distance)
        if (distance < lower || distance > upper) continue
        const error = Math.hypot(p.x - a.x - fraction * dx, p.y - a.y - fraction * dy)
        if (error <= CORRIDOR_M && (!best || error < best.error)) best = { distance, error }
      }
      return best
    }
  }
}

function pointOnRoute(route: Route, distance: number): LatLon {
  for (let i = 1; i < route.points.length; i++) {
    const b = route.points[i], a = route.points[i - 1]
    if (b.distance < distance) continue
    const f = (distance - a.distance) / (b.distance - a.distance)
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }
  }
  return route.points[route.points.length - 1]
}

/** First arrival at a reference distance. Plateau GPS jitter never manufactures elapsed distance. */
function arrival(times: number[], distances: number[], target: number): number | null {
  if (!distances.length || target > distances[distances.length - 1]) return null
  let lo = 0, hi = distances.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (distances[mid] >= target) hi = mid
    else lo = mid + 1
  }
  if (lo === 0) return times[0]
  const a = distances[lo - 1], b = distances[lo]
  return times[lo - 1] + (times[lo] - times[lo - 1]) * (target - a) / (b - a)
}

function mapLap(samples: TelemetrySample[], lapNumber: number, start: number, end: number,
  completed: boolean, route: Route, gates: { s1: TimingGate; s2: TimingGate }): TimingLap {
  const points = lapSamples(samples, start, end)
  const lap: TimingLap = { lapNumber, start, end, completed, validUntil: end, reason: null,
    excluded: false, longStopAt: stoppedAt(points), times: [], distances: [], s1: null, s2: null }
  if (points.length < 2) return { ...lap, validUntil: start, reason: 'gps-gap' }
  let previousDistance = 0
  lap.times.push(start)
  lap.distances.push(0)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    if (!canConnectGpsSamples(a, b)) { lap.validUntil = a.cts; lap.reason = 'gps-gap'; break }
    // Match nearby route segments in travel order. This prevents jumping to a parallel straight
    // or a later hairpin and never rescales the lap from its eventual total distance.
    const advance = Math.max(15, distanceMeters(a, b) * 3 + 5)
    const match = route.project(b, Math.max(0, previousDistance - 8), Math.min(route.length, previousDistance + advance))
    if (!match) { lap.validUntil = a.cts; lap.reason = 'off-route'; break }
    previousDistance = Math.max(previousDistance, match.distance)
    lap.times.push(b.cts)
    lap.distances.push(previousDistance)
  }
  if (completed && !lap.reason) {
    if (previousDistance < route.length - Math.max(12, route.length * 0.015)) lap.reason = 'incomplete-circuit'
    else lap.distances[lap.distances.length - 1] = route.length
  }
  lap.s1 = arrival(lap.times, lap.distances, gates.s1.distanceM)
  lap.s2 = arrival(lap.times, lap.distances, gates.s2.distanceM)
  return lap
}

/** A single project-wide position axis, fixed gates and eligible reference laps for BOTH widgets.
 * Geometry comes from the first continuous, moving, closed circuit and stays fixed when a faster
 * lap appears. Only elapsed times use a fastest lap completed before the displayed lap starts.
 */
export function computeTrackTiming(samples: TelemetrySample[], crossings: number[], settings = DEFAULT_SECTOR_TIMING,
  excluded?: ReadonlySet<number>): TrackTimingModel {
  const model: TrackTimingModel = { crossings, referenceLapNumber: null, route: [], routeLengthM: 0,
    gates: null, error: null, laps: [], boundaries: [], curves: [] }
  let route: Route | null = null
  // Geometry is independent of results eligibility: toggling a lap must not move fixed sector
  // locations. Prefer a moving circuit, but permit an otherwise usable stopped circuit too.
  chooseRoute: for (const allowStop of [false, true]) {
    for (let i = 1; i < crossings.length; i++) {
      if (!isGpsRangeContinuous(samples, crossings[i - 1], crossings[i])) continue
      const points = lapSamples(samples, crossings[i - 1], crossings[i])
      if (!allowStop && stoppedAt(points) !== null) continue
      route = makeRoute(points)
      if (route) { model.referenceLapNumber = i; break chooseRoute }
    }
  }
  if (!route) { model.error = 'A continuous, complete circuit is needed to establish fixed sector locations.'; return model }
  model.route = route.points.map(({ lat, lon }) => ({ lat, lon }))
  model.routeLengthM = route.length
  const gate = (manual: LatLon | null, fraction: number): TimingGate | null => {
    const point = manual ?? pointOnRoute(route!, route!.length * fraction)
    const distance = manual ? route!.project(point)?.distance : route!.length * fraction
    return distance === undefined ? null : { lat: point.lat, lon: point.lon, distanceM: distance, manual: !!manual }
  }
  const s1 = gate(settings.s1, 1 / 3), s2 = gate(settings.s2, 2 / 3)
  if (!s1 || !s2) { model.error = 'A sector marker is more than 30 m from the reference circuit. Choose a point on the track.'; return model }
  if (s1.distanceM < 5 || s2.distanceM - s1.distanceM < 5 || route.length - s2.distanceM < 5) {
    model.error = 'Sector markers must follow the driving direction: start/finish → S1 → S2 → start/finish, at least 5 m apart.'
    return model
  }
  model.gates = { s1, s2 }
  for (let i = 0; i < crossings.length; i++) {
    const start = crossings[i]
    const completed = i + 1 < crossings.length
    const end = completed ? crossings[i + 1] : samples[samples.length - 1]?.cts ?? start
    if (end <= start) continue
    const lap = mapLap(samples, i + 1, start, end, completed, route, model.gates)
    lap.excluded = excluded?.has(i + 1) === true
    model.laps.push(lap)
    const eligible = completed && !lap.reason && !lap.excluded && lap.s1 !== null && lap.s2 !== null
    model.boundaries.push({ lapNumber: i + 1, isOutLap: false, lapStartCts: start,
      s1Cts: lap.s1 ?? Infinity, s2Cts: lap.s2 ?? Infinity, lapEndCts: completed ? end : Infinity,
      complete: eligible, excluded: lap.excluded, validUntilCts: lap.validUntil })
    if (eligible) {
      model.curves.push({ lapNumber: i + 1, lapStartCts: start, lapEndCts: end,
        totalDistanceM: route.length, totalTimeMs: end - start,
        timeAtDistance: (distance) => (arrival(lap.times, lap.distances, Math.max(0, Math.min(route!.length, distance))) ?? end) - start })
    }
  }
  return model
}

function lapAt(model: TrackTimingModel, cts: number): TimingLap | undefined {
  return model.laps.find((lap) => cts >= lap.start && (cts < lap.end || (!lap.completed && cts === lap.end)))
}

export function getTrackSectorStateAt(model: TrackTimingModel, cts: number): SectorState | null {
  // An ordinary running clock needs no sector geometry. Keep it resetting at real crossings
  // while waiting for the first usable circuit, without inventing S1/S2 results or a delta.
  if (model.error) return model.referenceLapNumber === null && model.crossings.length
    ? getSectorStateAt([], cts, model.crossings) : null
  const lap = lapAt(model, cts)
  if (lap && (cts > lap.validUntil || !lap.times.length)) {
    // The GPS comparison is unavailable, but detected crossings still provide an ordinary
    // running clock. Preserve completed valid results without exposing this invalid lap's splits.
    const completed = model.boundaries.filter((b) => b.complete !== false && b.lapEndCts <= cts)
    return { ...getSectorStateAt(completed, cts, model.crossings), currentLapExcluded: lap.excluded }
  }
  return getSectorStateAt(model.boundaries, cts, model.crossings)
}

/** Recap totals remain available even when the video ends in a stopped or GPS-invalid interval. */
export function getTrackSectorSummaryAt(model: TrackTimingModel, cts: number): SectorState | null {
  if (model.error) return null
  // Keep completed eligible results and currently valid partial checkpoints. Once an invalid
  // interval's validity expires, its earlier S1/S2 must not become the recap's sector bests.
  const summaryBoundaries = model.boundaries.filter((b) => b.complete !== false || cts <= (b.validUntilCts ?? Infinity))
  return getSectorStateAt(summaryBoundaries, cts, model.crossings)
}

export function getTrackDeltaStateAt(model: TrackTimingModel, cts: number): DeltaState {
  const empty: DeltaState = { deltaMs: null, baselineLapMs: null, predictedLapMs: null, ghostCts: null }
  if (model.error) return empty
  const lap = lapAt(model, cts)
  if (!lap || lap.excluded || cts > lap.validUntil || !lap.times.length) return empty
  // Freeze the reference for the whole lap, including its S1/S2 results.
  const baseline = model.curves.filter((c) => c.lapEndCts <= lap.start)
    .reduce<LapDistanceCurve | null>((best, c) => !best || c.totalTimeMs < best.totalTimeMs ? c : best, null)
  if (!baseline) return empty
  let lo = 0, hi = lap.times.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lap.times[mid] <= cts) lo = mid
    else hi = mid - 1
  }
  let distance = lap.distances[lo]
  if (lo + 1 < lap.times.length) {
    const f = (cts - lap.times[lo]) / (lap.times[lo + 1] - lap.times[lo])
    distance += (lap.distances[lo + 1] - distance) * Math.max(0, Math.min(1, f))
  }
  const elapsed = cts - lap.start
  const deltaMs = elapsed - baseline.timeAtDistance(distance)
  return { deltaMs, baselineLapMs: baseline.totalTimeMs, predictedLapMs: baseline.totalTimeMs + deltaMs,
    ghostCts: Math.min(baseline.lapEndCts, baseline.lapStartCts + elapsed) }
}
