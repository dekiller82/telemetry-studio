import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it, vi } from 'vitest'
import type { TelemetryData } from '../../shared/types'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import type { Canvas2DLike } from '../../shared/render/canvas2d'
import { drawWidget } from '../../shared/render/drawWidget'
import { createWidget } from '../../shared/widgets/defaults'
import { createFrameRenderer } from './frameRenderer'
import { computeOverlayRoi } from './overlayRoi'

vi.mock('./registerFonts', () => ({ registerExportFonts: vi.fn() }))

const telemetry: TelemetryData = {
  deviceName: 'crop-boundary-regression', gpsStream: 'GPS5', videoDurationMs: 40000,
  accel: [], gyro: [], gravity: [],
  samples: Array.from({ length: 21 }, (_, i) => ({
    cts: i * 2000, lat: 30, lon: 106 + (i * 10) / (111195 * Math.cos(Math.PI / 6)),
    altitude: 300, speed2D: 10, speed3D: 10
  }))
}

describe('export content outside nominal widget bounds', () => {
  it.each([6100, 11900])('keeps the interpolated GPS dot at the trim boundary %s', async cts => {
    const width = 640, height = 360
    const sampler = createTelemetrySampler(telemetry)
    const gps = createWidget('gpsTrack')
    if (gps.type !== 'gpsTrack') throw new Error('expected GPS track')
    Object.assign(gps, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    Object.assign(gps.style, { trimAware: true, dotGlow: false, colorMode: 'solid', showGhost: false, showApexMarkers: false })
    const renderer = await createFrameRenderer(width, height, [gps], sampler, null, 15, {}, {}, 11900, 6100, 'Arial')
    const reference = createCanvas(width, height)
    drawWidget(reference.getContext('2d') as unknown as Canvas2DLike, gps,
      { x: gps.x * width, y: gps.y * height, w: gps.w * width, h: gps.h * height }, {
        trackPoints: sampler.trackPoints, bounds: sampler.bounds, dotPosition: sampler.positionAt(cts),
        hasGpsPosition: sampler.hasPositionAt(cts), speedMps: sampler.speedAt(cts), elapsedMs: cts - 6100, cts,
        trackSpeeds: sampler.trackSpeeds, trackCts: sampler.trackCts, speedBounds: sampler.speedBounds,
        trimStartMs: 6100, sessionEndMs: 11900, projectFontFamily: 'Arial'
      })
    const expected = Buffer.from(reference.data())
    const boxRoi = computeOverlayRoi(width, height, [{ ...gps, style: { ...gps.style, trimAware: false } }])
    let visibleOutsideBox = 0
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x < boxRoi.x || x >= boxRoi.x + boxRoi.width || y < boxRoi.y || y >= boxRoi.y + boxRoi.height) {
        if (expected[(y * width + x) * 4 + 3] > 0) visibleOutsideBox++
      }
    }
    expect(visibleOutsideBox).toBeGreaterThan(0)
    expect(renderer.roi).toEqual({ x: 0, y: 0, width, height })
    expect(renderer.renderFrame(cts, cts - 6100).equals(expected)).toBe(true)
  })

  it.each([0, 25])('preserves the entire enlarged custom image, rotation=%s', async rotation => {
    const width = 1920, height = 1080
    const sampler = createTelemetrySampler(telemetry)
    const image = createCanvas(32, 32)
    const imageCtx = image.getContext('2d')
    imageCtx.fillStyle = '#00aaff'
    imageCtx.fillRect(0, 0, 32, 32)
    const widget = createWidget('customText')
    if (widget.type !== 'customText') throw new Error('expected custom text')
    Object.assign(widget, { x: 800 / width, y: 500 / height, w: 300 / width, h: 100 / height, rotation })
    Object.assign(widget.style, { text: '', backgroundOpacity: 0, imageDataUrl: image.toDataURL('image/png'), imageScale: 5 })
    const decodedImage = await loadImage(widget.style.imageDataUrl!)
    const renderer = await createFrameRenderer(width, height, [widget], sampler, null, 15, {}, {}, 8000, 0, 'Arial')
    const reference = createCanvas(width, height)
    drawWidget(reference.getContext('2d') as unknown as Canvas2DLike, widget,
      { x: widget.x * width, y: widget.y * height, w: widget.w * width, h: widget.h * height }, {
      trackPoints: sampler.trackPoints, bounds: sampler.bounds, dotPosition: sampler.positionAt(2000),
      speedMps: sampler.speedAt(2000), elapsedMs: 2000, cts: 2000, headerImage: decodedImage, projectFontFamily: 'Arial'
    })
    const expected = Buffer.from(reference.data())
    // The square image is 270px tall after the width cap, extending beyond y=500..600.
    expect(expected[(430 * width + 950) * 4 + 3]).toBeGreaterThan(0)
    expect(expected[(670 * width + 950) * 4 + 3]).toBeGreaterThan(0)
    expect(renderer.roi).toEqual({ x: 0, y: 0, width, height })
    expect(renderer.renderFrame(2000, 2000).equals(expected)).toBe(true)
  })
})
