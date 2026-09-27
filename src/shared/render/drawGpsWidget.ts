import type { ProjectedPoint } from '../telemetry/interpolate'
import type { TrackBounds } from '../telemetry/sampleAt'
import { lerpColor, scaleToRect, type Canvas2DLike, type CanvasImageLike, type Rect } from './canvas2d'
import { createRectFitTransform } from './layout'

/** Traces a smooth curve through every point (quadratic segments via midpoints, each raw point as
 * the control point) instead of straight lineTo segments between them, which looks faceted at
 * turns when GPS sample spacing is coarse relative to the curve. Must be called between
 * ctx.beginPath() and ctx.stroke(). */
function tracePath(ctx: Canvas2DLike, points: ProjectedPoint[]): void {
  ctx.moveTo(points[0].x, points[0].y)
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y)
    return
  }
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2
    const midY = (points[i].y + points[i + 1].y) / 2
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last.x, last.y)
}

export interface GpsWidgetStyle {
  lineColor: string
  lineWidth: number
  lineOpacity: number
  dotColor: string
  dotRadius: number
  dotGlow: boolean
  /** 'solid' = the original single-color line (default, zero behavior change). 'speed' colors each
   *  segment by how fast it was driven; 'braking' colors it by whether that segment was under heavy
   *  braking, accelerating, or neither. */
  colorMode: 'solid' | 'speed' | 'braking'
  /** speed mode gradient endpoints -- scaled against this session's own min/max speed. */
  slowColor: string
  fastColor: string
  /** braking mode bucket colors. */
  brakingColor: string
  acceleratingColor: string
  neutralColor: string
  /** braking mode: |acceleration| below this (m/s^2) counts as neutral, not braking/accelerating. */
  brakingThresholdMps2: number
  /** Shows a second, smaller marker at the fastest completed lap's own position at the SAME elapsed
   *  time into its lap as the current one (see DeltaState.ghostCts) -- a spatial "am I ahead or
   *  behind" indicator, separate from Delta Time's numeric readout. Off by default: needs a
   *  completed lap to exist, and not every layout wants a second dot on the track. */
  showGhost: boolean
  ghostColor: string
  /** 'full' (default) fits the entire track/session shape to the widget, same as always. 'window'
   *  instead centers the view on the current live position and zooms in to a fixed radius around
   *  it -- on a full-track view a close gap between the live dot and the ghost marker can be a
   *  fraction of a pixel; zoomed in, the same gap is actually visible. */
  viewMode: 'full' | 'window'
  /** 'window' mode only -- half-width of the zoomed view, in meters (e.g. 25 shows a ~50m-wide
   *  area centered on the current position). */
  windowRadiusM: number
  /** Plots a small marker at each detected corner apex (see shared/telemetry/apex.ts) directly on
   *  the track outline -- shows WHERE the corners are, not just a floating speed number elsewhere
   *  (that's what the Apex Speed Callout widget already shows). Detection is independent of that
   *  widget's own thresholds -- each has its own, same as any other per-widget-style detection. */
  showApexMarkers: boolean
  apexMarkerColor: string
  apexMinDropMps: number
  apexMinGapMs: number
}

export const DEFAULT_GPS_STYLE: GpsWidgetStyle = {
  lineColor: '#ffffff',
  lineWidth: 3,
  lineOpacity: 0.85,
  dotColor: '#ff3b30',
  dotRadius: 7,
  dotGlow: true,
  colorMode: 'solid',
  slowColor: '#2979ff',
  fastColor: '#ff3b30',
  brakingColor: '#ff3b30',
  acceleratingColor: '#3ddc71',
  neutralColor: '#ffffff',
  brakingThresholdMps2: 1.5,
  showGhost: false,
  ghostColor: '#b026ff',
  viewMode: 'full',
  windowRadiusM: 25,
  showApexMarkers: false,
  apexMarkerColor: '#ffd60a',
  apexMinDropMps: 8,
  apexMinGapMs: 1500
}

/** The bounds to actually project against for this frame -- the full track's own bounds in 'full'
 *  mode (unchanged from before this option existed), or a small square centered on the current live
 *  position in 'window' mode. Exported so callers building the colorMode 'speed'/'braking' cache
 *  (which is built once against a STATIC transform) can tell it doesn't apply in 'window' mode,
 *  where the transform moves every single frame. */
export function effectiveGpsBounds(style: GpsWidgetStyle, bounds: TrackBounds, dotPosition: ProjectedPoint): TrackBounds {
  if (style.viewMode !== 'window') return bounds
  return {
    minX: dotPosition.x - style.windowRadiusM,
    maxX: dotPosition.x + style.windowRadiusM,
    minY: dotPosition.y - style.windowRadiusM,
    maxY: dotPosition.y + style.windowRadiusM
  }
}

/** Per-segment color for 'speed' mode: lerps between slowColor/fastColor by this session's own
 *  min/max speed (confirmed default: relative to the session, not a fixed configured range). */
function speedSegmentColor(style: GpsWidgetStyle, speedBounds: { min: number; max: number }, speedMps: number): string {
  const span = speedBounds.max - speedBounds.min || 1
  return lerpColor(style.slowColor, style.fastColor, (speedMps - speedBounds.min) / span)
}

/** Per-segment color for 'braking' mode: buckets signed acceleration between two consecutive
 *  samples against brakingThresholdMps2 -- braking (decelerating), accelerating, or neutral. */
function brakingSegmentColor(style: GpsWidgetStyle, speedA: number, speedB: number, ctsA: number, ctsB: number): string {
  const dtSeconds = (ctsB - ctsA) / 1000
  const accel = dtSeconds > 0 ? (speedB - speedA) / dtSeconds : 0
  if (accel <= -style.brakingThresholdMps2) return style.brakingColor
  if (accel >= style.brakingThresholdMps2) return style.acceleratingColor
  return style.neutralColor
}

/** Draws the track as individually-colored straight segments (not the smooth quadratic curve --
 *  per-segment coloring and curve smoothing don't compose, a deliberate trade-off) for the 'speed'
 *  and 'braking' color modes. Exported so callers can pre-render this once into an offscreen cache
 *  (see buildColoredGpsTrackCache) instead of paying its full per-segment cost every frame. */
export function drawColoredTrackSegments(
  ctx: Canvas2DLike,
  screenPoints: ProjectedPoint[],
  style: GpsWidgetStyle,
  lineWidth: number,
  trackSpeeds: number[],
  trackCts: number[],
  speedBounds: { min: number; max: number }
): void {
  ctx.save()
  ctx.globalAlpha = style.lineOpacity
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (let i = 0; i < screenPoints.length - 1; i++) {
    const color =
      style.colorMode === 'speed'
        ? speedSegmentColor(style, speedBounds, (trackSpeeds[i] + trackSpeeds[i + 1]) / 2)
        : brakingSegmentColor(style, trackSpeeds[i], trackSpeeds[i + 1], trackCts[i], trackCts[i + 1])
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(screenPoints[i].x, screenPoints[i].y)
    ctx.lineTo(screenPoints[i + 1].x, screenPoints[i + 1].y)
    ctx.stroke()
  }
  ctx.restore()
}

export interface DrawGpsWidgetOptions {
  rect: Rect
  trackPoints: ProjectedPoint[]
  dotPosition: ProjectedPoint
  /** False when the current frame lies outside the retained, trustworthy GPS time range. */
  showDot?: boolean
  bounds: TrackBounds
  style: GpsWidgetStyle
  /** Raw speed2D + cts, 1:1 index-aligned with trackPoints -- only needed for colorMode 'speed'/'braking'
   *  (speed for the color lerp, cts to compute per-segment acceleration for braking mode). */
  trackSpeeds?: number[]
  trackCts?: number[]
  speedBounds?: { min: number; max: number }
  /** Pre-rendered colorMode 'speed'/'braking' track, built once by buildColoredGpsTrackCache and
   *  reused across frames -- the colored segments never change frame-to-frame (only the dot does),
   *  so re-stroking potentially tens of thousands of individual segments every animation frame was
   *  pure waste. Falls back to drawing fresh (slow, but correct) when not provided. */
  coloredTrackImage?: CanvasImageLike | null
  /** Only relevant when style.showGhost is true -- see DeltaState.ghostCts for why this is resolved
   *  at the SAME elapsed time into the baseline lap, not the same distance. Null when no baseline
   *  lap exists yet (e.g. still on the first timed lap), in which case no ghost is drawn. */
  ghostPosition?: ProjectedPoint | null
  /** Only relevant when style.showApexMarkers is true -- one entry per detected apex, resolved by
   *  the caller via sampler.positionAt(event.cts) (see shared/telemetry/apex.ts). */
  apexPositions?: ProjectedPoint[]
}

/**
 * Pre-renders the colorMode 'speed'/'braking' track once into `cacheCtx` (an offscreen canvas
 * sized to exactly `rect.w` x `rect.h`, at rect {0,0,w,h}), for reuse via DrawGpsWidgetOptions.coloredTrackImage.
 * Callers should rebuild this only when its actual inputs change (style/track data/pixel size),
 * not every frame -- see WidgetCanvas.tsx and frameRenderer.ts for the caching call sites.
 */
export function buildColoredGpsTrackCache(
  cacheCtx: Canvas2DLike,
  trackPoints: ProjectedPoint[],
  bounds: TrackBounds,
  rect: Rect,
  style: GpsWidgetStyle,
  trackSpeeds: number[],
  trackCts: number[],
  speedBounds: { min: number; max: number }
): void {
  cacheCtx.clearRect(0, 0, rect.w, rect.h)
  const project = createRectFitTransform(bounds, rect)
  const screenPoints = trackPoints.map(project)
  const lineWidth = scaleToRect(style.lineWidth, rect)
  drawColoredTrackSegments(cacheCtx, screenPoints, style, lineWidth, trackSpeeds, trackCts, speedBounds)
}

/** Draws the Quik-style GPS track: a line for the full lap/session shape plus a dot for current position. */
export function drawGpsWidget(ctx: Canvas2DLike, options: DrawGpsWidgetOptions): void {
  const { rect, trackPoints, dotPosition, showDot = true, bounds, style, trackSpeeds, trackCts, speedBounds, coloredTrackImage, ghostPosition, apexPositions } =
    options
  if (trackPoints.length === 0) return

  const effectiveBounds = effectiveGpsBounds(style, bounds, dotPosition)
  const project = createRectFitTransform(effectiveBounds, rect)
  const screenDot = project(dotPosition)

  // lineWidth/dotRadius are nominal pixel values tuned at a reference box size -- scaled here so
  // the line/dot render at a consistent visual proportion whether `rect` is a small on-screen
  // preview canvas or a full native-resolution export frame (the track shape itself already
  // scales correctly via createRectFitTransform's uniform projection; this was the piece that didn't).
  const lineWidth = scaleToRect(style.lineWidth, rect)
  const dotRadius = scaleToRect(style.dotRadius, rect)

  // The cached image is pre-rendered once against the FULL track's own static bounds -- incompatible
  // with 'window' mode, where the transform recenters on the live position every single frame.
  const canColor = style.colorMode !== 'solid' && trackSpeeds && trackCts && speedBounds && trackPoints.length > 1
  if (canColor && coloredTrackImage && style.viewMode !== 'window') {
    // The cache already has style.lineOpacity baked into its own pixels (drawColoredTrackSegments
    // applies it while building the cache) -- compositing it at globalAlpha 1 here reproduces
    // exactly the same pixels as the fresh-draw path, including how overlapping segments (e.g. two
    // laps tracing the same stretch of road) blend with each other.
    ctx.save()
    ctx.globalAlpha = 1
    ctx.drawImage(coloredTrackImage, rect.x, rect.y, rect.w, rect.h)
    ctx.restore()
  } else if (canColor) {
    const screenPoints = trackPoints.map(project)
    drawColoredTrackSegments(ctx, screenPoints, style, lineWidth, trackSpeeds!, trackCts!, speedBounds!)
  } else {
    const screenPoints = trackPoints.map(project)
    ctx.save()
    ctx.globalAlpha = style.lineOpacity
    ctx.strokeStyle = style.lineColor
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    tracePath(ctx, screenPoints)
    ctx.stroke()
    ctx.restore()
  }

  if (style.showApexMarkers && apexPositions && apexPositions.length > 0) {
    const apexRadius = dotRadius * 0.55
    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.fillStyle = style.apexMarkerColor
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = Math.max(1, apexRadius * 0.25)
    for (const apexPosition of apexPositions) {
      const screenApex = project(apexPosition)
      ctx.beginPath()
      ctx.arc(screenApex.x, screenApex.y, apexRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  if (style.showGhost && ghostPosition) {
    const screenGhost = project(ghostPosition)
    ctx.save()
    ctx.globalAlpha = 0.75
    ctx.fillStyle = style.ghostColor
    ctx.beginPath()
    ctx.arc(screenGhost.x, screenGhost.y, dotRadius * 0.75, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  if (showDot) {
    ctx.save()
    ctx.globalAlpha = 1
    if (style.dotGlow) {
      ctx.shadowBlur = dotRadius * 2.5
      ctx.shadowColor = style.dotColor
    }
    ctx.fillStyle = style.dotColor
    ctx.beginPath()
    ctx.arc(screenDot.x, screenDot.y, dotRadius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}
