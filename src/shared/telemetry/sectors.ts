import type { TelemetrySample } from '../types'
import { distanceMeters } from './laps'
import { isGpsRangeContinuous } from './gpsContinuity'

export interface LapSectorTimes {
  lapNumber: number
  s1Ms: number
  s2Ms: number
  s3Ms: number
  totalMs: number
}

export interface SectorState {
  currentLapExcluded?: boolean
  /** Immutable source timeline for the optional broadcast layout. */
  broadcast?: import('./broadcastSectors').BroadcastTimingContext
  currentSector: 1 | 2 | 3
  currentSectorElapsedMs: number
  /** The CURRENT (possibly still in-progress) lap's own S1 time -- available as soon as sector 2
   *  begins, not just once the whole lap finishes. Null before that. */
  currentLapS1Ms: number | null
  isCurrentLapS1Best: boolean
  /** The CURRENT lap's own S2 time -- available as soon as sector 3 begins. Null before that. */
  currentLapS2Ms: number | null
  isCurrentLapS2Best: boolean
  /** Sector times for the most recently *completed* lap at the queried time (null until one full lap has finished) -- for an optional secondary "last lap" row. */
  lastLap: LapSectorTimes | null
  bestS1Ms: number | null
  bestS2Ms: number | null
  bestS3Ms: number | null
  /** Whether `lastLap`'s own time for that sector is (tied for) this session's fastest -- drives purple highlighting on the "last lap" row. */
  isLastS1Best: boolean
  isLastS2Best: boolean
  isLastS3Best: boolean
}

export interface SectorBoundary {
  /** Missing on older standalone boundaries; false when a full circuit cannot be compared. */
  complete?: boolean
  validUntilCts?: number
  excluded?: boolean
  lapNumber: number
  /** The "out lap" (video start to the first crossing) has a real, known end time (the first
   *  crossing) so it CAN be sector-divided like any other lap for live current-sector display --
   *  but it isn't a genuine timed lap (mirrors lapTimesFromCrossings excluding it), so it's kept
   *  out of lastLap/best-sector bookkeeping. */
  isOutLap: boolean
  lapStartCts: number
  s1Cts: number
  s2Cts: number
  lapEndCts: number
}

/**
 * For each lap with a known end time -- every pair of consecutive crossings, plus the "out lap"
 * from video start to the first crossing -- finds the two sample timestamps where cumulative GPS
 * arc-length first reaches 1/3 and 2/3 of that lap's own total distance, so every lap is
 * self-divided into three roughly-equal-distance sectors automatically. No separate
 * sector-boundary marking UI needed, and no sensitivity to small racing-line variance between laps.
 * Only laps with a known end time can be divided this way -- an unfinished final partial lap (no
 * closing crossing yet) has no boundary entry, since its total distance isn't known.
 */
function computeSectorBoundaries(samples: TelemetrySample[], crossings: number[]): SectorBoundary[] {
  const boundaries: SectorBoundary[] = []

  for (let lapIdx = 0; lapIdx < crossings.length; lapIdx++) {
    const isOutLap = lapIdx === 0
    const lapStartCts = isOutLap ? 0 : crossings[lapIdx - 1]
    const lapEndCts = crossings[lapIdx]
    if (!isGpsRangeContinuous(samples, lapStartCts, lapEndCts)) continue
    const lapSamples = samples.filter((s) => s.cts >= lapStartCts && s.cts <= lapEndCts)
    if (lapSamples.length < 3) continue

    let totalDist = 0
    const cumDist: number[] = [0]
    for (let i = 1; i < lapSamples.length; i++) {
      totalDist += distanceMeters(lapSamples[i - 1], lapSamples[i])
      cumDist.push(totalDist)
    }
    if (totalDist <= 0) continue

    const s1Target = totalDist / 3
    const s2Target = (totalDist * 2) / 3
    const s1Index = cumDist.findIndex((d) => d >= s1Target)
    const s2Index = cumDist.findIndex((d) => d >= s2Target)

    boundaries.push({
      lapNumber: lapIdx,
      isOutLap,
      lapStartCts,
      s1Cts: lapSamples[s1Index === -1 ? lapSamples.length - 1 : s1Index].cts,
      s2Cts: lapSamples[s2Index === -1 ? lapSamples.length - 1 : s2Index].cts,
      lapEndCts
    })
  }

  return boundaries
}

function sectorTimesFromBoundary(b: SectorBoundary): LapSectorTimes {
  return {
    lapNumber: b.lapNumber,
    s1Ms: b.s1Cts - b.lapStartCts,
    s2Ms: b.s2Cts - b.s1Cts,
    s3Ms: b.lapEndCts - b.s2Cts,
    totalMs: b.lapEndCts - b.lapStartCts
  }
}

/** Precomputed once per widget (O(n) over telemetry), not per-frame -- mirrors detectLapCrossings. */
export function computeLapSectors(samples: TelemetrySample[], crossings: number[]): SectorBoundary[] {
  return computeSectorBoundaries(samples, crossings)
}

/** Resolves live clocks from crossings, and valid sector results from precomputed boundaries. */
export function getSectorStateAt(boundaries: SectorBoundary[], cts: number, crossings?: readonly number[]): SectorState {
  // Incomplete laps have no sector boundary entry, but their crossings still reset the live clock.
  const resolvedCrossings = crossings ?? boundaries.flatMap((b) => [b.lapStartCts, b.lapEndCts])
  let lapStartCts = 0
  for (const crossing of resolvedCrossings) {
    if (crossing <= cts) lapStartCts = crossing
    else break
  }
  const boundary = boundaries.find((b) => b.lapStartCts === lapStartCts && cts < b.lapEndCts)

  let currentSector: 1 | 2 | 3 = 1
  let currentSectorElapsedMs = !crossings && boundaries.length === 0 ? 0 : Math.max(0, cts - lapStartCts)
  let currentLapS1Ms: number | null = null
  let currentLapS2Ms: number | null = null

  if (boundary) {
    const b = boundary
    if (cts < b.s1Cts) {
      currentSectorElapsedMs = cts - b.lapStartCts
    } else if (cts < b.s2Cts) {
      currentSector = 2
      currentSectorElapsedMs = cts - b.s1Cts
      currentLapS1Ms = b.s1Cts - b.lapStartCts
    } else {
      currentSector = 3
      currentSectorElapsedMs = Math.max(0, cts - b.s2Cts)
      currentLapS1Ms = b.s1Cts - b.lapStartCts
      currentLapS2Ms = b.s2Cts - b.s1Cts
    }
  }

  // Only genuine timed laps (not the out-lap) that fully finished at/before cts count toward
  // last-lap/bests, so scrubbing earlier in the video never leaks a future lap's sector times in,
  // and the untimed out-lap never counts as a real lap time (mirrors lapTimesFromCrossings).
  const completed = boundaries.filter((b) => !b.isOutLap && !b.excluded && b.complete !== false && b.lapEndCts <= cts).map(sectorTimesFromBoundary)
  const lastLap = completed.length > 0 ? completed[completed.length - 1] : null

  // "Best" includes the current (still in-progress) lap's own already-completed sectors too --
  // matches real timing towers, where a sector can turn purple the instant it's set, not only
  // once the whole lap is done.
  const completedS1 = completed.map((l) => l.s1Ms)
  const completedS2 = completed.map((l) => l.s2Ms)
  const completedS3 = completed.map((l) => l.s3Ms)
  const allS1 = currentLapS1Ms !== null && !boundary?.excluded ? [...completedS1, currentLapS1Ms] : completedS1
  const allS2 = currentLapS2Ms !== null && !boundary?.excluded ? [...completedS2, currentLapS2Ms] : completedS2

  const bestS1Ms = allS1.length ? Math.min(...allS1) : null
  const bestS2Ms = allS2.length ? Math.min(...allS2) : null
  const bestS3Ms = completedS3.length ? Math.min(...completedS3) : null

  return {
    currentLapExcluded: boundary?.excluded === true,
    currentSector,
    broadcast: { cts, boundaries, crossings: resolvedCrossings },
    currentSectorElapsedMs,
    currentLapS1Ms,
    isCurrentLapS1Best: !boundary?.excluded && currentLapS1Ms !== null && bestS1Ms !== null && currentLapS1Ms === bestS1Ms,
    currentLapS2Ms,
    isCurrentLapS2Best: !boundary?.excluded && currentLapS2Ms !== null && bestS2Ms !== null && currentLapS2Ms === bestS2Ms,
    lastLap,
    bestS1Ms,
    bestS2Ms,
    bestS3Ms,
    isLastS1Best: lastLap !== null && bestS1Ms !== null && lastLap.s1Ms === bestS1Ms,
    isLastS2Best: lastLap !== null && bestS2Ms !== null && lastLap.s2Ms === bestS2Ms,
    isLastS3Best: lastLap !== null && bestS3Ms !== null && lastLap.s3Ms === bestS3Ms
  }
}
