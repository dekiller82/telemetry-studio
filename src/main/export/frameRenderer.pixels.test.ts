import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it, vi } from 'vitest'
import type { TelemetryData } from '../../shared/types'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import type { Canvas2DLike } from '../../shared/render/canvas2d'
import { drawWidget } from '../../shared/render/drawWidget'
import { createWidget } from '../../shared/widgets/defaults'
import { createFrameRenderer } from './frameRenderer'

vi.mock('./registerFonts', () => ({ registerExportFonts: vi.fn() }))

const width = 640
const height = 360
const telemetry: TelemetryData = {
  deviceName: 'pixel-regression', gpsStream: 'GPS5', videoDurationMs: 20000,
  accel: [], gyro: [], gravity: [],
  samples: Array.from({ length: 201 }, (_, i) => ({
    cts: i * 100, lat: 30, lon: 106 + (i * 5) / (111195 * Math.cos(Math.PI / 6)),
    altitude: 300, speed2D: 50, speed3D: 50
  }))
}

describe('GPS window export pixels', () => {
  it.each(['solid', 'speed', 'braking'] as const)('matches the full drawing and ignores empty widgets in %s mode', async (colorMode) => {
    const sampler = createTelemetrySampler(telemetry)
    const gps = createWidget('gpsTrack')
    if (gps.type !== 'gpsTrack') throw new Error('expected GPS track')
    Object.assign(gps, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    Object.assign(gps.style, { viewMode: 'window', windowRadiusM: 25, dotGlow: false, colorMode })
    const emptyWidgets = [0, 0.95].map((position) => {
      const widget = createWidget('customText')
      if (widget.type !== 'customText') throw new Error('expected text')
      Object.assign(widget, { x: position, y: position, w: 0.05, h: 0.05 })
      Object.assign(widget.style, { text: '', backgroundOpacity: 0 })
      return widget
    })

    const renderer = await createFrameRenderer(width, height, [gps], sampler, null, 15, {}, {}, 20000, 0, 'Arial')
    const expanded = await createFrameRenderer(width, height, [gps, ...emptyWidgets], sampler, null, 15, {}, {}, 20000, 0, 'Arial')
    expect(renderer.roi).toEqual({ x: 0, y: 0, width, height })
    const reference = createCanvas(width, height)
    const ctx = reference.getContext('2d')

    for (const cts of [0, 10000, 20000]) {
      ctx.clearRect(0, 0, width, height)
      drawWidget(ctx as unknown as Canvas2DLike, gps, { x: gps.x * width, y: gps.y * height, w: gps.w * width, h: gps.h * height }, {
        trackPoints: sampler.trackPoints, bounds: sampler.bounds, dotPosition: sampler.positionAt(cts),
        hasGpsPosition: sampler.hasPositionAt(cts), speedMps: sampler.speedAt(cts), elapsedMs: cts, cts,
        trackSpeeds: sampler.trackSpeeds, trackCts: sampler.trackCts, speedBounds: sampler.speedBounds,
        trimStartMs: 0, sessionEndMs: 20000, projectFontFamily: 'Arial'
      })
      const pixels = renderer.renderFrame(cts, cts)
      expect(pixels.equals(Buffer.from(reference.data()))).toBe(true)
      expect(expanded.renderFrame(cts, cts).equals(pixels)).toBe(true)
    }
  })
})

describe('static export layer pixels', () => {
  it.each([
    ['speedometerAnalog', false], ['speedometerDigital', false], ['gForceDiagram', false], ['gForceDiagram', true]
  ] as const)('preserves fractional geometry and rotation for %s with IMU=%s', async (type, withImu) => {
    const sampler = createTelemetrySampler({
      ...telemetry,
      accel: withImu ? telemetry.samples.map(({ cts }) => ({ cts, x: 9.81, y: 0.3, z: 0.4 })) : []
    })
    for (const rotation of [0, 17]) {
      const widget = createWidget(type)
      Object.assign(widget, { x: 0.301, y: 0.203, w: 0.307, h: 0.409, rotation })
      const renderer = await createFrameRenderer(width, height, [widget], sampler, null, 15, {}, {}, 20000, 0, 'Arial')
      const reference = createCanvas(renderer.roi.width, renderer.roi.height)
      const ctx = reference.getContext('2d')
      ctx.translate(-renderer.roi.x, -renderer.roi.y)
      drawWidget(ctx as unknown as Canvas2DLike, widget,
        { x: widget.x * width, y: widget.y * height, w: widget.w * width, h: widget.h * height }, {
          trackPoints: sampler.trackPoints, bounds: sampler.bounds, dotPosition: sampler.positionAt(10000),
          hasGpsPosition: sampler.hasPositionAt(10000), speedMps: sampler.speedAt(10000), elapsedMs: 10000, cts: 10000,
          hasImuData: sampler.hasImuData,
          gForceReading: widget.type === 'gForceDiagram' ? sampler.gForceAt(10000, widget.style.smoothingMs) : undefined,
          gForceHistory: widget.type === 'gForceDiagram' ? sampler.gForceHistoryAt(10000, widget.style.trailDurationMs) : [],
          projectFontFamily: 'Arial'
        })
      const actual = renderer.renderFrame(10000, 10000)
      const expected = Buffer.from(reference.data())
      let maximumDifference = 0
      for (let i = 0; i < actual.length; i++) maximumDifference = Math.max(maximumDifference, Math.abs(actual[i] - expected[i]))
      expect(maximumDifference, `rotation=${rotation}`).toBeLessThanOrEqual(2)
    }
  })
})
