import type { LapExclusionSet } from '../types'
import type { DetectedCrossing } from './laps'

export interface SelectableLap {
  lapNumber: number
  key: string
  startCts: number
  endCts: number
  excluded: boolean
}

/** Source timestamps anchor both ends. Never carry a decision onto a different interval after a
 * false crossing is removed, a cache is cleaned up, or a different starting line is chosen. */
export function lapExclusionKey(rawStartCts: number, rawEndCts: number): string {
  return `${rawStartCts}:${rawEndCts}`
}

export function selectableLaps(detailed: readonly DetectedCrossing[], exclusions: LapExclusionSet = {}): SelectableLap[] {
  const crossings = detailed.filter((crossing) => !crossing.ignored)
  return crossings.slice(0, -1).map((start, i) => {
    const end = crossings[i + 1]
    const key = lapExclusionKey(start.rawCts, end.rawCts)
    return { lapNumber: i + 1, key, startCts: start.cts, endCts: end.cts, excluded: exclusions[key] === true }
  })
}

export function excludedLapNumbers(detailed: readonly DetectedCrossing[], exclusions?: LapExclusionSet): ReadonlySet<number> {
  return new Set(selectableLaps(detailed, exclusions).filter((lap) => lap.excluded).map((lap) => lap.lapNumber))
}
