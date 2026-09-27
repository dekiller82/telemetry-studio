import { describe, expect, it } from 'vitest'
import { normalizeGpsTelemetry, normalizeImuTelemetry, type RawGoProTelemetry } from './normalize'

function rawWithImuStreams(streams: {
  ACCL?: { cts: number; value: number[] }[]
  GYRO?: { cts: number; value: number[] }[]
  GRAV?: { cts: number; value: number[] }[]
}): RawGoProTelemetry {
  const built: Record<string, { samples: { cts: number; value: number[] }[] }> = {}
  if (streams.ACCL) built.ACCL = { samples: streams.ACCL }
  if (streams.GYRO) built.GYRO = { samples: streams.GYRO }
  if (streams.GRAV) built.GRAV = { samples: streams.GRAV }
  return {
    1: {
      'device name': 'Test Camera',
      streams: built
    }
  }
}

describe('normalizeImuTelemetry', () => {
  it('keeps a real (non-zero) gravity stream', () => {
    const result = normalizeImuTelemetry(
      rawWithImuStreams({
        ACCL: [{ cts: 0, value: [9.8, 0.1, 0.2] }],
        GRAV: [
          { cts: 0, value: [0.98, 0.01, 0.02] },
          { cts: 100, value: [0.97, 0.02, 0.01] }
        ]
      })
    )
    expect(result.gravity).toHaveLength(2)
  })

  // Confirmed against a real HERO8 Black clip: gopro-telemetry returns a structurally valid GRAV
  // stream (right sample count, right cts spacing) but every single sample is exactly {0,0,0} --
  // the metadata slot exists on this camera/firmware but isn't populated with real sensor-fusion
  // output. Before this fix, that silently froze the Roll/Lean widget at a permanent 0deg reading
  // and corrupted calibrateAxes's vertical-axis detection for the G-Force widget too.
  it('treats an all-zero GRAV stream as absent, not real gravity data', () => {
    const result = normalizeImuTelemetry(
      rawWithImuStreams({
        ACCL: [{ cts: 0, value: [9.8, 0.1, 0.2] }],
        GRAV: [
          { cts: 0, value: [0, 0, 0] },
          { cts: 100, value: [0, 0, 0] },
          { cts: 200, value: [0, 0, 0] }
        ]
      })
    )
    expect(result.gravity).toEqual([])
    expect(result.accel).toHaveLength(1)
  })

  it('keeps gravity if only SOME samples are zero (a momentary sensor glitch, not a broken stream)', () => {
    const result = normalizeImuTelemetry(
      rawWithImuStreams({
        GRAV: [
          { cts: 0, value: [0, 0, 0] },
          { cts: 200, value: [0.98, 0.01, 0.02] },
          { cts: 400, value: [0.97, 0.02, 0.01] }
        ]
      })
    )
    expect(result.gravity).toHaveLength(3)
  })

  it('handles no IMU streams at all without throwing', () => {
    const result = normalizeImuTelemetry(rawWithImuStreams({}))
    expect(result).toEqual({ accel: [], gyro: [], gravity: [] })
  })
})

function rawWithGps5Samples(samples: { cts: number; value: number[] }[]): RawGoProTelemetry {
  return {
    1: {
      'device name': 'Test Camera',
      streams: { GPS5: { samples } }
    }
  }
}

describe('normalizeGpsTelemetry', () => {
  it('keeps real GPS fixes', () => {
    const result = normalizeGpsTelemetry(
      rawWithGps5Samples([
        { cts: 0, value: [51.5, -0.12, 35, 10, 10] },
        { cts: 1000, value: [51.5001, -0.1201, 35, 12, 12] }
      ]),
      2000
    )
    expect(result.samples).toHaveLength(2)
    expect(result.samples[0].lat).toBe(51.5)
  })

  // Confirmed against a real clip whose GPS module never acquired a lock for its entire ~4.8min
  // duration: gopro-telemetry still returns a structurally valid GPS5 stream, but every sample's
  // lat/lon is exactly (0, 0) -- GoPro's own convention for "no fix yet". Before this fix, that
  // silently produced a "successful" import with a degenerate single-point track instead of the
  // clear "no GPS" error this file already has for the totally-missing-stream case.
  it('throws a clear error when every sample is a (0, 0) no-fix reading', () => {
    expect(() =>
      normalizeGpsTelemetry(
        rawWithGps5Samples([
          { cts: 0, value: [0, 0, -17, 0, 0] },
          { cts: 1000, value: [0, 0, -17, 0, 0] },
          { cts: 2000, value: [0, 0, -17, 0, 0] }
        ]),
        3000
      )
    ).toThrow(/GPS/)
  })

  it('filters out only the no-fix samples when GPS lock is acquired partway through', () => {
    const result = normalizeGpsTelemetry(
      rawWithGps5Samples([
        { cts: 0, value: [0, 0, -17, 0, 0] },
        { cts: 1000, value: [0, 0, -17, 0, 0] },
        { cts: 2000, value: [51.5, -0.12, 35, 5, 5] },
        { cts: 3000, value: [51.5001, -0.1201, 35, 8, 8] }
      ]),
      4000
    )
    expect(result.samples).toHaveLength(2)
    expect(result.samples[0].cts).toBe(2000)
  })

  it('filters malformed numbers and impossible coordinate ranges before normalization', () => {
    const result = normalizeGpsTelemetry(
      rawWithGps5Samples([
        { cts: 0, value: [51.5, -0.12, 35, 10, 10] },
        { cts: 100, value: [Number.NaN, -0.12, 35, 10, 10] },
        { cts: 200, value: [51.5, Number.POSITIVE_INFINITY, 35, 10, 10] },
        { cts: 300, value: [91, -0.12, 35, 10, 10] },
        { cts: 400, value: [51.5, -181, 35, 10, 10] },
        { cts: 500, value: [51.5, -0.12, Number.NaN, 10, 10] },
        { cts: 600, value: [51.5001, -0.1201, 35, 12, 12] }
      ]),
      1000
    )

    expect(result.samples.map((sample) => sample.cts)).toEqual([0, 600])
  })

  it('falls through to a second device if the first has no usable GPS', () => {
    const raw: RawGoProTelemetry = {
      1: { 'device name': 'No fix', streams: { GPS5: { samples: [{ cts: 0, value: [0, 0, 0, 0, 0] }] } } },
      2: { 'device name': 'Good fix', streams: { GPS5: { samples: [{ cts: 0, value: [40, 10, 5, 1, 1] }] } } }
    }
    const result = normalizeGpsTelemetry(raw, 1000)
    expect(result.deviceName).toBe('Good fix')
  })

  it('throws when no GPS stream exists at all', () => {
    expect(() => normalizeGpsTelemetry({ 1: { 'device name': 'x', streams: {} } }, 1000)).toThrow(/GPS/)
  })
})
