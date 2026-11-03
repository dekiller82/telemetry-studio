import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { drawSectorTimer, DEFAULT_SECTOR_TIMER_STYLE } from './drawSectorTimer'
import { getSectorStateAt, type SectorBoundary } from '../telemetry/sectors'
import type { Canvas2DLike } from './canvas2d'

GlobalFonts.registerFromPath(join(process.cwd(), 'src/renderer/src/fonts/Formula1-Bold.otf'), 'Formula1 Bold')
const boundaries: SectorBoundary[] = [
  { lapNumber: 1, isOutLap: false, lapStartCts: 0, s1Cts: 10000, s2Cts: 20000, lapEndCts: 30000 },
  { lapNumber: 2, isOutLap: false, lapStartCts: 30000, s1Cts: 39000, s2Cts: 50000, lapEndCts: 59000 }
]

function render(cts: number, width = 1000, height = 352): Buffer {
  const canvas = createCanvas(width, height)
  drawSectorTimer(canvas.getContext('2d') as unknown as Canvas2DLike, {
    rect: { x: 0, y: 0, w: width, h: height },
    style: { ...DEFAULT_SECTOR_TIMER_STYLE, layout: 'broadcast', driverName: 'HAN' },
    sectorState: getSectorStateAt(boundaries, cts, [0, 30000, 59000]), fontFamily: 'formula1'
  })
  return Buffer.from(canvas.data())
}

describe('broadcast card drawing', () => {
  it('keeps its solid panel opaque at fractional scales without strip seams', () => {
    const pixels = render(40000, 397, 141)
    for (let y = 1; y < 139; y++) {
      expect(pixels[(y * 397 + 3) * 4 + 3]).toBe(255)
    }
  })
  it('draws identical pixels when revisiting a timestamp after other frames', () => {
    const original = render(39200)
    render(61000); render(1000); render(53000)
    expect(render(39200).equals(original)).toBe(true)
    expect(render(40000).equals(original)).toBe(false)
  })
  it('keeps a fixed card aspect inside a tall component and leaves the outside transparent', () => {
    const pixels = render(40000, 400, 400)
    const alpha = (x: number, y: number): number => pixels[(y * 400 + x) * 4 + 3]
    expect(alpha(0, 0)).toBe(0)
    expect(alpha(0, 399)).toBe(0)
    expect(alpha(200, 200)).toBe(255)
  })
  it('clips the moving time to its timing band instead of painting over the header or sector row', () => {
    const moving = render(39150), held = render(40000)
    // The header and coloured bottom bars don't move with the clock. The active sector's label
    // intentionally changes from S1 to SECTOR 1 during result entrance.
    expect(moving.subarray(0, 1000 * 119 * 4).equals(held.subarray(0, 1000 * 119 * 4))).toBe(true)
    expect(moving.subarray(1000 * 336 * 4).equals(held.subarray(1000 * 336 * 4))).toBe(true)
  })
})
