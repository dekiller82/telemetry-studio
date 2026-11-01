/**
 * Minimal structural subset of CanvasRenderingContext2D. Draw functions in this module are
 * framework-agnostic: the same code runs against a DOM `<canvas>` context in the live preview
 * and against `@napi-rs/canvas`'s context during headless export, guaranteeing WYSIWYG.
 */
export interface Canvas2DLike {
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean): void
  stroke(): void
  fill(): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  drawImage(image: CanvasImageLike, dx: number, dy: number, dw: number, dh: number): void
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  translate(x: number, y: number): void
  rotate(angleRadians: number): void
  strokeStyle: string
  fillStyle: string
  lineWidth: number
  lineCap: string
  lineJoin: string
  shadowBlur: number
  shadowColor: string
  globalAlpha: number
  font: string
  textAlign: string
  textBaseline: string
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Minimal structural shape satisfied by both `HTMLImageElement` (live preview) and `@napi-rs/canvas`'s
 * `Image` class (export) -- deliberately opaque beyond width/height so this module never imports
 * either concrete type and stays framework-agnostic like everything else here. Callers load/decode
 * the real image ahead of time (loading is inherently async; drawing is not) and pass the resolved
 * handle in.
 */
export interface CanvasImageLike {
  width: number
  height: number
}

/** An unscaled raster layer with padding and the original widget's fractional pixel phase. */
export interface StaticWidgetLayer {
  image: CanvasImageLike
  offsetX: number
  offsetY: number
}

export function drawStaticWidgetLayer(ctx: Canvas2DLike, rect: Rect, layer: StaticWidgetLayer): void {
  ctx.drawImage(layer.image, rect.x + layer.offsetX, rect.y + layer.offsetY, layer.image.width, layer.image.height)
}

/**
 * Fills a rounded-rect panel using only primitives already in Canvas2DLike (no native `roundRect`
 * in this minimal interface) -- quadraticCurveTo with the actual corner point as control point
 * approximates a circular corner closely enough for a flat UI background at typical radii. Used by
 * every widget's background panel instead of a plain fillRect, so panels get soft corners instead
 * of hard rectangular ones.
 */
export function fillRoundedRect(ctx: Canvas2DLike, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  if (r === 0) {
    ctx.fillRect(x, y, w, h)
    return
  }
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  ctx.fill()
}

/**
 * Draws text with an optional outline (stroked first, then filled on top) -- used by every
 * text-bearing widget so on-screen numbers/labels stay readable over any video background.
 * `outlineWidth` is the *visible* outline thickness; canvas strokes are centered on the path, so
 * the actual lineWidth used is doubled to compensate.
 */
export function drawOutlinedText(
  ctx: Canvas2DLike,
  text: string,
  x: number,
  y: number,
  fillColor: string,
  outlineWidth: number,
  outlineColor: string
): void {
  if (outlineWidth > 0) {
    ctx.strokeStyle = outlineColor
    ctx.lineWidth = outlineWidth * 2
    ctx.lineJoin = 'round'
    ctx.strokeText(text, x, y)
  }
  ctx.fillStyle = fillColor
  ctx.fillText(text, x, y)
}

/**
 * Draws numeric text with every digit (0-9) occupying the same fixed-width slot (the widest
 * digit's own measured width, at the current `ctx.font`) instead of each digit's natural
 * proportional width -- otherwise a ticking value visibly shifts left/right frame to frame as its
 * specific digits change (e.g. a "1" is narrower than a "8" in most fonts), even though the whole
 * string is nominally centered on `cx`. Non-digit characters (":", ".", "-") keep their natural
 * width. Centered as a whole on `cx`, same outline+fill treatment as drawOutlinedText.
 */
export function drawFixedWidthText(
  ctx: Canvas2DLike,
  text: string,
  cx: number,
  y: number,
  fillColor: string,
  outlineWidth: number,
  outlineColor: string
): void {
  let digitSlotWidth = 0
  for (let d = 0; d <= 9; d++) {
    digitSlotWidth = Math.max(digitSlotWidth, ctx.measureText(String(d)).width)
  }

  const chars = text.split('')
  const widths = chars.map((c) => (c >= '0' && c <= '9' ? digitSlotWidth : ctx.measureText(c).width))
  const totalWidth = widths.reduce((a, b) => a + b, 0)

  const savedAlign = ctx.textAlign
  ctx.textAlign = 'center'
  let x = cx - totalWidth / 2
  for (let i = 0; i < chars.length; i++) {
    const slotCx = x + widths[i] / 2
    if (outlineWidth > 0) {
      ctx.strokeStyle = outlineColor
      ctx.lineWidth = outlineWidth * 2
      ctx.lineJoin = 'round'
      ctx.strokeText(chars[i], slotCx, y)
    }
    ctx.fillStyle = fillColor
    ctx.fillText(chars[i], slotCx, y)
    x += widths[i]
  }
  ctx.textAlign = savedAlign
}

/**
 * Reference "design" box size (px) that nominal stroke-width/radius style values (GPS line width,
 * dot radius, text outline width) were tuned against. A widget's `rect` is only a *fraction* of
 * the frame -- its absolute pixel size varies hugely between a small on-screen preview canvas and
 * a full native-resolution export frame, even though the fraction (and so the drawn *shape*,
 * which already scales via a uniform transform) is identical. Fixed pixel constants applied
 * without this scaling look chunky in a small preview and nearly invisible in a 4K export --
 * scaling every nominal value by `min(rect.w, rect.h) / REFERENCE_DIMENSION_PX` keeps them at a
 * consistent visual proportion of the widget box regardless of actual render resolution.
 */
const REFERENCE_DIMENSION_PX = 400

export function scaleToRect(nominalPx: number, rect: Rect): number {
  return nominalPx * (Math.min(rect.w, rect.h) / REFERENCE_DIMENSION_PX)
}

/**
 * Linearly interpolates between two `#rrggbb` hex colors at `t` (clamped to [0, 1]). Used by the
 * GPS Track widget's speed/braking color modes to shade track segments -- framework-agnostic like
 * everything else here, no canvas gradient object needed since each segment is a flat single color.
 */
export function lerpColor(hexA: string, hexB: string, t: number): string {
  const clamped = Math.min(1, Math.max(0, t))
  const a = parseInt(hexA.slice(1), 16)
  const b = parseInt(hexB.slice(1), 16)
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  const r = Math.round(ar + (br - ar) * clamped)
  const g = Math.round(ag + (bg - ag) * clamped)
  const bl = Math.round(ab + (bb - ab) * clamped)
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`
}

/**
 * Sets `ctx.font` to the largest size (up to `maxFontSizePx`) that keeps `text` within
 * `maxWidth`. Formatted time strings ("00:08.72") are wide relative to their height, so sizing
 * purely off widget height can overflow a widget that's been resized narrower than it is tall.
 * Returns the resolved size in case the caller needs it.
 */
export function fitFontSizePx(
  ctx: Canvas2DLike,
  text: string,
  maxWidth: number,
  maxFontSizePx: number,
  fontWeight: string,
  fontStack: string
): number {
  ctx.font = `${fontWeight} ${Math.round(maxFontSizePx)}px ${fontStack}`
  const width = ctx.measureText(text).width
  if (width <= maxWidth || width <= 0) return maxFontSizePx

  const fitted = Math.max(8, Math.floor(maxFontSizePx * (maxWidth / width)))
  ctx.font = `${fontWeight} ${fitted}px ${fontStack}`
  return fitted
}
