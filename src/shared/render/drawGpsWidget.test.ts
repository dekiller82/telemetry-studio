import { describe, expect, it, vi } from 'vitest'
import type { Canvas2DLike } from './canvas2d'
import { DEFAULT_GPS_STYLE, drawGpsWidget, effectiveGpsBounds } from './drawGpsWidget'

const FULL_TRACK_BOUNDS = { minX: -500, maxX: 500, minY: -300, maxY: 300 }
const DOT_POSITION = { x: 120, y: -40 }

describe('effectiveGpsBounds', () => {
  it("'full' mode (default) returns the track's own bounds unchanged", () => {
    const style = { ...DEFAULT_GPS_STYLE, viewMode: 'full' as const }
    expect(effectiveGpsBounds(style, FULL_TRACK_BOUNDS, DOT_POSITION)).toEqual(FULL_TRACK_BOUNDS)
  })

  it("'window' mode returns a square centered on the current position, sized by windowRadiusM", () => {
    const style = { ...DEFAULT_GPS_STYLE, viewMode: 'window' as const, windowRadiusM: 25 }
    const bounds = effectiveGpsBounds(style, FULL_TRACK_BOUNDS, DOT_POSITION)
    expect(bounds).toEqual({ minX: 95, maxX: 145, minY: -65, maxY: -15 })
    // Genuinely a square (equal spans), not derived from the track's own (different) aspect ratio.
    expect(bounds.maxX - bounds.minX).toBe(bounds.maxY - bounds.minY)
  })

  it("'window' mode ignores the track's own bounds entirely -- only depends on the current position", () => {
    const style = { ...DEFAULT_GPS_STYLE, viewMode: 'window' as const, windowRadiusM: 10 }
    const withOneTrack = effectiveGpsBounds(style, FULL_TRACK_BOUNDS, DOT_POSITION)
    const withADifferentTrack = effectiveGpsBounds(style, { minX: -5000, maxX: 5000, minY: -5000, maxY: 5000 }, DOT_POSITION)
    expect(withOneTrack).toEqual(withADifferentTrack)
  })

  it('a larger windowRadiusM produces a proportionally larger window', () => {
    const narrow = effectiveGpsBounds({ ...DEFAULT_GPS_STYLE, viewMode: 'window', windowRadiusM: 10 }, FULL_TRACK_BOUNDS, DOT_POSITION)
    const wide = effectiveGpsBounds({ ...DEFAULT_GPS_STYLE, viewMode: 'window', windowRadiusM: 50 }, FULL_TRACK_BOUNDS, DOT_POSITION)
    expect(wide.maxX - wide.minX).toBe(5 * (narrow.maxX - narrow.minX))
  })
})

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
    stroke: noop,
    fill: noop,
    clearRect: noop,
    fillRect: noop,
    drawImage: noop,
    fillText: noop,
    strokeText: noop,
    measureText: () => ({ width: 0 }),
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

describe('drawGpsWidget live position', () => {
  const baseOptions = {
    rect: { x: 0, y: 0, w: 400, h: 400 },
    trackPoints: [
      { x: 0, y: 0 },
      { x: 10, y: 10 }
    ],
    dotPosition: { x: 5, y: 5 },
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    style: DEFAULT_GPS_STYLE
  }

  it('draws the current-position dot by default', () => {
    const ctx = mockCanvas()
    drawGpsWidget(ctx, baseOptions)
    expect(ctx.arc).toHaveBeenCalledTimes(1)
  })

  it('keeps the track but omits the dot when the current frame has no trustworthy GPS', () => {
    const ctx = mockCanvas()
    drawGpsWidget(ctx, { ...baseOptions, showDot: false })
    expect(ctx.arc).not.toHaveBeenCalled()
  })
})
