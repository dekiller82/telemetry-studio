import type { ProjectedPoint } from '../telemetry/interpolate'
import type { TrackBounds } from '../telemetry/sampleAt'
import type { Rect } from './canvas2d'

/**
 * Builds a transform from local planar-meter track space into canvas pixel space: uniformly
 * scaled and centered to fit `rect` (with padding as a fraction of rect size), Y-flipped so
 * north (larger latitude) renders upward.
 */
export function createRectFitTransform(
  bounds: TrackBounds,
  rect: Rect,
  padding = 0.12
): (p: ProjectedPoint) => ProjectedPoint {
  const spanX = bounds.maxX - bounds.minX || 1
  const spanY = bounds.maxY - bounds.minY || 1
  const availW = rect.w * (1 - padding * 2)
  const availH = rect.h * (1 - padding * 2)
  const scale = Math.min(availW / spanX, availH / spanY)

  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const rectCenterX = rect.x + rect.w / 2
  const rectCenterY = rect.y + rect.h / 2

  return (p: ProjectedPoint) => ({
    ...p,
    x: (p.x - centerX) * scale + rectCenterX,
    y: -(p.y - centerY) * scale + rectCenterY
  })
}
