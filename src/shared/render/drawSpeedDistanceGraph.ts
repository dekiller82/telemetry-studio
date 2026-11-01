import type { LapSpeedPoint, LapSpeedTrace } from '../telemetry/speedTrace'
import { convertSpeed, speedUnitLabel, type SpeedUnit } from '../units'
import { resolveFontStack } from './fonts'
import { drawOutlinedText, fillRoundedRect, fitFontSizePx, scaleToRect, type Canvas2DLike, type Rect } from './canvas2d'

export interface SpeedDistanceGraphStyle {
  unit: SpeedUnit
  backgroundColor: string
  backgroundOpacity: number
  /** Nominal corner radius (px at the scaleToRect reference size) of the background panel. 0 = square corners. */
  cornerRadius: number
  gridColor: string
  gridOpacity: number
  axisLabelColor: string
  lineWidth: number
  /** Most-recent completed laps to draw, oldest of the shown set drawn first (so newer laps layer on top). */
  maxLapsShown: number
  /** Draws the in-progress lap live, growing as it happens. */
  showCurrentLap: boolean
  /** Draws the in-progress lap's line thicker so it stands out from historical reference laps. */
  highlightCurrentLap: boolean
  /** Offsets the deterministic per-lap-number color assignment -- tweak to get a different (but still stable, non-flickering) palette. */
  colorSeed: number
  /** 'fullLap' (default) draws each shown lap's entire distance, each in its own color. 'window'
   *  instead centers on the current lap's live position and shows only a local distance band around
   *  it -- every other lap is drawn in one shared neutral color (not individually colored), so the
   *  only thing standing out is whether the current lap's own line is above or below the pack of
   *  previous attempts right at this exact spot on track. */
  viewMode: 'fullLap' | 'window'
  /** 'window' mode only -- shows this many meters behind AND ahead of the current position. */
  windowMeters: number
  /** 'window' mode only -- shared color for every lap except the current one. */
  referenceLapColor: string
  referenceLapOpacity: number
}

export const DEFAULT_SPEED_DISTANCE_GRAPH_STYLE: SpeedDistanceGraphStyle = {
  unit: 'kmh',
  backgroundColor: '#0a0a10',
  backgroundOpacity: 0.72,
  cornerRadius: 12,
  gridColor: '#ffffff',
  gridOpacity: 0.14,
  axisLabelColor: '#ffffff',
  lineWidth: 2.5,
  maxLapsShown: 6,
  showCurrentLap: true,
  highlightCurrentLap: true,
  colorSeed: 0,
  viewMode: 'fullLap',
  windowMeters: 50,
  referenceLapColor: '#9a9a9a',
  referenceLapOpacity: 0.55
}

export interface DrawSpeedDistanceGraphOptions {
  rect: Rect
  style: SpeedDistanceGraphStyle
  /** Completed laps only, in chronological order -- precomputed once by the caller (doesn't depend on cts). */
  lapTraces: LapSpeedTrace[]
  /** The lap currently in progress, recomputed by the caller every frame (grows as the lap continues). Null if no start/finish line is set. */
  currentLapTrace: LapSpeedTrace | null
  fontFamily?: string
  /** Optional bounded export cache. Preview keeps the same immediate drawing path. */
  cache?: SpeedDistanceGraphCache
}

export interface SpeedDistanceGraphCache {
  /** Return false when a size/mode cannot be cached without changing its appearance. */
  draw(ctx: Canvas2DLike, options: DrawSpeedDistanceGraphOptions): boolean
}

const GOLDEN_ANGLE_DEG = 137.508
const GRID_LINE_COUNT = 4

interface DrawSegment {
  points: LapSpeedPoint[]
  color: string
  opacity: number
  isCurrent: boolean
  lapNumber: number
  /** Whether to draw the lap-number label at this segment's own line-end. */
  labeled: boolean
}

/** Deterministic per-lap "random" color -- a fixed lap number always maps to the same color (so it
 *  doesn't flicker frame to frame), using golden-angle hue stepping for good visual separation
 *  between sequential lap numbers. `colorSeed` shifts the whole palette if the defaults clash with a
 *  video's own colors. */
function colorForLapNumber(lapNumber: number, colorSeed: number): string {
  const hue = (((lapNumber * GOLDEN_ANGLE_DEG + colorSeed) % 360) + 360) % 360
  return `hsl(${hue.toFixed(1)}, 82%, 62%)`
}

function pointsInRange(points: LapSpeedPoint[], start: number, end: number): LapSpeedPoint[] {
  return points.filter((p) => p.distanceM >= start && p.distanceM <= end)
}

interface BuiltGraph {
  segments: DrawSegment[]
  domainStart: number
  domainEnd: number
  /** Non-null only in 'window' mode -- where to draw the "now" marker. */
  nowDistance: number | null
}

export interface PreparedSpeedDistanceGraph extends BuiltGraph {
  minSpeed: number
  maxSpeed: number
  speedSpan: number
}

function buildFullLapSegments(lapTraces: LapSpeedTrace[], currentLapTrace: LapSpeedTrace | null, style: SpeedDistanceGraphStyle): BuiltGraph | null {
  const shown: LapSpeedTrace[] = [...lapTraces.slice(-Math.max(1, style.maxLapsShown))]
  if (style.showCurrentLap && currentLapTrace && currentLapTrace.points.length > 1) shown.push(currentLapTrace)
  if (shown.length === 0) return null

  const domainEnd = Math.max(...shown.map((t) => t.totalDistanceM))
  if (domainEnd <= 0) return null

  const segments = shown.map(
    (trace): DrawSegment => ({
      points: trace.points,
      color: colorForLapNumber(trace.lapNumber, style.colorSeed),
      opacity: 1,
      isCurrent: trace === currentLapTrace,
      lapNumber: trace.lapNumber,
      labeled: true
    })
  )
  return { segments, domainStart: 0, domainEnd, nowDistance: null }
}

/** Centers on the current lap's live position and only shows a local distance band -- reference laps
 *  (which already have full data) can show both what's behind AND ahead of "now"; the current lap
 *  can only show up to "now" since the rest hasn't happened yet. */
function buildWindowSegments(lapTraces: LapSpeedTrace[], currentLapTrace: LapSpeedTrace | null, style: SpeedDistanceGraphStyle): BuiltGraph | null {
  if (!style.showCurrentLap || !currentLapTrace || currentLapTrace.points.length === 0) return null

  const nowDistance = currentLapTrace.points[currentLapTrace.points.length - 1].distanceM
  const domainStart = Math.max(0, nowDistance - style.windowMeters)
  const domainEnd = nowDistance + style.windowMeters

  const segments: DrawSegment[] = []
  const referenceTraces = lapTraces.slice(-Math.max(1, style.maxLapsShown))
  for (const trace of referenceTraces) {
    const points = pointsInRange(trace.points, domainStart, domainEnd)
    if (points.length < 2) continue
    segments.push({ points, color: style.referenceLapColor, opacity: style.referenceLapOpacity, isCurrent: false, lapNumber: trace.lapNumber, labeled: false })
  }

  const currentPoints = pointsInRange(currentLapTrace.points, domainStart, nowDistance)
  if (currentPoints.length >= 2) {
    segments.push({
      points: currentPoints,
      color: colorForLapNumber(currentLapTrace.lapNumber, style.colorSeed),
      opacity: 1,
      isCurrent: true,
      lapNumber: currentLapTrace.lapNumber,
      labeled: true
    })
  }

  if (segments.length === 0) return null
  return { segments, domainStart, domainEnd, nowDistance }
}

/**
 * Speed (m/s) vs. distance, reset to distance=0 at every lap start -- a MoTeC/RaceChrono-style trace
 * comparison. In 'fullLap' mode (default) every shown lap draws its entire distance in its own
 * stable color, ending exactly at that lap's own total distance, with its lap number labeled at the
 * tip of its own line. In 'window' mode the graph instead centers on the current lap's live position
 * and shows only a local distance band around it, with every lap except the current one drawn in one
 * shared neutral color -- a direct "am I faster or slower right here, right now" comparison, with a
 * thin vertical marker at the current position separating "already happened" from the reference
 * laps' preview of what's coming up.
 */
export function drawSpeedDistanceGraph(ctx: Canvas2DLike, options: DrawSpeedDistanceGraphOptions): void {
  if (options.cache?.draw(ctx, options)) return
  drawSpeedDistanceGraphLayer(ctx, options, prepareSpeedDistanceGraph(options), 'all')
}

export function prepareSpeedDistanceGraph(options: DrawSpeedDistanceGraphOptions): PreparedSpeedDistanceGraph | null {
  const { style, lapTraces, currentLapTrace } = options
  const built = style.viewMode === 'window'
    ? buildWindowSegments(lapTraces, currentLapTrace, style)
    : buildFullLapSegments(lapTraces, currentLapTrace, style)
  if (!built || built.domainEnd - built.domainStart <= 0) return null
  let maxSpeed = 0
  let minSpeed = Infinity
  for (const seg of built.segments) {
    for (const point of seg.points) {
      if (point.speedMps > maxSpeed) maxSpeed = point.speedMps
      if (point.speedMps < minSpeed) minSpeed = point.speedMps
    }
  }
  return maxSpeed > 0 ? { ...built, minSpeed, maxSpeed, speedSpan: maxSpeed - minSpeed || 1 } : null
}

/** Reference layer precedes the current trace in the immediate renderer too. Keeping this order
 * allows export to reuse axes/history while retaining the current trace's glow and labels. */
export function drawSpeedDistanceGraphLayer(
  ctx: Canvas2DLike,
  options: DrawSpeedDistanceGraphOptions,
  graph: PreparedSpeedDistanceGraph | null,
  layer: 'all' | 'reference' | 'current'
): void {
  const { rect, style, fontFamily } = options
  const fontStack = resolveFontStack(fontFamily, 'bold')

  if (layer !== 'current' && style.backgroundOpacity > 0) {
    ctx.save()
    ctx.globalAlpha = style.backgroundOpacity
    ctx.fillStyle = style.backgroundColor
    fillRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, scaleToRect(style.cornerRadius, rect))
    ctx.restore()
  }

  if (!graph) return
  const { segments, domainStart, domainEnd, nowDistance, minSpeed, maxSpeed, speedSpan } = graph
  // The slowest point across every shown segment anchors the bottom of the y-axis (instead of a
  // fixed 0) -- uses the full vertical range for whatever speed band was actually driven/is visible.

  // Reserve a right-hand margin so a full-length trace's end-of-line lap-number label has room --
  // otherwise it would get clipped at the widget's own right edge.
  const plotX = rect.x
  const plotW = rect.w * 0.87
  const valueFontSize = Math.max(8, Math.round(rect.h * 0.055))
  const unitFontSize = Math.max(7, Math.round(rect.h * 0.045))
  // Room for the unit label AND the topmost gridline's value label, stacked one above the other
  // without overlapping (they used to be drawn at the exact same y -- a real bug).
  const topPad = unitFontSize * 1.6 + valueFontSize * 0.9
  const bottomPad = rect.h * 0.1
  const plotH = rect.h - topPad - bottomPad

  const xAt = (distanceM: number): number => plotX + ((distanceM - domainStart) / (domainEnd - domainStart)) * plotW
  const yAt = (speedMps: number): number => rect.y + rect.h - bottomPad - ((speedMps - minSpeed) / speedSpan) * plotH

  if (layer !== 'current' && style.gridOpacity > 0) {
    ctx.save()
    ctx.globalAlpha = style.gridOpacity
    ctx.strokeStyle = style.gridColor
    ctx.lineWidth = Math.max(1, scaleToRect(1, rect))
    for (let i = 0; i <= GRID_LINE_COUNT; i++) {
      const y = rect.y + topPad + (plotH * i) / GRID_LINE_COUNT
      ctx.beginPath()
      ctx.moveTo(plotX, y)
      ctx.lineTo(plotX + plotW, y)
      ctx.stroke()
    }
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 1
    ctx.fillStyle = style.axisLabelColor
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    // Unit label sits above everything else, in its own reserved row at the very top of the widget.
    ctx.font = `500 ${unitFontSize}px ${fontStack}`
    ctx.fillText(speedUnitLabel(style.unit), plotX + 2, rect.y + unitFontSize * 0.7)
    ctx.font = `600 ${valueFontSize}px ${fontStack}`
    for (let i = 0; i <= GRID_LINE_COUNT; i++) {
      const speedAtLine = maxSpeed - (speedSpan * i) / GRID_LINE_COUNT
      const y = rect.y + topPad + (plotH * i) / GRID_LINE_COUNT
      ctx.fillText(`${Math.round(convertSpeed(speedAtLine, style.unit))}`, plotX + 2, y - valueFontSize * 0.6)
    }
    ctx.restore()
  }

  // "Now" marker, window mode only -- drawn before the lap lines so it sits behind them, separating
  // the already-happened portion (left) from the reference laps' preview of what's coming (right).
  if (layer !== 'current' && nowDistance !== null) {
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = style.axisLabelColor
    ctx.lineWidth = Math.max(1, scaleToRect(1, rect))
    const nowX = xAt(nowDistance)
    ctx.beginPath()
    ctx.moveTo(nowX, rect.y + topPad)
    ctx.lineTo(nowX, rect.y + rect.h - bottomPad)
    ctx.stroke()
    ctx.restore()
  }

  const lineWidth = scaleToRect(style.lineWidth, rect)
  const outlineWidth = scaleToRect(1.5, rect)

  for (const seg of segments) {
    if ((layer === 'current' && !seg.isCurrent) || (layer === 'reference' && seg.isCurrent)) continue
    ctx.save()
    ctx.globalAlpha = seg.opacity
    ctx.strokeStyle = seg.color
    ctx.lineWidth = seg.isCurrent && style.highlightCurrentLap ? lineWidth * 1.8 : lineWidth
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    if (seg.isCurrent && style.highlightCurrentLap) {
      ctx.shadowBlur = lineWidth * 2
      ctx.shadowColor = seg.color
    }
    ctx.beginPath()
    ctx.moveTo(xAt(seg.points[0].distanceM), yAt(seg.points[0].speedMps))
    for (let i = 1; i < seg.points.length; i++) {
      ctx.lineTo(xAt(seg.points[i].distanceM), yAt(seg.points[i].speedMps))
    }
    ctx.stroke()
    ctx.restore()

    if (!seg.labeled) continue
    const last = seg.points[seg.points.length - 1]
    const labelX = xAt(last.distanceM) + scaleToRect(6, rect)
    const labelY = yAt(last.speedMps)
    const labelText = String(seg.lapNumber)
    ctx.save()
    ctx.globalAlpha = seg.opacity
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    fitFontSizePx(ctx, labelText, rect.w * 0.1, rect.h * 0.09, '700', fontStack)
    drawOutlinedText(ctx, labelText, labelX, labelY, seg.color, outlineWidth, '#000000')
    ctx.restore()
  }
}
