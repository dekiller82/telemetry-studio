import { describe, expect, it } from 'vitest'
import { formatBroadcastDelta, formatBroadcastTime, getBroadcastTimingFrame } from './broadcastSectors'
import type { SectorBoundary } from './sectors'

const lap = (n: number, start: number, s1: number, s2: number, s3: number): SectorBoundary => ({
  lapNumber: n, isOutLap: n === 0, lapStartCts: start, s1Cts: start + s1,
  s2Cts: start + s1 + s2, lapEndCts: start + s1 + s2 + s3
})
const boundaries = [lap(0, 0, 1000, 1000, 1000), lap(1, 3000, 10000, 12000, 11000), lap(2, 36000, 9000, 12000, 10000), lap(3, 67000, 8000, 8000, 8000)]
const crossings = boundaries.map(b => b.lapEndCts)
const at = (cts: number, sector = 5, finish = 3) => getBroadcastTimingFrame({ cts, boundaries, crossings }, sector, finish)

describe('broadcast sector timeline', () => {
  it('does not use an out lap or any future completed lap as a reference', () => {
    expect(at(14000).referenceMs).toBeNull()
    expect(at(44000).referenceLap).toBe(1)
    expect(at(46000).referenceMs).toBe(10000)
    expect(at(46000).deltaMs).toBe(-1000)
  })
  it('keeps the old reference while showing a new fastest completed lap, then resets to the new reference', () => {
    expect(at(68000).referenceLap).toBe(1)
    expect(at(68000).resultMs).toBe(31000)
    expect(at(68000).elapsedMs).toBe(1000)
    expect(at(68000).deltaMs).toBe(-2000)
    expect(at(68000).referenceMix).toBe(1)
    expect(at(68000).finishTimeMix).toBe(0)
    expect(at(69000).finishTimeMix).toBe(1)
    expect(at(71000).referenceLap).toBe(2)
    expect(at(71000).resultMs).toBeNull()
  })
  it('supports separate configurable durations and zero without reviving an old result', () => {
    expect(at(49000, 5).resultMs).toBe(9000)
    expect(at(49000, 2).resultMs).toBeNull()
    expect(at(68000, 60, 0).resultMs).toBeNull()
    expect(at(72000, 60, 3).resultMs).toBeNull()
    expect(at(72000, 5, 10).resultMs).toBe(31000)
  })
  it('is identical after out-of-order evaluation (seek, trim and parallel workers)', () => {
    const expected = at(46321)
    at(90000); at(1000); at(60000)
    expect(at(46321)).toEqual(expected)
  })
  it('uses sector bests available at each crossing and leaves uncompleted sectors pending', () => {
    expect(at(14000).colours).toEqual(['white', 'pending', 'pending'])
    expect(at(46000).colours).toEqual(['purple', 'pending', 'pending'])
    const slower = [...boundaries, lap(4, 91000, 12000, 12000, 12000)]
    expect(getBroadcastTimingFrame({ cts: 104000, boundaries: slower, crossings }, 5, 3).colours[0]).toBe('yellow')
  })
  it('does not manufacture sector results for a GPS-invalid lap', () => {
    const invalid = getBroadcastTimingFrame({ cts: 46000, boundaries: boundaries.filter(b => b.lapNumber !== 2), crossings }, 5, 3)
    expect(invalid.resultMs).toBeNull()
    expect(invalid.colours).toEqual(['pending', 'pending', 'pending'])
    expect(invalid.elapsedMs).toBe(10000)
  })
  it('formats rollover and negative sub-millisecond differences without a negative zero', () => {
    expect(formatBroadcastTime(59999.6)).toBe('1:00.000')
    expect(formatBroadcastTime(59999.6, true)).toBe('0:59.9')
    expect(formatBroadcastDelta(-0.1)).toBe('+0.000')
    expect(formatBroadcastDelta(-1000)).toBe('-1.000')
  })
})
