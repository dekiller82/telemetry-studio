import { formatTime } from '../format'
import { drawBroadcastSectorTimer } from './drawBroadcastSectorTimer'
import type { SectorState } from '../telemetry/sectors'
import { resolveFontStack } from './fonts'
import { drawFixedWidthText, drawOutlinedText, fillRoundedRect, fitFontSizePx, scaleToRect, type Canvas2DLike, type Rect } from './canvas2d'

export interface SectorTimerStyle {
  layout?: 'classic' | 'broadcast'
  driverName?: string
  positionLabel?: string
  tyre?: 'S' | 'M' | 'H' | 'I' | 'W' | ''
  teamLabel?: string
  accentColor?: string
  headerImageDataUrl?: string | null
  sectorHoldSeconds?: number
  lapHoldSeconds?: number
  color: string
  labelColor: string
  /** 0 disables the outline. */
  textOutlineWidth: number
  textOutlineColor: string
  /** Panel background behind the widget. backgroundOpacity 0 hides it entirely. */
  backgroundColor: string
  backgroundOpacity: number
  /** Nominal corner radius (px at the scaleToRect reference size) of the background panel. 0 = square corners. */
  cornerRadius: number
  /** Adds a smaller secondary row below showing the last fully completed lap's own S1/S2/S3. */
  showLastLapRow: boolean
}

export const DEFAULT_SECTOR_TIMER_STYLE: SectorTimerStyle = {
  layout: 'classic',
  driverName: 'DRIVER',
  positionLabel: '-',
  tyre: '',
  teamLabel: '',
  accentColor: '#3671c6',
  headerImageDataUrl: null,
  sectorHoldSeconds: 5,
  lapHoldSeconds: 3,
  color: '#ffffff',
  labelColor: '#ffffff',
  textOutlineWidth: 2,
  textOutlineColor: '#000000',
  backgroundColor: '#0a0a10',
  backgroundOpacity: 0.72,
  cornerRadius: 12,
  showLastLapRow: false
}

export interface DrawSectorTimerOptions {
  headerImage?: import('./canvas2d').CanvasImageLike | null
  rect: Rect
  style: SectorTimerStyle
  sectorState: SectorState | null
  fontFamily?: string
}

/** Conventional "fastest" color (matches the timing tower's fastest-lap purple), used for a sector time that's this session's best for that sector. */
const SECTOR_PURPLE = '#b026ff'

const SECTOR_LABELS = ['S1', 'S2', 'S3'] as const
/** Longest realistic sector-time string -- sized against this fixed reference ONCE, never the
 *  actual (per-frame-changing, while a sector is live) text, so the value display doesn't visibly
 *  jitter in size as different digits cycle through and measure at slightly different widths. */
const VALUE_SIZING_REFERENCE = '00.00.00'

function drawSectorRow(
  ctx: Canvas2DLike,
  rect: Rect,
  rowY: number,
  rowH: number,
  style: SectorTimerStyle,
  outlineWidth: number,
  values: (number | null)[],
  liveSector: 1 | 2 | 3 | null,
  bestFlags: boolean[],
  labelFontFraction: number,
  valueFontFraction: number,
  fontStack: string
): void {
  const colW = rect.w / 3

  for (let i = 0; i < 3; i++) {
    const colX = rect.x + colW * i
    const cx = colX + colW / 2
    const isLive = liveSector === i + 1

    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    fitFontSizePx(ctx, SECTOR_LABELS[i], colW * 0.8, rowH * labelFontFraction, '700', fontStack)
    drawOutlinedText(ctx, SECTOR_LABELS[i], cx, rowY + rowH * 0.32, style.labelColor, outlineWidth, style.textOutlineColor)
    ctx.restore()

    const valueMs = values[i]
    const text = valueMs != null ? formatTime(valueMs, true) : '--.--'
    const color = !isLive && bestFlags[i] ? SECTOR_PURPLE : style.color

    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    // Sized once against a fixed reference string (not the live text) so the value never jitters
    // in size as its digits change; drawn with fixed-width digit slots so it doesn't jitter
    // horizontally either (a centered proportional-width string shifts as digit widths vary).
    fitFontSizePx(ctx, VALUE_SIZING_REFERENCE, colW * 0.88, rowH * valueFontFraction, '700', fontStack)
    drawFixedWidthText(ctx, text, cx, rowY + rowH * 0.82, color, outlineWidth, style.textOutlineColor)
    ctx.restore()
  }
}

/**
 * F1-style three-sector split display: a column per sector showing its label and time, using GPS
 * arc-length to auto-divide each lap into thirds (see shared/telemetry/sectors.ts) -- no manual
 * sector-boundary marking needed beyond the same start/finish point the lap timer already uses.
 * Sectors already passed in the CURRENT (possibly still in-progress) lap show that lap's own time
 * as soon as each completes (not just once the whole lap finishes); the live sector shows a
 * running time; sectors not yet reached show a placeholder. An optional secondary row can show the
 * last *fully completed* lap's own S1/S2/S3 for comparison.
 */
export function drawSectorTimer(ctx: Canvas2DLike, options: DrawSectorTimerOptions): void {
  if (options.style.layout === 'broadcast') {
    drawBroadcastSectorTimer(ctx, options)
    return
  }
  const { rect, style, sectorState, fontFamily } = options
  const fontStack = resolveFontStack(fontFamily, 'bold')

  if (style.backgroundOpacity > 0) {
    ctx.save()
    ctx.globalAlpha = style.backgroundOpacity
    ctx.fillStyle = style.backgroundColor
    fillRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, scaleToRect(style.cornerRadius, rect))
    ctx.restore()
  }

  if (!sectorState) return
  if (sectorState.currentLapExcluded) {
    ctx.save()
    fitFontSizePx(ctx, 'LAP EXCLUDED', rect.w * 0.9, rect.h * 0.25, '700', fontStack)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = style.color
    ctx.fillText('LAP EXCLUDED', rect.x + rect.w / 2, rect.y + rect.h / 2)
    ctx.restore()
    return
  }

  const outlineWidth = scaleToRect(style.textOutlineWidth, rect)
  const showLastLapRow = style.showLastLapRow && sectorState.lastLap !== null

  const mainRect: Rect = showLastLapRow ? { ...rect, h: rect.h * 0.68 } : rect
  const currentValues = [
    sectorState.currentSector > 1 ? sectorState.currentLapS1Ms : sectorState.currentSector === 1 ? sectorState.currentSectorElapsedMs : null,
    sectorState.currentSector > 2 ? sectorState.currentLapS2Ms : sectorState.currentSector === 2 ? sectorState.currentSectorElapsedMs : null,
    sectorState.currentSector === 3 ? sectorState.currentSectorElapsedMs : null
  ]
  const currentBestFlags = [sectorState.isCurrentLapS1Best, sectorState.isCurrentLapS2Best, false]

  drawSectorRow(ctx, mainRect, mainRect.y, mainRect.h, style, outlineWidth, currentValues, sectorState.currentSector, currentBestFlags, 0.24, 0.4, fontStack)

  if (showLastLapRow && sectorState.lastLap) {
    const lastLapRect: Rect = { ...rect, y: rect.y + mainRect.h, h: rect.h - mainRect.h }
    const lastValues = [sectorState.lastLap.s1Ms, sectorState.lastLap.s2Ms, sectorState.lastLap.s3Ms]
    const lastBestFlags = [sectorState.isLastS1Best, sectorState.isLastS2Best, sectorState.isLastS3Best]
    drawSectorRow(ctx, lastLapRect, lastLapRect.y, lastLapRect.h, style, outlineWidth, lastValues, null, lastBestFlags, 0.26, 0.4, fontStack)
  }
}
