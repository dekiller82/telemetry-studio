import type { TelemetrySample } from '../types'
import { distanceMeters } from './laps'
import { isGpsRangeContinuous } from './gpsContinuity'
import { findBracketIndex } from './interpolate'

export interface LapSpeedPoint {
  /** Cumulative GPS arc-length from this lap's own start, meters. */
  distanceM: number
  speedMps: number
}

export interface LapSpeedTrace {
  lapNumber: number
  totalDistanceM: number
  points: LapSpeedPoint[]
}

/** One full trace per completed lap (consecutive crossing pairs, excluding the out-lap -- mirrors
 *  lapTimesFromCrossings/computeLapDistanceCurves). Precomputed once, not per frame -- doesn't
 *  depend on cts. */
export function computeLapSpeedTraces(samples: TelemetrySample[], crossings: number[]): LapSpeedTrace[] {
  const traces: LapSpeedTrace[] = []

  for (let lapNumber = 1; lapNumber < crossings.length; lapNumber++) {
    const lapStartCts = crossings[lapNumber - 1]
    const lapEndCts = crossings[lapNumber]
    if (!isGpsRangeContinuous(samples, lapStartCts, lapEndCts)) continue
    const startIdx = findBracketIndex(samples, lapStartCts)
    const endIdx = findBracketIndex(samples, lapEndCts)
    if (endIdx - startIdx < 1) continue

    const points: LapSpeedPoint[] = [{ distanceM: 0, speedMps: samples[startIdx].speed2D }]
    let total = 0
    for (let j = startIdx; j < endIdx; j++) {
      total += distanceMeters(samples[j], samples[j + 1])
      points.push({ distanceM: total, speedMps: samples[j + 1].speed2D })
    }
    if (total <= 0) continue

    traces.push({ lapNumber, totalDistanceM: total, points })
  }

  return traces
}

/**
 * The in-progress lap's own trace up to `cts` -- recomputed every frame (cheap: bounded to just
 * this one lap's own samples, same cost class as the current-lap distance walk in deltaTime.ts),
 * since it grows as the lap continues. Lap numbering matches getLapStateAt's own convention (the
 * lap between the two crossings straddling `cts`; the out-lap before any crossing counts as lap 1
 * too, per the app-wide "no separate untimed out lap" numbering decision).
 */
export function computeCurrentLapSpeedTrace(samples: TelemetrySample[], crossings: number[], cts: number): LapSpeedTrace | null {
  if (samples.length === 0) return null

  let idx = -1
  for (let i = 0; i < crossings.length; i++) {
    if (crossings[i] <= cts) idx = i
    else break
  }
  const lapStartCts = idx >= 0 ? crossings[idx] : 0
  if (!isGpsRangeContinuous(samples, lapStartCts, cts)) return null
  const lapNumber = Math.max(1, idx + 1)

  const startIdx = findBracketIndex(samples, lapStartCts)
  const endIdx = findBracketIndex(samples, cts)
  if (endIdx < startIdx) return { lapNumber, totalDistanceM: 0, points: [] }

  const points: LapSpeedPoint[] = [{ distanceM: 0, speedMps: samples[startIdx].speed2D }]
  let total = 0
  for (let j = startIdx; j < endIdx; j++) {
    total += distanceMeters(samples[j], samples[j + 1])
    points.push({ distanceM: total, speedMps: samples[j + 1].speed2D })
  }

  return { lapNumber, totalDistanceM: total, points }
}
