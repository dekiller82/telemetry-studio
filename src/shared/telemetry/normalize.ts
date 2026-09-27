import type { ImuSample, TelemetryData, TelemetrySample } from '../types'

interface RawStream {
  samples?: { cts: number; value: number[] }[]
}

interface RawGpsStream {
  'device name': string
  streams?: Record<string, RawStream>
}

export type RawGoProTelemetry = Record<string | number, RawGpsStream>

export interface GpsTelemetryResult {
  deviceName: string
  gpsStream: 'GPS5' | 'GPS9'
  samples: TelemetrySample[]
  videoDurationMs: number
}

/**
 * gopro-telemetry with `stream: 'GPS'` yields either a GPS5 or GPS9 stream per
 * device. Both share the same first 5 value indices: lat, lon, alt, speed2D, speed3D.
 */
export function normalizeGpsTelemetry(raw: RawGoProTelemetry, videoDurationMs: number): GpsTelemetryResult {
  for (const key of Object.keys(raw)) {
    const device = raw[key]
    const streams = device.streams ?? {}
    const gpsStream = (streams.GPS9 ? 'GPS9' : streams.GPS5 ? 'GPS5' : null) as 'GPS5' | 'GPS9' | null
    if (!gpsStream) continue

    const rawSamples = streams[gpsStream]?.samples ?? []
    const samples: TelemetrySample[] = rawSamples
      .filter((s) => Array.isArray(s.value) && s.value.length >= 5)
      // Treat malformed numeric payloads and impossible geographic ranges as
      // unusable before they can poison projection, distance, heading, or lap
      // calculations downstream. GPS quality/motion filters run earlier in
      // gopro-telemetry; these are format-level safety checks.
      .filter((s) => s.value.slice(0, 5).every(Number.isFinite))
      .filter((s) => s.value[0] >= -90 && s.value[0] <= 90)
      .filter((s) => s.value[1] >= -180 && s.value[1] <= 180)
      // (0, 0) is GoPro's own convention for "no fix yet" (confirmed against a real clip that
      // never acquired a GPS lock -- every one of its samples came back exactly (0, 0), not just
      // near it). Null Island isn't a real recording location, so keeping these in would silently
      // collapse the whole track to a single degenerate point instead of surfacing a clear error.
      .filter((s) => s.value[0] !== 0 || s.value[1] !== 0)
      .map((s) => ({
        cts: s.cts,
        lat: s.value[0],
        lon: s.value[1],
        altitude: s.value[2],
        speed2D: s.value[3],
        speed3D: s.value[4]
      }))

    if (samples.length === 0) continue

    return {
      deviceName: device['device name'] ?? 'Unknown device',
      gpsStream,
      samples,
      videoDurationMs
    }
  }

  throw new Error(
    'No usable GPS telemetry found in this clip. Make sure GPS was enabled and had a signal lock while recording (indoor tracks or covered areas often have no GPS signal).'
  )
}

export interface ImuTelemetryResult {
  accel: ImuSample[]
  gyro: ImuSample[]
  gravity: ImuSample[]
}

// GoPro's native ACCL/GYRO rate is ~200Hz -- far more than any visual widget needs and would
// otherwise bloat the telemetry cache JSON for a long session. Time-based (not stride-based)
// decimation so it doesn't need to know or guess the native rate.
const MAX_IMU_SAMPLE_RATE_HZ = 25
const MIN_IMU_SAMPLE_GAP_MS = 1000 / MAX_IMU_SAMPLE_RATE_HZ

function decimateImuSamples(samples: ImuSample[]): ImuSample[] {
  if (samples.length === 0) return []
  const kept: ImuSample[] = [samples[0]]
  let lastKeptCts = samples[0].cts
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].cts - lastKeptCts >= MIN_IMU_SAMPLE_GAP_MS) {
      kept.push(samples[i])
      lastKeptCts = samples[i].cts
    }
  }
  return kept
}

function extractImuStream(stream: RawStream | undefined): ImuSample[] {
  const rawSamples = stream?.samples ?? []
  const samples: ImuSample[] = rawSamples
    .filter((s) => Array.isArray(s.value) && s.value.length >= 3)
    .map((s) => ({ cts: s.cts, x: s.value[0], y: s.value[1], z: s.value[2] }))
  return decimateImuSamples(samples)
}

/** A real gravity-vector sample is a unit vector (~1g on some axis) -- it can never genuinely read
 *  exactly {0,0,0}, not even once, for an entire session. Confirmed on a real HERO8 Black file: its
 *  GRAV stream is structurally present (right sample count, right cts spacing) but every single
 *  sample is exactly zero -- the metadata slot exists but isn't populated with real sensor-fusion
 *  output on this camera/firmware. Trusting that as "gravity available" would freeze the Roll/Lean
 *  widget at a permanent 0deg reading, and silently corrupt calibrateAxes's vertical-axis detection
 *  (which picks whichever axis has the largest mean magnitude -- meaningless when every axis is
 *  identically zero) for the G-Force widget too, since both share the same calibration. */
function isGravityDataUsable(samples: ImuSample[]): boolean {
  return samples.length > 0 && samples.some((s) => Math.abs(s.x) > 1e-6 || Math.abs(s.y) > 1e-6 || Math.abs(s.z) > 1e-6)
}

/**
 * Accelerometer (ACCL) and gyroscope (GYRO) are present on every GoPro model tested (Hero5/7/11);
 * the gravity vector (GRAV) only exists on newer cameras/firmware and is legitimately absent
 * otherwise -- callers must not assume it's there. Raw axis order is camera-body-relative and
 * inconsistent across camera models (confirmed by extracting real samples from all three test
 * fixtures during design -- Hero5/11 read as vertical/lateral/longitudinal at rest, Hero7 only
 * exposes generic "z,x,y" labels) -- axis semantics are resolved separately by
 * shared/telemetry/imuCalibration.ts, not here.
 */
export function normalizeImuTelemetry(raw: RawGoProTelemetry): ImuTelemetryResult {
  for (const key of Object.keys(raw)) {
    const device = raw[key]
    const streams = device.streams ?? {}
    const accel = extractImuStream(streams.ACCL)
    const gyro = extractImuStream(streams.GYRO)
    const rawGravity = extractImuStream(streams.GRAV)
    const gravity = isGravityDataUsable(rawGravity) ? rawGravity : []
    if (accel.length > 0 || gyro.length > 0 || gravity.length > 0) {
      return { accel, gyro, gravity }
    }
  }
  return { accel: [], gyro: [], gravity: [] }
}

/** Combines GPS + IMU normalization into the full TelemetryData shape parseGoProTelemetry returns. */
export function normalizeTelemetry(raw: RawGoProTelemetry, videoDurationMs: number): TelemetryData {
  const gps = normalizeGpsTelemetry(raw, videoDurationMs)
  const imu = normalizeImuTelemetry(raw)
  return { ...gps, ...imu }
}
