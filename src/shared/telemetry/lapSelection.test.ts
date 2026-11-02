import { describe, expect, it } from 'vitest'
import type { DetectedCrossing } from './laps'
import { fastestLapRange, getLapStateAt, lapTimesFromCrossings } from './laps'
import { excludedLapNumbers, lapExclusionKey, selectableLaps } from './lapSelection'

const detailed: DetectedCrossing[] = [1_000, 61_000, 111_000, 181_000].map((cts, rawIndex) =>
  ({ cts, rawCts: cts, rawIndex, ignored: false }))
const decision = { [lapExclusionKey(61_000, 111_000)]: true }

describe('manual lap eligibility', () => {
  it('excludes a result without deleting crossings or renumbering later laps', () => {
    const excluded = excludedLapNumbers(detailed, decision)
    const crossings = detailed.map((c) => c.cts)
    expect([...excluded]).toEqual([2])
    expect(selectableLaps(detailed, decision).map((l) => l.lapNumber)).toEqual([1, 2, 3])
    expect(lapTimesFromCrossings(crossings, undefined, excluded)).toEqual([60_000, null, 70_000])
    expect(fastestLapRange(crossings, undefined, excluded)?.lapNumber).toBe(1)
    const state = getLapStateAt(crossings, 181_000, undefined, excluded)
    expect(state.lapNumber).toBe(4)
    expect(state.history.map((l) => l.lapNumber)).toEqual([3, 1])
    expect(state.bestLapMs).toBe(60_000)
  })

  it('keeps an excluded current lap clock and GPS validity separate from its results decision', () => {
    const excluded = excludedLapNumbers(detailed, decision)
    const state = getLapStateAt(detailed.map((c) => c.cts), 80_000, undefined, excluded)
    expect(state.currentLapExcluded).toBe(true)
    expect(state.currentLapValid).toBe(true)
    expect(state.currentLapElapsedMs).toBe(19_000)
    expect(state.bestLapMs).toBe(60_000)
    expect(getLapStateAt(detailed.map((c) => c.cts), 111_000, undefined, excluded).isNewBest).toBe(false)
  })

  it('restores a lap when unchecked exclusions are removed, with no future best-lap leak', () => {
    expect([...excludedLapNumbers(detailed, {})]).toEqual([])
    expect(fastestLapRange(detailed.map((c) => c.cts))?.lapNumber).toBe(2)
    expect(getLapStateAt(detailed.map((c) => c.cts), 80_000).bestLapMs).toBe(60_000)
  })

  it('preserves manual decisions across frame nudges and raw-index shifts', () => {
    const nudged = detailed.map((c) => ({ ...c, cts: c.cts + (c.rawIndex === 1 ? 40 : 0), rawIndex: c.rawIndex + 1 }))
    expect([...excludedLapNumbers(nudged, decision)]).toEqual([2])
    expect(selectableLaps(nudged, decision)[1].startCts).toBe(61_040)
  })

  it('does not transfer an exclusion to a merged interval when either crossing is removed', () => {
    for (const ignoredIndex of [1, 2]) {
      const removed = detailed.map((c) => ({ ...c, ignored: c.rawIndex === ignoredIndex }))
      expect([...excludedLapNumbers(removed, decision)]).toEqual([])
    }
    expect([...excludedLapNumbers(detailed, decision)]).toEqual([2])
  })

  it('does not transfer exclusions after GPS cleanup changes an interval endpoint', () => {
    const cleaned = detailed.map((c) => c.rawIndex === 2 ? { ...c, cts: 111_050, rawCts: 111_050 } : c)
    expect([...excludedLapNumbers(cleaned, decision)]).toEqual([])
  })

  it('keeps no eligible best lap when every completed lap is manually excluded', () => {
    const excluded = new Set([1, 2, 3])
    const crossings = detailed.map((c) => c.cts)
    expect(fastestLapRange(crossings, undefined, excluded)).toBeNull()
    expect(getLapStateAt(crossings, 182_000, undefined, excluded).history).toEqual([])
    expect(crossings).toEqual([1_000, 61_000, 111_000, 181_000])
  })
})
