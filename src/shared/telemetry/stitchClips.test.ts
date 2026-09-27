import { describe, expect, it } from 'vitest'
import type { TelemetryData, TelemetrySample } from '../types'
import { stitchClipTelemetry } from './stitchClips'

function makeSample(cts: number): TelemetrySample {
  return { cts, lat: 45, lon: -73, altitude: 100, speed2D: 10, speed3D: 10 }
}

function makeTelemetry(ctsValues: number[], overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    deviceName: 'Hero11 Black',
    gpsStream: 'GPS5',
    samples: ctsValues.map(makeSample),
    videoDurationMs: ctsValues.length ? ctsValues[ctsValues.length - 1] : 0,
    accel: [],
    gyro: [],
    gravity: [],
    ...overrides
  }
}

describe('stitchClipTelemetry', () => {
  it('offsets each subsequent clip\'s samples by the cumulative duration of preceding clips', () => {
    const clip1 = makeTelemetry([0, 1000, 2000]) // clip-local cts, 0..2000
    const clip2 = makeTelemetry([0, 1000, 1900]) // clip-local cts, 0..1900

    const stitched = stitchClipTelemetry([
      { telemetry: clip1, durationMs: 5000 }, // note: durationMs (video length) can differ from the last sample's own cts
      { telemetry: clip2, durationMs: 4000 }
    ])

    expect(stitched.samples.map((s) => s.cts)).toEqual([0, 1000, 2000, 5000, 6000, 6900])
  })

  it('sets videoDurationMs to the sum of every clip\'s own durationMs, not the telemetry\'s own field', () => {
    const clip1 = makeTelemetry([0, 4900], { videoDurationMs: 4900 })
    const clip2 = makeTelemetry([0, 3900], { videoDurationMs: 3900 })
    const stitched = stitchClipTelemetry([
      { telemetry: clip1, durationMs: 5000 },
      { telemetry: clip2, durationMs: 4000 }
    ])
    expect(stitched.videoDurationMs).toBe(9000)
  })

  it('takes deviceName/gpsStream from the first clip', () => {
    const clip1 = makeTelemetry([0], { deviceName: 'Hero11 Black', gpsStream: 'GPS9' })
    const clip2 = makeTelemetry([0], { deviceName: 'Hero9 Black', gpsStream: 'GPS5' })
    const stitched = stitchClipTelemetry([
      { telemetry: clip1, durationMs: 1000 },
      { telemetry: clip2, durationMs: 1000 }
    ])
    expect(stitched.deviceName).toBe('Hero11 Black')
    expect(stitched.gpsStream).toBe('GPS9')
  })

  it('prefers deviceName/gpsStream from the first clip that actually has GPS samples', () => {
    // The first chapter of a recording often has no GPS fix yet -- normalizeGpsTelemetry reports
    // that as a placeholder deviceName with zero samples rather than throwing (see normalize.ts).
    const noFixClip = makeTelemetry([], { deviceName: 'No GPS fix', gpsStream: 'GPS5' })
    const clip2 = makeTelemetry([0], { deviceName: 'Hero11 Black', gpsStream: 'GPS9' })
    const stitched = stitchClipTelemetry([
      { telemetry: noFixClip, durationMs: 1000 },
      { telemetry: clip2, durationMs: 1000 }
    ])
    expect(stitched.deviceName).toBe('Hero11 Black')
    expect(stitched.gpsStream).toBe('GPS9')
  })

  it('handles a single clip (offset 0, unchanged samples)', () => {
    const clip1 = makeTelemetry([0, 500, 1000])
    const stitched = stitchClipTelemetry([{ telemetry: clip1, durationMs: 1000 }])
    expect(stitched.samples.map((s) => s.cts)).toEqual([0, 500, 1000])
    expect(stitched.videoDurationMs).toBe(1000)
  })

  it('handles zero clips without throwing', () => {
    const stitched = stitchClipTelemetry([])
    expect(stitched.samples).toEqual([])
    expect(stitched.videoDurationMs).toBe(0)
    expect(stitched.accel).toEqual([])
  })

  it('offsets IMU (accel/gyro/gravity) samples the same way as GPS samples, independently of GPS sample rate/count', () => {
    const clip1 = makeTelemetry([0, 1000], {
      accel: [{ cts: 0, x: 1, y: 2, z: 9.8 }, { cts: 500, x: 1.1, y: 2.1, z: 9.7 }],
      gyro: [{ cts: 0, x: 0.01, y: 0, z: 0 }],
      gravity: [{ cts: 0, x: 0, y: 0, z: 1 }]
    })
    const clip2 = makeTelemetry([0, 1000], {
      accel: [{ cts: 0, x: 2, y: 3, z: 9.6 }],
      gyro: [],
      gravity: [{ cts: 0, x: 0.01, y: 0, z: 0.99 }]
    })
    const stitched = stitchClipTelemetry([
      { telemetry: clip1, durationMs: 5000 },
      { telemetry: clip2, durationMs: 4000 }
    ])
    expect(stitched.accel.map((s) => s.cts)).toEqual([0, 500, 5000])
    expect(stitched.accel[2]).toEqual({ cts: 5000, x: 2, y: 3, z: 9.6 })
    expect(stitched.gyro.map((s) => s.cts)).toEqual([0])
    expect(stitched.gravity.map((s) => s.cts)).toEqual([0, 5000])
  })

  it('preserves every other sample field unchanged, only cts is offset', () => {
    const clip1 = makeTelemetry([0])
    const clip2: TelemetryData = {
      ...makeTelemetry([0]),
      samples: [{ cts: 0, lat: 51.5, lon: -0.1, altitude: 42, speed2D: 7.5, speed3D: 8 }]
    }
    const stitched = stitchClipTelemetry([
      { telemetry: clip1, durationMs: 1000 },
      { telemetry: clip2, durationMs: 1000 }
    ])
    expect(stitched.samples[1]).toEqual({ cts: 1000, lat: 51.5, lon: -0.1, altitude: 42, speed2D: 7.5, speed3D: 8 })
  })
})
