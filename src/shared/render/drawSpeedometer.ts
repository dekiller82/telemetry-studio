import { convertSpeed, speedUnitLabel, type SpeedUnit } from '../units'
import { DEFAULT_SPEED_SMOOTHING_MS } from '../telemetry/sampleAt'
import { resolveFontStack } from './fonts'
import { drawOutlinedText, drawStaticWidgetLayer, fillRoundedRect, scaleToRect, type Canvas2DLike, type StaticWidgetLayer, type Rect } from './canvas2d'

export interface SpeedometerStyle {
  unit: SpeedUnit
  /** Gaussian smoothing window in ms fed to TelemetrySampler.speedAt to damp GPS jitter on the needle/readout. */
  smoothingMs: number
  /** Gauge scale bounds, in the selected display unit. Ignored by the digital readout. */
  min: number
  max: number
  color: string
  accentColor: string
  showUnit: boolean
  /** 0 disables the outline. */
  textOutlineWidth: number
  textOutlineColor: string
  /** Panel background. Only drawn by the digital readout -- the analog gauge already has its own
   *  circular dial as a visual background, a rectangular panel behind it would fight that look. */
  backgroundColor: string
  backgroundOpacity: number
  /** Nominal corner radius (px at the scaleToRect reference size) of the background panel. 0 = square corners. */
  cornerRadius: number
}

export const DEFAULT_SPEEDOMETER_STYLE: SpeedometerStyle = {
  unit: 'kmh',
  smoothingMs: DEFAULT_SPEED_SMOOTHING_MS,
  min: 0,
  max: 140,
  color: '#ffffff',
  accentColor: '#ff3b30',
  showUnit: true,
  textOutlineWidth: 2,
  textOutlineColor: '#000000',
  backgroundColor: '#0a0a10',
  backgroundOpacity: 0.72,
  cornerRadius: 12
}

export interface DrawSpeedometerOptions {
  rect: Rect
  speedMps: number
  style: SpeedometerStyle
  fontFamily?: string
  /** Pre-rendered static dial/panel layer supplied by the headless export renderer. */
  staticLayer?: StaticWidgetLayer | null
}

function drawSpeedometerDigitalBackground(ctx: Canvas2DLike, rect: Rect, style: SpeedometerStyle): void {
  if (style.backgroundOpacity > 0) {
    ctx.save()
    ctx.globalAlpha = style.backgroundOpacity
    ctx.fillStyle = style.backgroundColor
    fillRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, scaleToRect(style.cornerRadius, rect))
    ctx.restore()
  }
}

/** Draws only the speedometer digital panel background into a local cache canvas. */
export function drawSpeedometerDigitalStaticLayer(ctx: Canvas2DLike, rect: Rect, style: SpeedometerStyle): void {
  drawSpeedometerDigitalBackground(ctx, rect, style)
}

function drawSpeedometerDigitalValue(ctx: Canvas2DLike, rect: Rect, speedMps: number, style: SpeedometerStyle, fontFamily?: string): void {
  const fontStack = resolveFontStack(fontFamily, 'bold')
  const value = convertSpeed(speedMps, style.unit)
  const cx = rect.x + rect.w / 2
  const outlineWidth = scaleToRect(style.textOutlineWidth, rect)

  // Center the value+unit block as a whole in the panel instead of anchoring the value near the
  // top and the unit at a fixed offset from it -- the old fixed offsets pushed the unit label right
  // to the bottom edge of the background box on shorter panels.
  const valueFontSize = style.showUnit ? rect.h * 0.5 : rect.h * 0.58
  const unitFontSize = rect.h * 0.16
  const unitGap = rect.h * 0.08
  // Digits/uppercase letters in this font have no descenders, so their visible glyph box runs from
  // the baseline up to roughly capHeightRatio * fontSize -- used to center the whole text block by
  // its actual ink, not by font-size boxes that include unused descender space.
  const CAP_HEIGHT_RATIO = 0.72
  const valueCapHeight = valueFontSize * CAP_HEIGHT_RATIO
  const unitCapHeight = unitFontSize * CAP_HEIGHT_RATIO
  const blockHeight = valueCapHeight + (style.showUnit ? unitGap + unitCapHeight : 0)
  const blockTop = rect.y + (rect.h - blockHeight) / 2
  const valueBaselineY = blockTop + valueCapHeight

  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 ${Math.round(valueFontSize)}px ${fontStack}`
  drawOutlinedText(ctx, Math.round(value).toString(), cx, valueBaselineY, style.color, outlineWidth, style.textOutlineColor)

  if (style.showUnit) {
    ctx.font = `600 ${Math.round(unitFontSize)}px ${fontStack}`
    drawOutlinedText(ctx, speedUnitLabel(style.unit), cx, valueBaselineY + unitGap + unitCapHeight, style.accentColor, outlineWidth, style.textOutlineColor)
  }
  ctx.restore()
}

export function drawSpeedometerDigital(ctx: Canvas2DLike, options: DrawSpeedometerOptions): void {
  const { rect, speedMps, style, fontFamily, staticLayer } = options
  if (staticLayer) drawStaticWidgetLayer(ctx, rect, staticLayer)
  else drawSpeedometerDigitalBackground(ctx, rect, style)
  drawSpeedometerDigitalValue(ctx, rect, speedMps, style, fontFamily)
}

const GAUGE_START_ANGLE = Math.PI * 0.75
const GAUGE_END_ANGLE = Math.PI * 2.25
const GAUGE_SWEEP = GAUGE_END_ANGLE - GAUGE_START_ANGLE
// Major (labeled) ticks land on a "nice" round step (1/2/5/10x a power of ten) instead of splitting
// the range into a fixed number of equal fractions -- an arbitrary min/max would otherwise label
// ticks with ugly fractional values (e.g. a 0-140 range split 9 ways labels "0, 16, 31, 47...").
const TARGET_MAJOR_TICKS = 9
// Unlabeled minor ticks between each pair of major ticks, purely decorative reference marks.
const MINOR_SUBDIVISIONS = 5

function niceTickStep(span: number, targetCount: number): number {
  if (span <= 0) return 1
  const roughStep = span / targetCount
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const residual = roughStep / magnitude
  const niceResidual = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1
  return niceResidual * magnitude
}

function drawSpeedometerAnalogLabels(ctx: Canvas2DLike, rect: Rect, style: SpeedometerStyle, fontFamily?: string): void {
  const fontStack = resolveFontStack(fontFamily, 'bold')
  const span = style.max - style.min || 1
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const radius = (Math.min(rect.w, rect.h) / 2) * 0.74
  const outlineWidth = scaleToRect(style.textOutlineWidth, rect)
  const majorStep = niceTickStep(span, TARGET_MAJOR_TICKS)
  const tickCount = Math.round(span / (majorStep / MINOR_SUBDIVISIONS))

  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `600 ${Math.round(radius * 0.16)}px ${fontStack}`
  for (let i = 0; i * MINOR_SUBDIVISIONS <= tickCount; i++) {
    const tickValue = style.min + i * majorStep
    const angle = GAUGE_START_ANGLE + ((tickValue - style.min) / span) * GAUGE_SWEEP
    const labelRadius = radius * 1.2
    drawOutlinedText(
      ctx,
      Math.round(tickValue).toString(),
      cx + Math.cos(angle) * labelRadius,
      cy + Math.sin(angle) * labelRadius,
      style.color,
      outlineWidth,
      style.textOutlineColor
    )
  }
  ctx.restore()
}

/** Draws the analog dial's value-independent labels into a local cache canvas. */
export function drawSpeedometerAnalogStaticLayer(ctx: Canvas2DLike, rect: Rect, style: SpeedometerStyle, fontFamily?: string): void {
  drawSpeedometerAnalogLabels(ctx, rect, style, fontFamily)
}

export function drawSpeedometerAnalog(ctx: Canvas2DLike, options: DrawSpeedometerOptions): void {
  const { rect, speedMps, style, fontFamily, staticLayer } = options
  const fontStack = resolveFontStack(fontFamily, 'bold')
  const value = convertSpeed(speedMps, style.unit)
  const span = style.max - style.min || 1
  const clamped = Math.min(style.max, Math.max(style.min, value))
  const ratio = (clamped - style.min) / span
  const needleAngle = GAUGE_START_ANGLE + ratio * GAUGE_SWEEP

  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  // This style prints tick-value labels (e.g. "0".."90") just outside the dial ring, so the ring
  // itself sits further in from the widget's edge than a plain gauge would, to leave room for them.
  const radius = (Math.min(rect.w, rect.h) / 2) * 0.74
  const outlineWidth = scaleToRect(style.textOutlineWidth, rect)

  const majorStep = niceTickStep(span, TARGET_MAJOR_TICKS)
  const minorStep = majorStep / MINOR_SUBDIVISIONS
  const tickCount = Math.round(span / minorStep)

  // Unfilled reference ticks (thin) beyond the current value, and a "buildup" of thicker, rounded
  // accent-color pill segments from zero up to the current value -- the latter is what reads as a
  // filling progress bar rather than just recolored tick marks.
  ctx.save()
  ctx.lineCap = 'round'
  for (let i = 0; i <= tickCount; i++) {
    const tickValue = style.min + i * minorStep
    const angle = GAUGE_START_ANGLE + ((tickValue - style.min) / span) * GAUGE_SWEEP
    const isMajor = i % MINOR_SUBDIVISIONS === 0
    const filled = tickValue <= clamped + 1e-6
    ctx.strokeStyle = filled ? style.accentColor : style.color
    ctx.globalAlpha = filled ? 1 : 0.85
    ctx.lineWidth = filled ? radius * 0.05 : isMajor ? Math.max(1.4, radius * 0.022) : Math.max(1, radius * 0.012)
    const inner = isMajor ? radius * 0.87 : radius * 0.92
    const outer = radius * 1.0
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
    ctx.stroke()
  }
  ctx.restore()

  // Thick white bar marking the current value's exact position, in place of a center needle.
  ctx.save()
  ctx.strokeStyle = style.color
  ctx.lineWidth = Math.max(3, radius * 0.06)
  ctx.lineCap = 'round'
  const tipInner = radius * 0.85
  const tipOuter = radius * 1.03
  ctx.beginPath()
  ctx.moveTo(cx + Math.cos(needleAngle) * tipInner, cy + Math.sin(needleAngle) * tipInner)
  ctx.lineTo(cx + Math.cos(needleAngle) * tipOuter, cy + Math.sin(needleAngle) * tipOuter)
  ctx.stroke()
  ctx.restore()

  // Numeric labels are value-independent and can be composited from a cache. They are drawn here
  // after the dynamic ticks/needle to preserve the original z-order.
  if (staticLayer) drawStaticWidgetLayer(ctx, rect, staticLayer)
  else drawSpeedometerAnalogLabels(ctx, rect, style, fontFamily)

  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 ${Math.round(radius * 0.5)}px ${fontStack}`
  drawOutlinedText(ctx, Math.round(value).toString(), cx, cy + radius * 0.2, style.color, outlineWidth, style.textOutlineColor)

  if (style.showUnit) {
    ctx.font = `600 ${Math.round(radius * 0.18)}px ${fontStack}`
    drawOutlinedText(ctx, speedUnitLabel(style.unit), cx, cy + radius * 0.44, style.accentColor, outlineWidth, style.textOutlineColor)
  }
  ctx.restore()
}
