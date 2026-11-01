import type { GForceHistoryPoint, GForceReading } from '../telemetry/sampleAt'
import { resolveFontStack } from './fonts'
import { drawOutlinedText, drawStaticWidgetLayer, fillRoundedRect, fitFontSizePx, scaleToRect, type Canvas2DLike, type StaticWidgetLayer, type Rect } from './canvas2d'

export interface GForceDiagramStyle {
  /** Grid radius, in G -- how many G's the outer ring represents. */
  maxG: number
  ringColor: string
  ringOpacity: number
  axisLabelColor: string
  /** ACCEL/BRAKE/LEFT/RIGHT text around the ring -- independent of the ring/grid itself
   *  (ringOpacity), since some users want the grid but not the text, or neither. */
  showAxisLabels: boolean
  /** Numeric combined G-force readout ("1.4G") in a header strip above the diagram. */
  showValueReadout: boolean
  valueColor: string
  backgroundColor: string
  backgroundOpacity: number
  /** Nominal corner radius (px at the scaleToRect reference size) of the background panel. 0 = square corners. */
  cornerRadius: number
  dotColor: string
  dotRadius: number
  trailColor: string
  /** How far back the fading trail reaches, ms. */
  trailDurationMs: number
  /** Gaussian smoothing window for the current-position dot (the trail itself is always raw/unsmoothed). */
  smoothingMs: number
  /** When true, bypasses auto-calibration for this widget instance using the fields below. */
  useManualAxes: boolean
  verticalAxis: 0 | 1 | 2
  longitudinalAxis: 0 | 1 | 2
  verticalInverted: boolean
  longitudinalInverted: boolean
  lateralInverted: boolean
}

export const DEFAULT_GFORCE_DIAGRAM_STYLE: GForceDiagramStyle = {
  maxG: 2.0,
  ringColor: '#ffffff',
  ringOpacity: 0.18,
  axisLabelColor: '#ffffff',
  showAxisLabels: true,
  showValueReadout: true,
  valueColor: '#ffffff',
  backgroundColor: '#0a0a10',
  backgroundOpacity: 0.72,
  cornerRadius: 12,
  dotColor: '#ff3b30',
  dotRadius: 7,
  trailColor: '#ff3b30',
  trailDurationMs: 3000,
  smoothingMs: 150,
  useManualAxes: false,
  verticalAxis: 0,
  longitudinalAxis: 2,
  verticalInverted: false,
  longitudinalInverted: false,
  lateralInverted: false
}

export interface DrawGForceDiagramOptions {
  rect: Rect
  style: GForceDiagramStyle
  reading: GForceReading
  /** Precomputed once per frame by the caller (WidgetCanvas.tsx/frameRenderer.ts), raw/unsmoothed. */
  history: GForceHistoryPoint[]
  /** Current cts -- used to fade the trail by each point's own age. */
  cts: number
  hasImuData: boolean
  fontFamily?: string
  /** Pre-rendered static grid/background layer supplied by the headless export renderer. */
  staticLayer?: StaticWidgetLayer | null
}

const RING_COUNT = 4

function drawGForceBackground(ctx: Canvas2DLike, rect: Rect, style: GForceDiagramStyle): void {
  if (style.backgroundOpacity <= 0) return
  ctx.save()
  ctx.globalAlpha = style.backgroundOpacity
  ctx.fillStyle = style.backgroundColor
  fillRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, scaleToRect(style.cornerRadius, rect))
  ctx.restore()
}

function drawNoImuMessage(ctx: Canvas2DLike, rect: Rect, style: GForceDiagramStyle, fontFamily?: string): void {
  const fontStack = resolveFontStack(fontFamily, 'bold')
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const text = 'No accelerometer data'
  fitFontSizePx(ctx, text, rect.w * 0.85, rect.h * 0.1, '600', fontStack)
  drawOutlinedText(ctx, text, rect.x + rect.w / 2, rect.y + rect.h / 2, style.axisLabelColor, scaleToRect(1.5, rect), '#000000')
  ctx.restore()
}

function drawGForceGridAndLabels(ctx: Canvas2DLike, rect: Rect, style: GForceDiagramStyle, fontFamily?: string): void {
  const fontStack = resolveFontStack(fontFamily, 'bold')
  const cx = rect.x + rect.w / 2

  // Reserved header strip for the numeric readout -- the ring diagram fills whatever's left below
  // it, same "value area carved out of the top" layout RollAngle already uses.
  const valueAreaH = style.showValueReadout ? rect.h * 0.22 : 0
  const diagramTop = rect.y + valueAreaH
  const diagramH = rect.h - valueAreaH
  const cy = diagramTop + diagramH / 2
  const radiusPx = Math.min(rect.w, diagramH) * 0.42

  if (style.ringOpacity > 0) {
    ctx.save()
    ctx.globalAlpha = style.ringOpacity
    ctx.strokeStyle = style.ringColor
    ctx.lineWidth = Math.max(1, scaleToRect(1, rect))
    for (let i = 1; i <= RING_COUNT; i++) {
      const r = (radiusPx * i) / RING_COUNT
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.moveTo(cx - radiusPx, cy)
    ctx.lineTo(cx + radiusPx, cy)
    ctx.moveTo(cx, cy - radiusPx)
    ctx.lineTo(cx, cy + radiusPx)
    ctx.stroke()
    ctx.restore()
  }

  if (style.showAxisLabels) {
    ctx.save()
    ctx.globalAlpha = 1
    ctx.fillStyle = style.axisLabelColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const labelSize = Math.max(8, Math.round(diagramH * 0.05))
    ctx.font = `600 ${labelSize}px ${fontStack}`
    ctx.fillText('ACCEL', cx, cy - radiusPx - labelSize * 0.8)
    ctx.fillText('BRAKE', cx, cy + radiusPx + labelSize * 0.8)
    ctx.textAlign = 'left'
    ctx.fillText('LEFT', rect.x + 4, cy)
    ctx.textAlign = 'right'
    ctx.fillText('RIGHT', rect.x + rect.w - 4, cy)
    ctx.restore()
  }
}

/** Draws the G-force background, grid, labels, or no-IMU message into a local cache canvas. */
export function drawGForceStaticLayer(ctx: Canvas2DLike, rect: Rect, style: GForceDiagramStyle, hasImuData: boolean, fontFamily?: string): void {
  drawGForceBackground(ctx, rect, style)
  if (hasImuData) drawGForceGridAndLabels(ctx, rect, style, fontFamily)
  else drawNoImuMessage(ctx, rect, style, fontFamily)
}

function drawGForceDynamicContent(
  ctx: Canvas2DLike,
  rect: Rect,
  style: GForceDiagramStyle,
  reading: GForceReading,
  history: GForceHistoryPoint[],
  cts: number,
  fontFamily?: string
): void {
  const fontStack = resolveFontStack(fontFamily, 'bold')
  const cx = rect.x + rect.w / 2
  const valueAreaH = style.showValueReadout ? rect.h * 0.22 : 0
  const diagramTop = rect.y + valueAreaH
  const diagramH = rect.h - valueAreaH
  const cy = diagramTop + diagramH / 2

  if (style.showValueReadout) {
    const combinedG = Math.sqrt(reading.lateralG * reading.lateralG + reading.longitudinalG * reading.longitudinalG)
    const valueText = `${combinedG.toFixed(1)}G`
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    fitFontSizePx(ctx, '0.0G', rect.w * 0.6, valueAreaH * 0.7, '700', fontStack)
    drawOutlinedText(ctx, valueText, cx, rect.y + valueAreaH / 2, style.valueColor, scaleToRect(2, rect), '#000000')
    ctx.restore()
  }

  const radiusPx = Math.min(rect.w, diagramH) * 0.42
  const pxPerG = radiusPx / Math.max(0.1, style.maxG)
  const toScreen = (lateralG: number, longitudinalG: number): { x: number; y: number } => ({
    x: cx + lateralG * pxPerG,
    y: cy - longitudinalG * pxPerG
  })

  if (style.trailDurationMs > 0) {
    ctx.save()
    for (const point of history) {
      const age = cts - point.cts
      if (age < 0 || age > style.trailDurationMs) continue
      const fade = 1 - age / style.trailDurationMs
      const p = toScreen(point.lateralG, point.longitudinalG)
      ctx.globalAlpha = fade * 0.55
      ctx.fillStyle = style.trailColor
      ctx.beginPath()
      ctx.arc(p.x, p.y, scaleToRect(style.dotRadius * 0.45, rect), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  const dotRadius = scaleToRect(style.dotRadius, rect)
  const dot = toScreen(reading.lateralG, reading.longitudinalG)
  ctx.save()
  ctx.globalAlpha = 1
  ctx.shadowBlur = dotRadius * 1.5
  ctx.shadowColor = style.dotColor
  ctx.fillStyle = style.dotColor
  ctx.beginPath()
  ctx.arc(dot.x, dot.y, dotRadius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Lateral G (cornering) vs. longitudinal G (braking/accelerating) scatter -- a classic friction
 * circle. The current reading is a highlighted dot; a fading trail of recent raw readings (not
 * smoothed, unlike the dot itself -- a real friction circle is a scatter, not a smooth curve) shows
 * the car's recent grip usage sweeping around the circle. Acceleration plots up, braking plots down;
 * lateral sign follows the session's calibrated axis mapping (see shared/telemetry/imuCalibration.ts) --
 * flip `lateralInverted` in the property panel if left/right reads backwards for your footage.
 * A numeric combined-G readout (magnitude of the two axes, sqrt(lateral^2 + longitudinal^2)) sits in
 * its own header strip above the diagram when showValueReadout is on -- the diagram alone only shows
 * *where* on the circle you are, not the actual G number.
 */
export function drawGForceDiagram(ctx: Canvas2DLike, options: DrawGForceDiagramOptions): void {
  const { rect, style, reading, history, cts, hasImuData, fontFamily, staticLayer } = options

  if (staticLayer) drawStaticWidgetLayer(ctx, rect, staticLayer)
  else drawGForceStaticLayer(ctx, rect, style, hasImuData, fontFamily)

  if (hasImuData) drawGForceDynamicContent(ctx, rect, style, reading, history, cts, fontFamily)
}
