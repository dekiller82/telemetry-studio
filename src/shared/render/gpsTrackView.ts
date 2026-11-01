import type { ProjectedPoint } from '../telemetry/interpolate'
import { computeBounds, trimTrack, type TrackBounds } from '../telemetry/sampleAt'

/** Static GPS geometry in the sampler's original projected coordinate system. */
export interface GpsTrackView {
  trackPoints: ProjectedPoint[]
  bounds: TrackBounds
  trackCts: number[]
  trackSpeeds: number[]
}

/** Prepare once per export, or memoize on the preview's sampler/trim range. Never re-project:
 *  the live dot and ghost still interpolate against the full sampler's coordinate system.
 *  Keeping the original object for a full-range trim also keeps its colored-track cache usable. */
export function prepareGpsTrackView(source: GpsTrackView, trimStartMs?: number, trimEndMs?: number): GpsTrackView {
  if (trimStartMs === undefined || trimEndMs === undefined) return source
  const cts = source.trackCts
  // Sampler arrays are index-aligned and ordered by cts.
  if (cts.length > 0 && trimStartMs <= cts[0] && trimEndMs >= cts[cts.length - 1]) return source
  if (cts.length === 0 && source.trackPoints.length === 0) return source

  const sliced = trimTrack(source.trackPoints, cts, source.trackSpeeds, trimStartMs, trimEndMs)
  return { ...sliced, bounds: computeBounds(sliced.trackPoints) }
}
