import { describe, expect, it } from 'vitest'
import { computeOverlayRoi } from './overlayRoi'
import { createWidget } from '../../shared/widgets/defaults'

describe('computeOverlayRoi', () => {
  it('keeps a centered HUD smaller than the full frame with a conservative margin', () => {
    const widget = createWidget('speedometerDigital')
    widget.x = 0.4
    widget.y = 0.4
    widget.w = 0.2
    widget.h = 0.1

    const roi = computeOverlayRoi(1920, 1080, [widget])
    expect(roi.x).toBeGreaterThan(0)
    expect(roi.y).toBeGreaterThan(0)
    expect(roi.width).toBeLessThan(1920)
    expect(roi.height).toBeLessThan(1080)
    expect(roi.x % 2).toBe(0)
    expect(roi.y % 2).toBe(0)
    expect(roi.width % 2).toBe(0)
    expect(roi.height % 2).toBe(0)
  })

  it('includes rotated bounds and never leaves the frame', () => {
    const widget = createWidget('speedometerDigital')
    widget.x = 0.02
    widget.y = 0.02
    widget.w = 0.3
    widget.h = 0.2
    widget.rotation = 45

    const roi = computeOverlayRoi(1280, 720, [widget])
    expect(roi.x).toBe(0)
    expect(roi.y).toBe(0)
    expect(roi.x + roi.width).toBeLessThanOrEqual(1280)
    expect(roi.y + roi.height).toBeLessThanOrEqual(720)
  })

  it('falls back to the full frame for telemetry-positioned G-force content', () => {
    const widget = createWidget('gForceDiagram')
    widget.x = 0.4
    widget.y = 0.4
    widget.w = 0.2
    widget.h = 0.2

    expect(computeOverlayRoi(1920, 1080, [widget])).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('preserves the full drawing range of a zoomed GPS track', () => {
    const widget = createWidget('gpsTrack')
    if (widget.type !== 'gpsTrack') throw new Error('expected GPS track')
    Object.assign(widget, { x: 0.4, y: 0.3, w: 0.2, h: 0.4, rotation: 45 })
    widget.style.viewMode = 'window'
    expect(computeOverlayRoi(640, 360, [widget])).toEqual({ x: 0, y: 0, width: 640, height: 360 })
  })

  it('still crops a GPS overview with bounded track geometry', () => {
    const widget = createWidget('gpsTrack')
    if (widget.type !== 'gpsTrack') throw new Error('expected GPS track')
    widget.style.trimAware = false
    Object.assign(widget, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    const roi = computeOverlayRoi(640, 360, [widget])
    expect(roi.width).toBeLessThan(640)
    expect(roi.height).toBeLessThan(360)
  })

  it('preserves live dots interpolated outside the fixes retained by a trim-aware GPS overview', () => {
    const widget = createWidget('gpsTrack')
    if (widget.type !== 'gpsTrack') throw new Error('expected GPS track')
    Object.assign(widget, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    widget.style.trimAware = true
    expect(computeOverlayRoi(640, 360, [widget])).toEqual({ x: 0, y: 0, width: 640, height: 360 })
  })

  it('preserves enlarged custom images but still crops images contained by the widget', () => {
    const widget = createWidget('customText')
    if (widget.type !== 'customText') throw new Error('expected custom text')
    Object.assign(widget, { x: 800 / 1920, y: 500 / 1080, w: 300 / 1920, h: 100 / 1080 })
    widget.style.imageDataUrl = 'data:image/png;base64,test-image'
    widget.style.imageScale = 5
    expect(computeOverlayRoi(1920, 1080, [widget])).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    widget.style.imageScale = 1
    expect(computeOverlayRoi(1920, 1080, [widget]).height).toBeLessThan(1080)
    widget.style.imageDataUrl = null
    widget.style.imageScale = 5
    expect(computeOverlayRoi(1920, 1080, [widget]).height).toBeLessThan(1080)
  })

  it.each(['showGhost', 'showApexMarkers'] as const)('keeps full-session %s markers outside a cropped GPS overview', (option) => {
    const widget = createWidget('gpsTrack')
    if (widget.type !== 'gpsTrack') throw new Error('expected GPS track')
    Object.assign(widget, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    widget.style[option] = true
    expect(computeOverlayRoi(640, 360, [widget])).toEqual({ x: 0, y: 0, width: 640, height: 360 })
  })

  it('falls back to the full frame when widgets span opposing corners', () => {
    const first = createWidget('speedometerDigital')
    first.x = 0
    first.y = 0
    first.w = 0.12
    first.h = 0.12
    const second = createWidget('gpsTrack')
    second.x = 0.82
    second.y = 0.82
    second.w = 0.18
    second.h = 0.18

    const roi = computeOverlayRoi(1920, 1080, [first, second])
    expect(roi).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })
})
