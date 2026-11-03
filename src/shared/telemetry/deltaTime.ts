import type { TelemetrySample } from '../types'
import { distanceMeters } from './laps'
import { isGpsRangeContinuous } from './gpsContinuity'
import { createMonotoneCubicInterpolant, findBracketIndex } from './interpolate'

export interface LapDistanceCurve {
  lapNumber: number
  lapStartCts: number
  lapEndCts: number
  totalDistanceM: number
  totalTimeMs: number
  /** Monotone cubic, GPS arc-length (m, clamped to [0, totalDistanceM] by the interpolant itself) -> elapsed ms from lap start. */
  timeAtDistance: (distanceM: number) => number
}

export interface DeltaState {
  /** currentLapElapsed - baseline's own time at the same distance-into-the-lap; null until a baseline (one completed lap) exists. */
  deltaMs: number | null
  /** Total time of the baseline (fastest completed-by-now) lap. */
  baselineLapMs: number | null
  /** baselineLapMs + deltaMs -- projected final time for the lap in progress at this pace. */
  predictedLapMs: number | null
  /** Absolute cts to sample the baseline lap's own GPS position at, for a "ghost" marker on the GPS
   *  Track widget -- deliberately the SAME ELAPSED TIME into the baseline lap as the current lap's
   *  own elapsed time, not the same distance. Same-distance would place the ghost at nearly the same
   *  physical spot on the track as the live dot always (distance-into-lap determines track position
   *  almost independent of pace), showing no gap at all; same elapsed time is what makes the ghost
   *  visibly ahead/behind on the track shape, matching how a racing-game ghost car works. Null until
   *  a baseline lap exists. */
  ghostCts: number | null
}

/** Cumulative GPS arc-length from `lapStartCts` to `cts`, walking only that lap's own samples (cheap
 *  -- same cost class as the Gaussian speed-smoothing window already computed per frame elsewhere).
 *  Interpolates the final partial segment linearly so distance advances smoothly between GPS fixes
 *  (~10-18Hz) rather than in visible steps, mirroring how positionAt smoothly interpolates position. */
function cumulativeDistanceAt(samples: TelemetrySample[], lapStartCts: number, cts: number): number {
  if (samples.length < 2) return 0
  const startIdx = findBracketIndex(samples, lapStartCts)
  const endIdx = findBracketIndex(samples, cts)
  if (endIdx <= startIdx) return 0

  let total = 0
  for (let i = startIdx; i < endIdx; i++) {
    total += distanceMeters(samples[i], samples[i + 1])
  }

  if (endIdx + 1 < samples.length) {
    const a = samples[endIdx]
    const b = samples[endIdx + 1]
    const span = b.cts - a.cts
    if (span > 0 && cts > a.cts) {
      total += distanceMeters(a, b) * Math.min(1, (cts - a.cts) / span)
    }
  }
  return total
}

/**
 * One distance->time curve per genuine completed lap (consecutive crossing pairs, excluding the
 * out-lap before the first crossing -- mirrors lapTimesFromCrossings). Precomputed once (like
 * detectLapCrossings/computeLapSectors), not per frame -- getDeltaStateAt resolves cheaply against
 * these on every query.
 */
/** @deprecated Legacy arc-length API. Preview/export share computeTrackTiming and getTrackDeltaStateAt. */
export function computeLapDistanceCurves(samples: TelemetrySample[], crossings: number[]): LapDistanceCurve[] {
  const curves: LapDistanceCurve[] = []

  for (let lapNumber = 1; lapNumber < crossings.length; lapNumber++) {
    const lapStartCts = crossings[lapNumber - 1]
    const lapEndCts = crossings[lapNumber]
    if (!isGpsRangeContinuous(samples, lapStartCts, lapEndCts)) continue
    const startIdx = findBracketIndex(samples, lapStartCts)
    const endIdx = findBracketIndex(samples, lapEndCts)
    if (endIdx - startIdx < 1) continue

    const distances: number[] = [0]
    const times: number[] = [0]
    let total = 0
    for (let j = startIdx; j < endIdx; j++) {
      total += distanceMeters(samples[j], samples[j + 1])
      distances.push(total)
      times.push(samples[j + 1].cts - lapStartCts)
    }
    if (total <= 0) continue

    curves.push({
      lapNumber,
      lapStartCts,
      lapEndCts,
      totalDistanceM: total,
      totalTimeMs: lapEndCts - lapStartCts,
      timeAtDistance: createMonotoneCubicInterpolant(distances, times)
    })
  }

  return curves
}

/**
 * Resolves the live delta-to-baseline at `cts`: baseline is the fastest lap *completed by `cts`*
 * (never a future lap -- same discipline as getLapStateAt/getSectorStateAt, so scrubbing earlier in
 * the video never leaks a later personal best in). Compares the current in-progress lap's own
 * elapsed time against what the baseline lap took to reach the SAME distance into the lap, not the
 * same elapsed time -- a straight time-vs-time comparison would be meaningless once the two laps'
 * paces diverge.
 */
/** @deprecated Legacy arc-length API; new consumers must use the shared fixed-position model. */
export function getDeltaStateAt(
  curves: LapDistanceCurve[],
  crossings: number[],
  samples: TelemetrySample[],
  cts: number
): DeltaState {
  let idx = -1
  for (let i = 0; i < crossings.length; i++) {
    if (crossings[i] <= cts) idx = i
    else break
  }
  const lapStartCts = idx >= 0 ? crossings[idx] : 0
  if (!isGpsRangeContinuous(samples, lapStartCts, cts)) {
    return { deltaMs: null, baselineLapMs: null, predictedLapMs: null, ghostCts: null }
  }

  const completedCurves = curves.filter((c) => c.lapEndCts <= cts)
  if (completedCurves.length === 0) {
    return { deltaMs: null, baselineLapMs: null, predictedLapMs: null, ghostCts: null }
  }

  const baseline = completedCurves.reduce((best, c) => (c.totalTimeMs < best.totalTimeMs ? c : best))
  const currentDistance = cumulativeDistanceAt(samples, lapStartCts, cts)
  const baselineTimeAtDistance = baseline.timeAtDistance(currentDistance)
  const currentElapsedMs = Math.max(0, cts - lapStartCts)
  const deltaMs = currentElapsedMs - baselineTimeAtDistance
  const ghostCts = Math.min(baseline.lapStartCts + currentElapsedMs, baseline.lapEndCts)

  return {
    deltaMs,
    baselineLapMs: baseline.totalTimeMs,
    predictedLapMs: baseline.totalTimeMs + deltaMs,
    ghostCts
  }
}
