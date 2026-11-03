import { describe, expect, it } from 'vitest'
import type { LatLon, TelemetrySample } from '../types'
import { getBroadcastTimingFrame } from './broadcastSectors'
import { computeTrackTiming, getTrackDeltaStateAt, getTrackSectorStateAt, getTrackSectorSummaryAt } from './trackTiming'

function point(fraction: number, radius = 80): LatLon {
  return { lat: 30 + radius * Math.sin(fraction * 2 * Math.PI) / 111195,
    lon: 106 + radius * Math.cos(fraction * 2 * Math.PI) / (111195 * Math.cos(Math.PI / 6)) }
}
function circle(start: number, duration = 60_000, radius = 80): TelemetrySample[] {
  return Array.from({ length: 241 }, (_, i) => ({ ...point(i / 240, radius), cts: start + i * duration / 240,
    altitude: 0, speed2D: 2 * Math.PI * radius / (duration / 1000), speed3D: 10 }))
}
function sequence(...laps: TelemetrySample[][]): TelemetrySample[] {
  return laps.flatMap((lap, index) => index ? lap.slice(1) : lap)
}
const samples = sequence(circle(0), circle(60_000, 66_000), circle(126_000, 54_000), circle(180_000))
const crossings = [0, 60_000, 126_000, 180_000, 240_000]

describe('shared fixed-position track timing', () => {
  it('uses one circuit and fixed S1/S2 locations even when later laps are faster', () => {
    const model = computeTrackTiming(samples, crossings)
    expect(model.error).toBeNull()
    expect(model.referenceLapNumber).toBe(1)
    expect(model.curves).toHaveLength(4)
    expect(new Set(model.curves.map((c) => c.totalDistanceM)).size).toBe(1)
    expect(model.laps[0].s1).toBeCloseTo(20_000, -1)
    expect(model.laps[1].s1! - 60_000).toBeCloseTo(22_000, -1)
  })

  it('sector cumulative delta equals live delta at BOTH fixed gates on every later lap', () => {
    const model = computeTrackTiming(samples, crossings)
    for (const lap of model.laps.slice(1)) {
      for (const at of [lap.s1!, lap.s2!]) {
        const sector = getTrackSectorStateAt(model, at + 1e-7)!
        const card = getBroadcastTimingFrame(sector.broadcast!, 5, 3)
        const live = getTrackDeltaStateAt(model, at)
        expect(card.deltaMs).not.toBeNull()
        expect(card.deltaMs!).toBeCloseTo(live.deltaMs!, 4)
        expect(card.referenceMs).not.toBeNull()
        expect(live.predictedLapMs).toBeCloseTo(live.baselineLapMs! + live.deltaMs!, 5)
      }
    }
  })

  it('supports manual S1 and S2 locations in driving order and reuses them on every lap', () => {
    const model = computeTrackTiming(samples, crossings, { s1: point(0.25), s2: point(0.75) })
    expect(model.error).toBeNull()
    expect(model.gates!.s1.manual).toBe(true)
    expect(model.laps[0].s1).toBeCloseTo(15_000, -1)
    expect(model.laps[0].s2).toBeCloseTo(45_000, -1)
    expect(model.laps[1].s1! - 60_000).toBeCloseTo(16_500, -1)
    expect(model.laps[1].s2! - 60_000).toBeCloseTo(49_500, -1)
  })

  it.each([
    { s1: point(0.75), s2: point(0.25) },
    { s1: point(0.25), s2: point(0.25) },
    { s1: { lat: 31, lon: 106 }, s2: point(0.75) }
  ])('rejects reversed, duplicate or off-circuit markers without falling back to per-lap thirds', (settings) => {
    const model = computeTrackTiming(samples, crossings, settings)
    expect(model.error).not.toBeNull()
    expect(model.curves).toEqual([])
    expect(getTrackDeltaStateAt(model, 90_000).deltaMs).toBeNull()
  })

  it('does not require a future closing crossing to display partial-lap sectors or delta', () => {
    const partial = samples.filter((s) => s.cts <= 105_000)
    const model = computeTrackTiming(partial, [0, 60_000])
    expect(model.curves).toHaveLength(1)
    const state = getTrackSectorStateAt(model, 83_000)!
    expect(state.currentSector).toBe(2)
    expect(state.currentLapS1Ms).toBeCloseTo(22_000, -1)
    expect(getBroadcastTimingFrame(state.broadcast!, 5, 3).checkpoint).toBe(1)
    expect(getTrackDeltaStateAt(model, 83_000).deltaMs).not.toBeNull()
  })

  it('a 20-second stop only suggests manual review; a resumed full lap still counts by default', () => {
    const moving = circle(60_000)
    const parked = Array.from({ length: 80 }, (_, i) => ({ ...moving[120], cts: 90_250 + i * 250, speed2D: 0 }))
    const paused = [...moving.slice(0, 121), ...parked, ...moving.slice(121).map((s) => ({ ...s, cts: s.cts + 20_000 }))]
    const data = sequence(circle(0), paused, circle(140_000))
    const crosses = [0, 60_000, 140_000, 200_000]
    const model = computeTrackTiming(data, crosses)
    expect(model.laps[1].longStopAt).toBe(100_250)
    expect(model.laps[1].reason).toBeNull()
    expect(model.curves.map((c) => c.lapNumber)).toEqual([1, 2, 3])
    expect(getTrackDeltaStateAt(model, 110_000).deltaMs).not.toBeNull()
    expect(getTrackSectorStateAt(model, 110_000)).not.toBeNull()
    const manual = computeTrackTiming(data, crosses, undefined, new Set([2]))
    expect(manual.curves.map((c) => c.lapNumber)).toEqual([1, 3])
    expect(manual.gates).toEqual(model.gates)
    expect(getTrackDeltaStateAt(manual, 85_000).deltaMs).toBeNull()
    expect(getTrackSectorStateAt(manual, 85_000)?.currentLapExcluded).toBe(true)
    expect(getTrackSectorSummaryAt(manual, 150_000)?.lastLap?.lapNumber).toBe(1)
  })

  it('excludes the same lap from sector bests, broadcast reference, and live delta without moving fixed gates', () => {
    const model = computeTrackTiming(samples, crossings, undefined, new Set([3]))
    expect(model.gates).toEqual(computeTrackTiming(samples, crossings).gates)
    expect(model.curves.map((c) => c.lapNumber)).toEqual([1, 2, 4])
    expect(getTrackDeltaStateAt(model, 150_000).deltaMs).toBeNull()
    const excludedCard = getBroadcastTimingFrame(getTrackSectorStateAt(model, 144_001)!.broadcast!, 5, 3)
    expect(excludedCard.deltaMs).toBeNull()
    expect(excludedCard.resultMs).toBeNull()
    expect(excludedCard.colours).toEqual(['pending', 'pending', 'pending'])
    expect(getTrackSectorSummaryAt(model, 185_000)?.bestS1Ms).toBeCloseTo(20_000, -1)
    expect(getTrackDeltaStateAt(model, 205_000).baselineLapMs).toBe(60_000)
    const card = getBroadcastTimingFrame(getTrackSectorStateAt(model, model.laps[3].s1! + 1e-7)!.broadcast!, 5, 3)
    expect(card.referenceLap).toBe(1)
    expect(card.deltaMs!).toBeCloseTo(getTrackDeltaStateAt(model, model.laps[3].s1!).deltaMs!, 4)
    expect(getTrackDeltaStateAt(computeTrackTiming(samples, crossings), 205_000).baselineLapMs).toBe(54_000)
  })

  it('can exclude every result without moving the route or deleting crossings', () => {
    const model = computeTrackTiming(samples, crossings, undefined, new Set([1, 2, 3, 4]))
    expect(model.referenceLapNumber).toBe(1)
    expect(model.crossings).toEqual(crossings)
    expect(model.curves).toEqual([])
    expect(getTrackSectorSummaryAt(model, 235_000)?.bestS1Ms).toBeNull()
    expect(getTrackDeltaStateAt(model, 205_000).baselineLapMs).toBeNull()
  })

  it('never matches across a GPS gap or allows a gapped lap to become the baseline', () => {
    const gapped = samples.filter((s) => s.cts <= 88_000 || s.cts >= 95_000)
    const model = computeTrackTiming(gapped, crossings)
    expect(model.laps[1].reason).toBe('gps-gap')
    expect(getTrackDeltaStateAt(model, 92_000).deltaMs).toBeNull()
    expect(model.curves.some((c) => c.lapNumber === 2)).toBe(false)
  })

  it('keeps completed summaries finite when the recording ends after a GPS-invalid lap', () => {
    const gapped = samples.filter((s) => s.cts <= 200_000 || s.cts >= 210_000)
    const model = computeTrackTiming(gapped, crossings)
    expect(model.laps[3].reason).toBe('gps-gap')
    const summary = getTrackSectorSummaryAt(model, 240_000)!
    expect(summary.lastLap?.lapNumber).toBe(3)
    expect(summary.lastLap?.totalMs).toBe(54_000)
    for (const best of [summary.bestS1Ms, summary.bestS2Ms, summary.bestS3Ms]) {
      expect(Number.isFinite(best)).toBe(true)
      expect(best).toBeGreaterThan(0)
    }
  })
  it('drops fast sectors from an expired GPS-invalid final interval while preserving completed bests', () => {
    const data = sequence(circle(0), circle(60_000, 45_000))
      .filter(s => s.cts <= 83_000 || s.cts >= 90_000)
    const model = computeTrackTiming(data, [0, 60_000])
    expect(model.laps[1].reason).toBe('gps-gap')
    // Before the gap, the current partial lap's valid checkpoint is available.
    expect(getTrackSectorSummaryAt(model, 80_000)?.bestS1Ms).toBeCloseTo(15_000, -1)
    // After validity expires, only the earlier valid complete lap supplies recap bests.
    const summary = getTrackSectorSummaryAt(model, 94_000)!
    expect(summary.lastLap?.lapNumber).toBe(1)
    expect(summary.bestS1Ms).toBeCloseTo(20_000, -1)
    expect(summary.bestS2Ms).toBeCloseTo(20_000, -1)
    expect(summary.bestS3Ms).toBeCloseTo(20_000, -1)
    const fallback = getTrackSectorStateAt(model, 94_000)!
    expect(fallback.lastLap?.lapNumber).toBe(1)
    expect(fallback.currentSectorElapsedMs).toBe(34_000)
    expect(fallback.currentLapS1Ms).toBeNull()
    expect(fallback.currentLapS2Ms).toBeNull()
    expect(getTrackDeltaStateAt(model, 94_000).deltaMs).toBeNull()
    expect(getBroadcastTimingFrame(fallback.broadcast!, 5, 3)).toMatchObject({
      elapsedMs: 34_000, resultMs: null, colours: ['pending', 'pending', 'pending']
    })
  })

  it('geometry and current progress do not depend on the eventual length of the current lap', () => {
    const normal = computeTrackTiming(samples, crossings)
    const drifting = samples.map((s) => s.cts > 220_000 ? { ...s, lat: s.lat + 0.002 } : s)
    const other = computeTrackTiming(drifting, crossings)
    expect(other.gates).toEqual(normal.gates)
    expect(getTrackDeltaStateAt(other, 205_000)).toEqual(getTrackDeltaStateAt(normal, 205_000))
    expect(other.laps[3].s1).toBe(normal.laps[3].s1)
    expect(other.curves.some((c) => c.lapNumber === 4)).toBe(false)
  })

  it('uses a new fastest baseline only on subsequent laps, and is independent of lookup order', () => {
    const model = computeTrackTiming(samples, crossings)
    expect(getTrackDeltaStateAt(model, 150_000).baselineLapMs).toBe(60_000)
    const later = getTrackDeltaStateAt(model, 205_000)
    expect(later.baselineLapMs).toBe(54_000)
    getTrackDeltaStateAt(model, 75_000)
    expect(getTrackDeltaStateAt(model, 205_000)).toEqual(later)
  })

  it('handles missing GPS or a missing complete circuit without inventing sectors', () => {
    expect(computeTrackTiming([], []).gates).toBeNull()
    const model = computeTrackTiming(circle(0).slice(0, 100), [0])
    expect(model.error).not.toBeNull()
    expect(getTrackSectorStateAt(model, 10_000)?.currentLapS1Ms).toBeNull()
    expect(getTrackDeltaStateAt(model, 10_000).deltaMs).toBeNull()
  })
})
