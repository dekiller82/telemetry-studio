import { describe, expect, it } from 'vitest'
import type { TelemetryData, TelemetrySample, VideoMeta } from '../../shared/types'
import { buildImportResult, type ProbedClip } from './clipImport'

function makeVideo(fileName: string, durationMs: number, overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    path: `C:\\Gopro\\${fileName}`,
    fileName,
    durationMs,
    fps: 29.97,
    width: 1920,
    height: 1080,
    codec: 'h264',
    pixFmt: 'yuv420p',
    hasAudio: true,
    lrvPath: null,
    ...overrides
  }
}

function makeSample(cts: number): TelemetrySample {
  return { cts, lat: 45, lon: -73, altitude: 100, speed2D: 10, speed3D: 10 }
}

function makeTelemetry(ctsValues: number[], overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    deviceName: ctsValues.length ? 'Hero11 Black' : 'No GPS fix',
    gpsStream: 'GPS5',
    samples: ctsValues.map(makeSample),
    videoDurationMs: ctsValues.length ? ctsValues[ctsValues.length - 1] : 0,
    accel: [],
    gyro: [],
    gravity: [],
    ...overrides
  }
}

describe('buildImportResult', () => {
  // The first chapter of a multi-chapter recording commonly has no GPS fix yet (the module hadn't
  // locked when recording started) -- that alone must not reject an otherwise-good import.
  it('succeeds when only the first clip has no usable GPS but later clips do', () => {
    const noFixClip: ProbedClip = { video: makeVideo('GH010253.MP4', 60000), telemetry: makeTelemetry([]) }
    const goodClip1: ProbedClip = { video: makeVideo('GH020253.MP4', 60000), telemetry: makeTelemetry([0, 1000]) }
    const goodClip2: ProbedClip = { video: makeVideo('GH030253.MP4', 60000), telemetry: makeTelemetry([0, 1000]) }

    const result = buildImportResult([noFixClip, goodClip1, goodClip2])

    expect(result.clips).toHaveLength(3)
    expect(result.telemetry.samples.map((s) => s.cts)).toEqual([60000, 61000, 120000, 121000])
  })

  it('still throws when NO clip in the whole selection has usable GPS', () => {
    const noFixClip1: ProbedClip = { video: makeVideo('GH010253.MP4', 60000), telemetry: makeTelemetry([]) }
    const noFixClip2: ProbedClip = { video: makeVideo('GH020253.MP4', 60000), telemetry: makeTelemetry([]) }

    expect(() => buildImportResult([noFixClip1, noFixClip2])).toThrow(/No usable GPS telemetry found/)
  })

  it('succeeds normally when every clip has usable GPS', () => {
    const clip: ProbedClip = { video: makeVideo('GH010253.MP4', 60000), telemetry: makeTelemetry([0, 1000]) }
    const result = buildImportResult([clip])
    expect(result.telemetry.samples).toHaveLength(2)
  })
})
