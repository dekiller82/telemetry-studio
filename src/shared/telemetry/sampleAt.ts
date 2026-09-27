import type { ImuSample, TelemetryData, TelemetrySample } from '../types'
import { findBracketIndex, gaussianSmoothedValueAt, positionAt, projectTrack, smoothTrackPoints, type ProjectedPoint } from './interpolate'
import { applyCalibration, calibrateAxes, GRAVITY_MPS2, type AxisCalibration } from './imuCalibration'
import { distanceMeters } from './laps'

export interface TrackBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface GForceReading {
  lateralG: number
  longitudinalG: number
}

export interface GForceHistoryPoint extends GForceReading {
  cts: number
}

export interface RollAngleReading {
  degrees: number
  /** Whether this reading came from the real gravity-vector stream (accurate, no cornering
   *  contamination) or the accelerometer-tilt fallback (reads exaggerated during hard cornering --
   *  see shared/render/drawRollAngle.ts). */
  source: 'gravity' | 'accelFallback'
}

export interface SessionStats {
  /** GPS arc-length traveled between startCts and endCts (NOT from the start of the recording --
   *  see sessionStatsAt), meters. */
  totalDistanceM: number
  /** Fastest speed2D reached between startCts and endCts, m/s. */
  maxSpeedMps: number
}

export interface ElevationProfilePoint {
  /** Cumulative GPS arc-length from the very start of the recording, meters -- the x-axis for the
   *  Elevation widget's graph (distance-based, not time-based, so the profile's shape matches the
   *  real geography regardless of how fast/slow any particular section was driven). */
  distanceM: number
  altitude: number
  cts: number
}

export interface TelemetrySampler {
  /** Raw telemetry samples, e.g. for lap-crossing detection against a start/finish lat/lon. */
  samples: TelemetrySample[]
  /** Static, precomputed track polyline in local planar meters (equirectangular projection). */
  trackPoints: ProjectedPoint[]
  bounds: TrackBounds
  /** Raw speed2D per sample, 1:1 index-aligned with trackPoints/samples -- for the GPS Track
   *  widget's optional speed/braking-colored line. Precomputed once so per-frame drawing never
   *  re-walks the full samples array. */
  trackSpeeds: number[]
  /** cts per sample, 1:1 index-aligned with trackPoints/trackSpeeds -- needed alongside trackSpeeds
   *  to compute per-segment acceleration (braking color mode) without re-reading `samples` itself. */
  trackCts: number[]
  /** Session-relative min/max of trackSpeeds, precomputed once. */
  speedBounds: { min: number; max: number }
  /** Smoothly interpolated position (Catmull-Rom) at video time `cts` (ms). */
  positionAt: (cts: number) => ProjectedPoint
  /** Whether `cts` falls inside the retained, trustworthy GPS sample range. */
  hasPositionAt: (cts: number) => boolean
  /**
   * Speed (m/s) at video time `cts`, Gaussian-smoothed over a `smoothingMs` window to damp
   * raw GPS jitter. A window floor keeps the result continuous between samples even at
   * smoothingMs = 0.
   */
  speedAt: (cts: number, smoothingMs?: number) => number
  /** Whether the session had ACCL data to calibrate against at all -- widgets show an
   *  "unavailable" state instead of a misleading reading when this is false. */
  hasImuData: boolean
  /** Axis mapping auto-detected once for this session (see imuCalibration.ts). Callers can pass
   *  their own override (property-panel manual axis mapping) instead of using this default. */
  defaultAxisCalibration: AxisCalibration
  /** Gaussian-smoothed lateral/longitudinal G-force at `cts`, projected onto the calibrated axes. */
  gForceAt: (cts: number, smoothingMs?: number, calibrationOverride?: AxisCalibration) => GForceReading
  /** Raw (unsmoothed -- a real friction-circle trail is a scatter, not a smooth line) calibrated
   *  G-force points in the last `windowMs` up to `cts`, for a fading trail. */
  gForceHistoryAt: (cts: number, windowMs: number, calibrationOverride?: AxisCalibration) => GForceHistoryPoint[]
  /** Roll/lean angle in degrees at `cts`, from the gravity-vector stream when present, otherwise a
   *  raw-accelerometer-tilt fallback (see RollAngleReading.source). Only the vertical/lateral axes of
   *  `calibrationOverride` matter here (longitudinal is irrelevant to roll). */
  rollAngleAt: (cts: number, smoothingMs?: number, calibrationOverride?: AxisCalibration) => RollAngleReading
  /** Total distance covered and fastest speed reached strictly BETWEEN startCts and endCts -- for
   *  the Session Summary widget, which pairs this with an elapsed time also measured over that same
   *  [startCts, endCts] window (the trim range), not from the start of the recording. Distance is a
   *  cheap prefix-sum lookup (precomputed once); max speed is a linear scan over just that range's
   *  samples, which is fine since this is only queried once per relevant recompute, not per frame. */
  sessionStatsAt: (startCts: number, endCts: number) => SessionStats
  /** Static, precomputed altitude-vs-distance profile for the whole session -- the Elevation
   *  widget's graph draws this once and just moves a "now" marker along it, same "precompute the
   *  static shape, resolve only the current position per frame" split as trackPoints/dotPosition. */
  elevationProfile: ElevationProfilePoint[]
  /** Gaussian-smoothed altitude at `cts`, meters -- for the Elevation widget's numeric readout. */
  elevationAt: (cts: number, smoothingMs?: number) => number
  /** Cumulative GPS arc-length from the very start of the recording up to `cts`, meters -- for the
   *  Distance widget's live readout. A cheap prefix-sum lookup, same cumDistanceM array sessionStatsAt
   *  already uses internally. */
  distanceAt: (cts: number) => number
  /** Compass heading in degrees (0=N, 90=E, ...) at `cts`, derived from the direction of travel
   *  between GPS fixes (course over ground) -- GoPro has no magnetometer, so this is the only
   *  heading source available, and is meaningless while stationary (see headingComponents' carry-
   *  forward behavior below). Circularly smoothed (via component-wise cos/sin averaging, not a
   *  naive linear average, which would break at the 359->0 wraparound) over a `smoothingMs` window. */
  headingAt: (cts: number, smoothingMs?: number) => number
}

const MIN_SMOOTHING_MS = 60
export const DEFAULT_SPEED_SMOOTHING_MS = 350
export const DEFAULT_GFORCE_SMOOTHING_MS = 150
export const DEFAULT_ROLL_SMOOTHING_MS = 150
export const DEFAULT_ELEVATION_SMOOTHING_MS = 500
export const DEFAULT_HEADING_SMOOTHING_MS = 400

interface HeadingComponent {
  cts: number
  cosB: number
  sinB: number
}

/** One bearing per sample (degrees expressed as unit-circle cos/sin components, not a raw degree
 *  number, so headingAt can circularly average them with the existing gaussianSmoothedValueAt
 *  helper instead of needing a bespoke wraparound-aware smoother). Bearing between sample i and i+1
 *  (or i-1 and i for the last sample), in the same local planar (x=east, y=north) frame trackPoints
 *  already uses. When two consecutive points coincide (car stationary -- a zero-length segment has
 *  no real direction), the previous bearing is carried forward instead of reporting a false North,
 *  same "don't let a degenerate case dominate the reading" reasoning as the GRAV-all-zero fix. */
function computeHeadingComponents(samples: TelemetrySample[], trackPoints: ProjectedPoint[]): HeadingComponent[] {
  const n = samples.length
  if (n === 0) return []

  const components: HeadingComponent[] = new Array(n)
  let bearingRad = 0
  for (let i = 0; i < n; i++) {
    const a = i < n - 1 ? i : i - 1
    const b = i < n - 1 ? i + 1 : i
    const dx = trackPoints[b].x - trackPoints[a].x
    const dy = trackPoints[b].y - trackPoints[a].y
    if (dx * dx + dy * dy > 1e-6) bearingRad = Math.atan2(dx, dy)
    components[i] = { cts: samples[i].cts, cosB: Math.cos(bearingRad), sinB: Math.sin(bearingRad) }
  }
  return components
}

function computeBounds(points: ProjectedPoint[]): TrackBounds {
  if (points.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  let minX = points[0].x
  let maxX = points[0].x
  let minY = points[0].y
  let maxY = points[0].y
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, maxX, minY, maxY }
}

/** Prefix array (1:1 index-aligned with `samples`): cumulative arc-length distance up to and
 *  including that sample index. Computed once per sampler, same cost class as trackSpeeds/trackCts
 *  -- lets sessionStatsAt turn a distance-over-a-range query into one subtraction instead of an
 *  O(n) rescan every call. (Max speed over a range isn't prefix-summable the same way a running max
 *  only works for "up to index i", not arbitrary [start, end] windows -- sessionStatsAt scans just
 *  that range directly instead.) */
function computeCumulativeDistanceM(samples: TelemetrySample[]): number[] {
  const cumDistanceM: number[] = new Array(samples.length)
  let cum = 0
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) cum += distanceMeters(samples[i - 1], samples[i])
    cumDistanceM[i] = cum
  }
  return cumDistanceM
}

function computeSpeedBounds(speeds: number[]): { min: number; max: number } {
  if (speeds.length === 0) return { min: 0, max: 0 }
  let min = speeds[0]
  let max = speeds[0]
  for (const s of speeds) {
    if (s < min) min = s
    if (s > max) max = s
  }
  return { min, max }
}

export function createTelemetrySampler(telemetry: TelemetryData): TelemetrySampler {
  const samples = telemetry.samples
  // Smoothed once here so the drawn track line and the moving dot (which interpolates between
  // these same points) always agree -- the dot never appears to drift off the line.
  const trackPoints = smoothTrackPoints(projectTrack(samples))
  const bounds = computeBounds(trackPoints)
  const trackSpeeds = samples.map((s) => s.speed2D)
  const trackCts = samples.map((s) => s.cts)
  const speedBounds = computeSpeedBounds(trackSpeeds)
  const cumDistanceM = computeCumulativeDistanceM(samples)
  const elevationProfile: ElevationProfilePoint[] = samples.map((s, i) => ({ distanceM: cumDistanceM[i], altitude: s.altitude, cts: s.cts }))
  const headingComponents = computeHeadingComponents(samples, trackPoints)

  function hasPositionAt(cts: number): boolean {
    return samples.length > 0 && cts >= samples[0].cts && cts <= samples[samples.length - 1].cts
  }

  function elevationAt(cts: number, smoothingMs = DEFAULT_ELEVATION_SMOOTHING_MS): number {
    if (!hasPositionAt(cts)) return 0
    return gaussianSmoothedValueAt(samples, cts, Math.max(MIN_SMOOTHING_MS, smoothingMs), (s) => s.altitude)
  }

  function distanceAt(cts: number): number {
    if (samples.length === 0) return 0
    return cumDistanceM[findBracketIndex(samples, cts)]
  }

  function headingAt(cts: number, smoothingMs = DEFAULT_HEADING_SMOOTHING_MS): number {
    if (!hasPositionAt(cts) || headingComponents.length === 0) return 0
    const window = Math.max(MIN_SMOOTHING_MS, smoothingMs)
    const cosAvg = gaussianSmoothedValueAt(headingComponents, cts, window, (c) => c.cosB)
    const sinAvg = gaussianSmoothedValueAt(headingComponents, cts, window, (c) => c.sinB)
    const deg = (Math.atan2(sinAvg, cosAvg) * 180) / Math.PI
    return deg < 0 ? deg + 360 : deg
  }

  function sessionStatsAt(startCts: number, endCts: number): SessionStats {
    if (samples.length === 0) return { totalDistanceM: 0, maxSpeedMps: 0 }
    const startIdx = findBracketIndex(samples, startCts)
    const endIdx = findBracketIndex(samples, endCts)
    const totalDistanceM = Math.max(0, cumDistanceM[endIdx] - cumDistanceM[startIdx])
    let maxSpeedMps = 0
    for (let i = startIdx; i <= endIdx; i++) maxSpeedMps = Math.max(maxSpeedMps, trackSpeeds[i])
    return { totalDistanceM, maxSpeedMps }
  }

  const accel = telemetry.accel
  const gravity = telemetry.gravity
  const defaultAxisCalibration = calibrateAxes(accel, gravity, samples)

  function gForceAt(cts: number, smoothingMs = DEFAULT_GFORCE_SMOOTHING_MS, calibrationOverride?: AxisCalibration): GForceReading {
    if (accel.length === 0) return { lateralG: 0, longitudinalG: 0 }
    const cal = calibrationOverride ?? defaultAxisCalibration
    const window = Math.max(MIN_SMOOTHING_MS, smoothingMs)
    const longitudinalMps2 = gaussianSmoothedValueAt(accel, cts, window, (s: ImuSample) => applyCalibration(s, cal).longitudinal)
    const lateralMps2 = gaussianSmoothedValueAt(accel, cts, window, (s: ImuSample) => applyCalibration(s, cal).lateral)
    return { longitudinalG: longitudinalMps2 / GRAVITY_MPS2, lateralG: lateralMps2 / GRAVITY_MPS2 }
  }

  function gForceHistoryAt(cts: number, windowMs: number, calibrationOverride?: AxisCalibration): GForceHistoryPoint[] {
    if (accel.length === 0) return []
    const cal = calibrationOverride ?? defaultAxisCalibration
    const startCts = cts - windowMs
    const startIdx = findBracketIndex(accel, startCts)
    const endIdx = findBracketIndex(accel, cts)
    const points: GForceHistoryPoint[] = []
    for (let i = startIdx; i <= endIdx; i++) {
      if (accel[i].cts < startCts || accel[i].cts > cts) continue
      const projected = applyCalibration(accel[i], cal)
      points.push({ cts: accel[i].cts, longitudinalG: projected.longitudinal / GRAVITY_MPS2, lateralG: projected.lateral / GRAVITY_MPS2 })
    }
    return points
  }

  function rollAngleAt(cts: number, smoothingMs = DEFAULT_ROLL_SMOOTHING_MS, calibrationOverride?: AxisCalibration): RollAngleReading {
    const cal = calibrationOverride ?? defaultAxisCalibration
    const window = Math.max(MIN_SMOOTHING_MS, smoothingMs)
    const source = gravity.length > 0 ? gravity : accel
    if (source.length === 0) return { degrees: 0, source: 'accelFallback' }

    const lateral = gaussianSmoothedValueAt(source, cts, window, (s: ImuSample) => applyCalibration(s, cal).lateral)
    const vertical = gaussianSmoothedValueAt(source, cts, window, (s: ImuSample) => applyCalibration(s, cal).vertical)
    const degrees = (Math.atan2(lateral, vertical) * 180) / Math.PI
    return { degrees, source: gravity.length > 0 ? 'gravity' : 'accelFallback' }
  }

  return {
    samples,
    trackPoints,
    bounds,
    trackSpeeds,
    trackCts,
    speedBounds,
    positionAt: (cts: number) => positionAt(samples, trackPoints, cts),
    hasPositionAt,
    speedAt: (cts: number, smoothingMs = DEFAULT_SPEED_SMOOTHING_MS) =>
      hasPositionAt(cts) ? gaussianSmoothedValueAt(samples, cts, Math.max(MIN_SMOOTHING_MS, smoothingMs), (s) => s.speed2D) : 0,
    hasImuData: accel.length > 0,
    defaultAxisCalibration,
    gForceAt,
    gForceHistoryAt,
    rollAngleAt,
    sessionStatsAt,
    elevationProfile,
    elevationAt,
    distanceAt,
    headingAt
  }
}
