import { describe, expect, it, vi } from 'vitest'
import type { Canvas2DLike } from './canvas2d'
import { drawWidget, type WidgetDrawContext } from './drawWidget'
import { createWidget } from '../widgets/defaults'

function mockCanvas(): Canvas2DLike {
  const noop = (): void => undefined
  return {
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    clearRect: noop,
    fillRect: vi.fn(),
    drawImage: noop,
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: () => ({ width: 20 }),
    translate: noop,
    rotate: noop,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    shadowBlur: 0,
    shadowColor: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: ''
  }
}

function drawContext(hasGpsPosition: boolean): WidgetDrawContext {
  return {
    trackPoints: [
      { x: 0, y: 0 },
      { x: 10, y: 10 }
    ],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    dotPosition: { x: 5, y: 5 },
    hasGpsPosition,
    speedMps: 20,
    elapsedMs: 0,
    cts: 0,
    elevationReading: 100,
    elevationProfile: [
      { cts: 0, distanceM: 0, altitude: 100 },
      { cts: 1_000, distanceM: 20, altitude: 101 }
    ],
    distanceReading: 20,
    headingReading: 45
  }
}

function expectNoContentDrawn(ctx: Canvas2DLike): void {
  expect(ctx.arc).not.toHaveBeenCalled()
  expect(ctx.stroke).not.toHaveBeenCalled()
  expect(ctx.fill).not.toHaveBeenCalled()
  expect(ctx.fillRect).not.toHaveBeenCalled()
  expect(ctx.fillText).not.toHaveBeenCalled()
  expect(ctx.strokeText).not.toHaveBeenCalled()
}

describe('drawWidget GPS availability', () => {
  it.each(['speedometerAnalog', 'speedometerDigital', 'elevation', 'distance', 'compass'] as const)(
    'hides %s while the current frame has no trustworthy GPS position',
    (type) => {
      const ctx = mockCanvas()
      drawWidget(ctx, createWidget(type), { x: 0, y: 0, w: 400, h: 400 }, drawContext(false))
      expectNoContentDrawn(ctx)
    }
  )

  it('keeps the static GPS track visible but hides its live dot', () => {
    const ctx = mockCanvas()
    drawWidget(ctx, createWidget('gpsTrack'), { x: 0, y: 0, w: 400, h: 400 }, drawContext(false))
    expect(ctx.stroke).toHaveBeenCalled()
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('draws live GPS readouts when the current frame is trustworthy', () => {
    const ctx = mockCanvas()
    drawWidget(ctx, createWidget('speedometerDigital'), { x: 0, y: 0, w: 400, h: 400 }, drawContext(true))
    expect(ctx.fillText).toHaveBeenCalled()
  })
})
