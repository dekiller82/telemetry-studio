import type { LatLon, TelemetrySample } from '../types'

export const MAX_GPS_GAP_MS = 2_000

export function distanceMeters(a: LatLon, b: LatLon): number {
  const meanLatRad = (((a.lat + b.lat) / 2) * Math.PI) / 180
  const dLat = ((a.lat - b.lat) * Math.PI) / 180
  const dLon = (((a.lon - b.lon) * Math.PI) / 180) * Math.cos(meanLatRad)
  return Math.hypot(dLat, dLon) * 6371000
}

export const GPS_MOTION_LIMITS = {
  positionToleranceM: 15,
  speedMultiplier: 2,
  speedSlackMps: 10,
  absoluteMaxMps: 200
}

export function isGpsTransitionPlausible(
  from: TelemetrySample,
  to: TelemetrySample,
  options = GPS_MOTION_LIMITS
): boolean {
  const seconds = (to.cts - from.cts) / 1000
  if (!Number.isFinite(seconds) || seconds <= 0) return false
  const speed = Math.min(options.absoluteMaxMps,
    options.speedMultiplier * Math.max(0, from.speed2D, to.speed2D) + options.speedSlackMps)
  return distanceMeters(from, to) <= options.positionToleranceM + speed * seconds
}

/** One shared rule for geometry, interpolation, distance and crossing detection. */
export function canConnectGpsSamples(from: TelemetrySample, to: TelemetrySample): boolean {
  return to.cts - from.cts <= MAX_GPS_GAP_MS && isGpsTransitionPlausible(from, to)
}

// Samples are immutable after import. Prefix counts keep per-frame lap validity queries O(log n).
const breakCounts = new WeakMap<TelemetrySample[], Uint32Array>()
export function isGpsRangeContinuous(samples: TelemetrySample[], start: number, end: number): boolean {
  if (!samples.length || !Number.isFinite(start) || !Number.isFinite(end) || start > end ||
    start < samples[0].cts || end > samples[samples.length - 1].cts) return false
  let counts = breakCounts.get(samples)
  if (!counts) {
    counts = new Uint32Array(samples.length)
    for (let i = 1; i < samples.length; i++) counts[i] = counts[i - 1] + (canConnectGpsSamples(samples[i - 1], samples[i]) ? 0 : 1)
    breakCounts.set(samples, counts)
  }
  const bracket = (time: number): number => {
    let lo = 0, hi = samples.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (samples[mid].cts <= time) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const first = bracket(start)
  const last = bracket(end)
  const right = samples[last].cts === end ? last : last + 1
  return counts[right] === counts[first]
}
