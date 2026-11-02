import { formatBroadcastDelta, formatBroadcastTime, getBroadcastTimingFrame } from '../telemetry/broadcastSectors'
import { drawFixedWidthText, type Canvas2DLike } from './canvas2d'
import { resolveFontStack } from './fonts'
import type { DrawSectorTimerOptions } from './drawSectorTimer'

const COLOURS = { white: '#f5f5f3', pending: '#a4a6a9', green: '#21dc57', yellow: '#ffe132', purple: '#c754ef' }
const TYRES = { S: '#e92d4b', M: '#ffdd37', H: '#f5f5f3', I: '#21c56b', W: '#39a9ff', '': '#f5f5f3' }

/** Independently implemented broadcast design on a 2000 x 704 grid. The same painter is used by
 * preview and export; no HTML capture, per-frame image allocation or real-time animation clock.
 */
export function drawBroadcastSectorTimer(ctx: Canvas2DLike, options: DrawSectorTimerOptions): void {
  const { rect, style, sectorState, headerImage, fontFamily } = options
  const scale = Math.min(rect.w / 2000, rect.h / 704)
  const x = rect.x + (rect.w - 2000 * scale) / 2
  const y = rect.y + (rect.h - 704 * scale) / 2
  const font = resolveFontStack(fontFamily, 'bold')
  const frame = !sectorState?.currentLapExcluded && sectorState?.broadcast
    ? getBroadcastTimingFrame(sectorState.broadcast, style.sectorHoldSeconds ?? 5, style.lapHoldSeconds ?? 3)
    : null
  const fill = (left: number, top: number, width: number, height: number, colour: string): void => {
    ctx.fillStyle = colour
    ctx.fillRect(x + left * scale, y + top * scale, width * scale, height * scale)
  }
  const polygon = (points: number[][], colour: string): void => {
    ctx.fillStyle = colour
    ctx.beginPath()
    points.forEach(([px, py], i) => i ? ctx.lineTo(x + px * scale, y + py * scale) : ctx.moveTo(x + px * scale, y + py * scale))
    ctx.closePath()
    ctx.fill()
  }
  const text = (value: string, cx: number, baseline: number, size: number, colour: string, maxWidth: number, numeric = false, align: 'center' | 'left' = 'center', widthScale = 1, fontStack = font): void => {
    ctx.font = `700 ${size * scale}px ${fontStack}`
    // Size against a stable numeric reference so a running clock doesn't breathe between digits.
    const measured = ctx.measureText(numeric ? (value.startsWith('+') || value.startsWith('-') ? '+88.888' : '8:88.888') : value).width
    const compression = Math.min(widthScale, maxWidth * scale / Math.max(1, measured))
    ctx.save()
    if (ctx.scale) {
      ctx.translate(x + cx * scale, y + baseline * scale)
      ctx.scale(compression, 1)
    } else ctx.font = `700 ${size * scale * compression}px ${fontStack}`
    const tx = ctx.scale ? 0 : x + cx * scale
    const ty = ctx.scale ? 0 : y + baseline * scale
    ctx.textAlign = align
    ctx.textBaseline = 'alphabetic'
    if (numeric) drawFixedWidthText(ctx, value, tx, ty, colour, 0, colour, font.includes('"Formula1 ') ? size * scale * 0.4 : 0)
    else { ctx.fillStyle = colour; ctx.fillText(value, tx, ty) }
    ctx.restore()
  }
  ctx.save()
  // One continuous fill avoids translucent seams between strips at fractional preview scales.
  const gradient = ctx.createLinearGradient?.(x, y, x, y + 704 * scale)
  gradient?.addColorStop(0, '#1c1e1f')
  gradient?.addColorStop(1, '#131516')
  ctx.fillStyle = gradient ?? '#181a1b'
  ctx.fillRect(x, y, 2000 * scale, 704 * scale)
  polygon([[128, 0], [2000, 0], [2000, 210], [710, 210]], '#27292b')
  polygon([[1600, 238], [2000, 238], [2000, 660], [1200, 660]], '#1d1f21')
  fill(0, 0, 258, 210, '#101114')
  fill(0, 213, 2000, 24, style.accentColor ?? '#3671c6')
  text(style.positionLabel || '-', 128, 155, 152, COLOURS.white, 180, false, 'center', 0.94, '"Titillium Web", sans-serif')
  if (headerImage && headerImage.width > 0 && headerImage.height > 0) {
    const imageScale = Math.min(164 / headerImage.width, 152 / headerImage.height)
    const w = headerImage.width * imageScale, h = headerImage.height * imageScale
    ctx.drawImage(headerImage, x + (390 - w / 2) * scale, y + (104 - h / 2) * scale, w * scale, h * scale)
  } else text(style.teamLabel ?? '', 390, 144, 108, COLOURS.white, 164)
  text(style.driverName || 'DRIVER', 530, 153, 134, COLOURS.white, 1240, false, 'left')
  text(style.tyre ?? '', 1900, 153, 132, TYRES[style.tyre ?? ''], 130)

  const mix = frame?.resultMix ?? 0
  const withReference = frame?.referenceMs != null
  const referenceMix = frame?.referenceMix ?? 0
  const clockX = 1024 + (488 - 1024) * referenceMix
  // Clip the vertical clock/result slide to the timing band, as in a broadcast timing window.
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x, y + 276 * scale)
  ctx.lineTo(x + 2000 * scale, y + 276 * scale)
  ctx.lineTo(x + 2000 * scale, y + 552 * scale)
  ctx.lineTo(x, y + 552 * scale)
  ctx.closePath()
  ctx.clip?.()
  const baseAlpha = ctx.globalAlpha
  if (sectorState?.currentLapExcluded) text('LAP EXCLUDED', 1024, 470, 168, COLOURS.pending, 1740)
  if (mix < 1 && !sectorState?.currentLapExcluded) {
    const clockMs = frame?.finished && !frame.resultLeaving && frame.resultMs !== null ? frame.resultMs : frame?.elapsedMs
    text(clockMs !== undefined ? formatBroadcastTime(clockMs, true) : '--:--.-', clockX, 470 + 276 * mix, 202, COLOURS.white, withReference ? 900 : 1540, true, 'center', 0.842)
  }
  if (frame && frame.resultMs !== null && mix > 0) {
    const finishMix = frame.deltaMs !== null ? frame.finishTimeMix : 0
    const result = frame.deltaMs !== null ? formatBroadcastDelta(frame.deltaMs) : formatBroadcastTime(frame.resultMs)
    const colour = frame.deltaMs !== null ? frame.deltaMs < 0 ? COLOURS.green : COLOURS.yellow : COLOURS.white
    if (finishMix < 1) text(result, withReference ? 488 : 1024, 470 + 276 * (mix - 1 - finishMix), 202, colour, withReference ? 900 : 1540, true, 'center', 0.842)
    if (finishMix > 0) text(formatBroadcastTime(frame.resultMs), 1024, 470 + 276 * (mix - finishMix), 202, COLOURS.white, 1540, true, 'center', 0.842)
  }
  if (frame && withReference) {
    ctx.globalAlpha = baseAlpha * referenceMix * (1 - frame.finishTimeMix)
    const panelX = 1510 + 400 * (1 - referenceMix)
    text(formatBroadcastTime(frame.referenceMs!), panelX, 393, 116, COLOURS.white, 730, true, 'center', 0.88)
    text(style.driverName || 'DRIVER', panelX, 502, 94, '#b7b8ba', 730)
  }
  ctx.restore()
  ctx.globalAlpha = baseAlpha
  for (let i = 0; i < 3; i++) {
    const colour = COLOURS[frame?.colours[i] ?? 'pending']
    const active = frame?.checkpoint === i + 1 && mix > 0.5
    text(active ? `SECTOR ${i + 1}` : `S${i + 1}`, (i + 0.5) * 2000 / 3, 646, 92, colour, 640)
    fill(i * 2000 / 3, 672, 2000 / 3, 28, colour)
  }
  ctx.restore()
}
