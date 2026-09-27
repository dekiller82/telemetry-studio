import type { TelemetrySample } from '../types'
import { distanceMeters } from './laps'

export interface GpsTrackFilterOptions {
  /** Consumer GPS can jump several metres while stationary; do not treat that as vehicle motion. */
  positionToleranceM: number
  /** Coordinate-derived speed may be noisier than GPS5's Doppler-derived speed. */
  speedMultiplier: number
  /** Extra low-speed allowance, in metres per second. */
  speedSlackMps: number
  /** Last-resort guard when speed2D itself is corrupt. */
  absoluteMaxMps: number
  /** A short segment bounded by two bad transitions can be removed as an isolated spike island. */
  shortIslandMaxMs: number
  /** Only discard whole competing branches when one contiguous segment clearly dominates. */
  dominantShare: number
  minDominantDurationMs: number
}

export const DEFAULT_GPS_TRACK_FILTER_OPTIONS: GpsTrackFilterOptions = {
  positionToleranceM: 15,
  speedMultiplier: 2,
  speedSlackMps: 10,
  absoluteMaxMps: 200,
  shortIslandMaxMs: 2_000,
  dominantShare: 0.8,
  minDominantDurationMs: 30_000
}

export interface GpsTrackFilterReport {
  status: 'clean' | 'filtered' | 'ambiguous'
  inputSamples: number
  outputSamples: number
  removedSamples: number
  discontinuities: number
  segmentSizes: number[]
  dominantShare: number
}

export interface GpsTrackFilterResult {
  samples: TelemetrySample[]
  report: GpsTrackFilterReport
}

interface Segment {
  samples: TelemetrySample[]
}

/**
 * Tests whether the coordinate displacement between two GPS samples is compatible with the
 * ground speed GPS5/GPS9 reported over the same interval. GPS speed is normally Doppler-derived
 * and can remain plausible when a position solution snaps tens or hundreds of metres sideways.
 * The deliberately generous multiplier/slack keeps this a gross-outlier test, not a racing-line
 * smoother.
 */
export function isGpsTransitionPlausible(
  from: TelemetrySample,
  to: TelemetrySample,
  options: GpsTrackFilterOptions = DEFAULT_GPS_TRACK_FILTER_OPTIONS
): boolean {
  const dtSeconds = (to.cts - from.cts) / 1000
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return false

  const reportedSpeedMps = Math.max(0, from.speed2D, to.speed2D)
  const allowedSpeedMps = Math.min(
    options.absoluteMaxMps,
    options.speedMultiplier * reportedSpeedMps + options.speedSlackMps
  )
  const allowedDistanceM = options.positionToleranceM + allowedSpeedMps * dtSeconds
  return distanceMeters(from, to) <= allowedDistanceM
}

function splitAtImplausibleTransitions(samples: TelemetrySample[], options: GpsTrackFilterOptions): Segment[] {
  if (samples.length === 0) return []

  const segments: Segment[] = []
  let current: TelemetrySample[] = [samples[0]]
  for (let i = 1; i < samples.length; i++) {
    if (!isGpsTransitionPlausible(samples[i - 1], samples[i], options)) {
      segments.push({ samples: current })
      current = []
    }
    current.push(samples[i])
  }
  segments.push({ samples: current })
  return segments
}

function segmentDurationMs(segment: Segment): number {
  if (segment.samples.length < 2) return 0
  return segment.samples[segment.samples.length - 1].cts - segment.samples[0].cts
}

/**
 * Removes short islands only when both of their own boundary transitions are bad (which is why
 * they became a separate segment) but the samples on either side can connect plausibly across the
 * island's elapsed time. This preserves both halves of a good recording around an isolated GPS
 * spike instead of selecting just the longer half.
 */
function bridgeShortSpikeIslands(segments: Segment[], options: GpsTrackFilterOptions): { segments: Segment[]; removed: number } {
  const working = segments.map((segment) => ({ samples: [...segment.samples] }))
  let removed = 0
  let i = 1

  while (i < working.length - 1) {
    const left = working[i - 1]
    const island = working[i]
    const right = working[i + 1]
    const leftLast = left.samples[left.samples.length - 1]
    const rightFirst = right.samples[0]

    if (
      segmentDurationMs(island) <= options.shortIslandMaxMs &&
      isGpsTransitionPlausible(leftLast, rightFirst, options)
    ) {
      removed += island.samples.length
      working.splice(i - 1, 3, { samples: [...left.samples, ...right.samples] })
      i = Math.max(1, i - 1)
      continue
    }
    i++
  }

  return { segments: working, removed }
}

/**
 * Adaptive Kinematic Track Segmentation (AKTS).
 *
 * Unlike gopro-telemetry's fixed `WrongSpeed` ceiling, this compares coordinate-derived movement
 * with each sample's own speed2D, splits at grossly inconsistent transitions, bridges short
 * bounded spike islands, and discards competing branches only when one contiguous segment has
 * overwhelming support. Ambiguous, similarly-sized branches are left intact rather than silently
 * throwing away a large part of a recording.
 */
export function filterGpsTrack(
  samples: TelemetrySample[],
  options: GpsTrackFilterOptions = DEFAULT_GPS_TRACK_FILTER_OPTIONS
): GpsTrackFilterResult {
  if (samples.length === 0) {
    return {
      samples,
      report: {
        status: 'clean',
        inputSamples: 0,
        outputSamples: 0,
        removedSamples: 0,
        discontinuities: 0,
        segmentSizes: [],
        dominantShare: 1
      }
    }
  }

  const initialSegments = splitAtImplausibleTransitions(samples, options)
  const bridged = bridgeShortSpikeIslands(initialSegments, options)
  const segments = bridged.segments
  const spikeCleanedSamples = segments.flatMap((segment) => segment.samples)
  const dominant = segments.reduce((best, segment) =>
    segment.samples.length > best.samples.length ? segment : best
  )
  const dominantShare = dominant.samples.length / Math.max(1, spikeCleanedSamples.length)
  const dominantIsStrong =
    dominantShare >= options.dominantShare && segmentDurationMs(dominant) >= options.minDominantDurationMs

  // A single segment needs no branch selection. It can still be "filtered" if a short bounded
  // spike island was removed and its two surrounding pieces were merged above.
  const hasCompetingSegments = segments.length > 1
  const output = hasCompetingSegments && dominantIsStrong ? dominant.samples : spikeCleanedSamples
  const removedSamples = samples.length - output.length
  const status: GpsTrackFilterReport['status'] =
    hasCompetingSegments && !dominantIsStrong ? 'ambiguous' : removedSamples > 0 ? 'filtered' : 'clean'

  return {
    samples: output,
    report: {
      status,
      inputSamples: samples.length,
      outputSamples: output.length,
      removedSamples,
      discontinuities: Math.max(0, initialSegments.length - 1),
      segmentSizes: segments.map((segment) => segment.samples.length),
      dominantShare
    }
  }
}
