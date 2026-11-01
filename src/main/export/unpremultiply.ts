/**
 * Converts @napi-rs/canvas's premultiplied RGBA to straight alpha for consumers that need it.
 * The normal export path sends premultiplied pixels to FFmpeg's matching overlay alpha mode,
 * avoiding this full-frame conversion. Mutates `buffer` in place.
 */
export function unpremultiplyRgbaInPlace(buffer: Buffer | Uint8Array): void {
  for (let i = 0; i < buffer.length; i += 4) {
    const a = buffer[i + 3]
    if (a === 0 || a === 255) continue
    const factor = 255 / a
    buffer[i] = Math.min(255, Math.round(buffer[i] * factor))
    buffer[i + 1] = Math.min(255, Math.round(buffer[i + 1] * factor))
    buffer[i + 2] = Math.min(255, Math.round(buffer[i + 2] * factor))
  }
}
