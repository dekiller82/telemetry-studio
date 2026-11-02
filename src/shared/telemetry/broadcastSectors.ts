import type { SectorBoundary } from './sectors'

export type SectorColour = 'pending' | 'white' | 'purple' | 'green' | 'yellow'
export interface BroadcastTimingContext {
  cts: number
  boundaries: readonly SectorBoundary[]
  crossings: readonly number[]
}
export interface BroadcastTimingFrame {
  lapNumber: number
  elapsedMs: number
  checkpoint: 1 | 2 | 3
  completed: number
  colours: SectorColour[]
  referenceMs: number | null
  referenceLap: number | null
  resultMs: number | null
  deltaMs: number | null
  /** Opacity/vertical entrance of a result. Resolved from source time, never render order. */
  resultMix: number
  resultLeaving: boolean
  finishTimeMix: number
  referenceMix: number
  finished: boolean
}

const cumulative = (b: SectorBoundary): number[] =>
  [b.s1Cts - b.lapStartCts, b.s2Cts - b.lapStartCts, b.lapEndCts - b.lapStartCts]
const sectors = (b: SectorBoundary): number[] =>
  [b.s1Cts - b.lapStartCts, b.s2Cts - b.s1Cts, b.lapEndCts - b.s2Cts]
const checkpoints = (b: SectorBoundary): number[] => [b.s1Cts, b.s2Cts, b.lapEndCts]
const usable = (b: SectorBoundary): boolean =>
  !b.isOutLap && !b.excluded && b.complete !== false && [b.lapStartCts, b.s1Cts, b.s2Cts, b.lapEndCts].every(Number.isFinite) &&
  b.lapStartCts < b.s1Cts && b.s1Cts < b.s2Cts && b.s2Cts < b.lapEndCts
const smooth = (x: number): number => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }
const holdMs = (seconds: number): number => Number.isFinite(seconds) ? Math.max(0, Math.min(60, seconds)) * 1000 : 0

/** Each lookup is independent: scrubbing, trims and out-of-order Workers produce the same frame.
 * The reference is a real valid lap completed by this lap's start, not theoretical best sectors.
 * GPS-invalid laps have no boundary and therefore cannot generate a result or become a reference.
 */
export function getBroadcastTimingFrame(
  context: BroadcastTimingContext,
  sectorHoldSeconds: number,
  lapHoldSeconds: number
): BroadcastTimingFrame {
  const { cts, boundaries, crossings } = context
  let lapStart = 0
  let lapNumber = 0
  for (const crossing of crossings) {
    if (crossing > cts) break
    lapStart = crossing
    lapNumber++
  }
  if (boundaries.some((b) => b.excluded && b.lapStartCts === lapStart && cts < b.lapEndCts)) {
    return { lapNumber, elapsedMs: Math.max(0, cts - lapStart), checkpoint: 1, completed: 0,
      colours: ['pending', 'pending', 'pending'], referenceMs: null, referenceLap: null,
      resultMs: null, deltaMs: null, resultMix: 0, resultLeaving: false, finishTimeMix: 0,
      referenceMix: 0, finished: false }
  }
  const valid = boundaries.filter(usable)
  const current = boundaries.find((b) => !b.isOutLap && !b.excluded && b.lapStartCts === lapStart && cts < b.lapEndCts && cts <= (b.validUntilCts ?? Infinity))
  // The latest result wins, including a new sector arriving during a long previous-lap hold.
  let event: { boundary: SectorBoundary; index: number; at: number; hold: number } | null = null
  for (const b of boundaries.filter((b) => !b.isOutLap && !b.excluded)) {
    for (const [index, at] of checkpoints(b).entries()) {
      if (!Number.isFinite(at) || at > (b.validUntilCts ?? Infinity) || (index === 2 && !usable(b))) continue
      const hold = holdMs(index === 2 ? lapHoldSeconds : sectorHoldSeconds)
      if (at <= cts && (!event || at > event.at)) event = { boundary: b, index, at, hold }
    }
  }
  // An expired/disabled newer result must never revive an older popup. Crossing into another
  // lap also clears old sector results, including when that next lap has no valid GPS boundary.
  const shownEvent = event && event.at >= lapStart && event.hold > 0 && cts < event.at + event.hold ? event : null
  const display = shownEvent?.boundary ?? current
  const displayStart = display?.lapStartCts ?? lapStart
  const reference = valid.filter((b) => b.lapEndCts <= displayStart)
    .reduce<SectorBoundary | null>((best, b) => !best || cumulative(b)[2] < cumulative(best)[2] ? b : best, null)
  const completed = shownEvent ? shownEvent.index + 1 : current ? checkpoints(current).filter((at) => at <= cts).length : 0
  const checkpoint = (shownEvent ? shownEvent.index + 1 : Math.min(3, completed + 1)) as 1 | 2 | 3
  const colours: SectorColour[] = [0, 1, 2].map((index) => {
    if (!display || index >= completed) return 'pending'
    const at = checkpoints(display)[index]
    const previous = boundaries.filter((b) => !b.isOutLap && !b.excluded && b !== display && Number.isFinite(checkpoints(b)[index]) &&
      checkpoints(b)[index] <= (b.validUntilCts ?? Infinity) && (index !== 2 || usable(b)) && checkpoints(b)[index] < at)
    if (!previous.length) return 'white'
    // With one driver, session best and personal best coincide. Never invent a second driver.
    return sectors(display)[index] <= Math.min(...previous.map((b) => sectors(b)[index])) ? 'purple' : 'yellow'
  })
  const referenceMs = reference ? cumulative(reference)[checkpoint - 1] : null
  const resultMs = shownEvent ? cumulative(shownEvent.boundary)[shownEvent.index] : null
  const age = shownEvent ? cts - shownEvent.at : 0
  const transition = shownEvent ? Math.min(600, shownEvent.hold / 3) : 1
  const resultMix = shownEvent ? Math.min(smooth(age / transition), smooth((shownEvent.hold - age) / transition)) : 0
  const finished = shownEvent?.index === 2
  return {
    lapNumber: display?.lapNumber ?? lapNumber,
    elapsedMs: Math.max(0, cts - lapStart),
    checkpoint, completed, colours, referenceMs,
    referenceLap: reference?.lapNumber ?? null,
    resultMs, deltaMs: resultMs !== null && referenceMs !== null ? resultMs - referenceMs : null,
    resultMix,
    resultLeaving: !!shownEvent && age > shownEvent.hold - transition,
    // The configurable lap-result duration includes comparison followed by the full lap time.
    finishTimeMix: finished && shownEvent ? smooth((age - shownEvent.hold * 0.45) / Math.min(300, shownEvent.hold * 0.1)) : 0,
    referenceMix: reference ? smooth((cts - displayStart) / 400) : 0,
    finished
  }
}

/** Live clocks truncate to tenths; frozen results round once to milliseconds, including carry. */
export function formatBroadcastTime(ms: number, live = false): string {
  const value = Math.max(0, live ? Math.floor(ms / 100) * 100 : Math.round(ms))
  const minutes = Math.floor(value / 60000)
  const seconds = Math.floor(value / 1000) % 60
  const fraction = live ? String(Math.floor((value % 1000) / 100)) : String(value % 1000).padStart(3, '0')
  return `${minutes}:${String(seconds).padStart(2, '0')}.${fraction}`
}

export function formatBroadcastDelta(ms: number): string {
  const rounded = Math.round(ms)
  return `${rounded < 0 ? '-' : '+'}${(Math.abs(rounded) / 1000).toFixed(3)}`
}
