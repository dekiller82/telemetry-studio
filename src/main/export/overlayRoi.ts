import type { WidgetInstance } from '../../shared/types'

export interface OverlayRoi {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Finds one fixed, conservative overlay rectangle for the whole export. A single rectangle keeps
 * the ffmpeg graph simple and, unlike a per-frame crop, guarantees that the rawvideo input size and
 * overlay offset never change halfway through a file. The margin covers rotated widget corners,
 * text/stroke overflow, and small shadows; invalid geometry deliberately falls back to full-frame.
 */
export function computeOverlayRoi(frameWidth: number, frameHeight: number, widgets: WidgetInstance[]): OverlayRoi {
  const fullFrame = { x: 0, y: 0, width: frameWidth, height: frameHeight }
  if (frameWidth <= 0 || frameHeight <= 0 || widgets.length === 0) return fullFrame

  // The G-force dot and its history are positioned from telemetry values, not from a bounded
  // widget-local coordinate. A large real-world reading or a small maxG can place them well beyond
  // the ring and the widget rectangle. Until ROI calculation receives the session's calibrated IMU
  // bounds, keeping this widget on the full-frame path is the only way to guarantee that export does
  // not clip content that the preview still draws.
  if (widgets.some((widget) => widget.type === 'gForceDiagram')) return fullFrame

  // Window views and full-session ghost/apex markers can draw beyond the widget. A trim-aware
  // overview can do so too: its live dot still interpolates the full sampler, including bracketing
  // fixes outside the trim. Keep those dynamic pixels until their extents are available here.
  if (widgets.some((widget) => widget.type === 'gpsTrack' && (
    widget.style.viewMode === 'window' || widget.style.trimAware || widget.style.showGhost || widget.style.showApexMarkers
  ))) return fullFrame

  // Custom images are width-capped, but an enlarged tall/square image can exceed the widget's
  // height. Fixed padding cannot bound this without the decoded image's aspect ratio.
  if (widgets.some((widget) => widget.type === 'customText' && widget.style.imageDataUrl && (
    !Number.isFinite(widget.style.imageScale) || widget.style.imageScale > 1 || widget.style.imageScale < 0
  ))) return fullFrame

  let minX = frameWidth
  let minY = frameHeight
  let maxX = 0
  let maxY = 0
  const margin = Math.max(32, Math.ceil(Math.min(frameWidth, frameHeight) * 0.04))

  for (const widget of widgets) {
    const values = [widget.x, widget.y, widget.w, widget.h, widget.rotation]
    if (!values.every(Number.isFinite) || widget.w < 0 || widget.h < 0) return fullFrame

    const x = widget.x * frameWidth
    const y = widget.y * frameHeight
    const w = widget.w * frameWidth
    const h = widget.h * frameHeight
    const cx = x + w / 2
    const cy = y + h / 2
    const angle = (widget.rotation * Math.PI) / 180
    const cos = Math.abs(Math.cos(angle))
    const sin = Math.abs(Math.sin(angle))
    const halfW = (w * cos + h * sin) / 2
    const halfH = (w * sin + h * cos) / 2

    minX = Math.min(minX, cx - halfW)
    minY = Math.min(minY, cy - halfH)
    maxX = Math.max(maxX, cx + halfW)
    maxY = Math.max(maxY, cy + halfH)
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return fullFrame

  let x = Math.max(0, Math.floor(minX - margin))
  let y = Math.max(0, Math.floor(minY - margin))
  let right = Math.min(frameWidth, Math.ceil(maxX + margin))
  let bottom = Math.min(frameHeight, Math.ceil(maxY + margin))

  // Keep coordinates and dimensions even when possible. This avoids introducing an odd chroma
  // boundary when the cropped RGBA stream is later composited into yuv420p output.
  x = Math.max(0, x - (x % 2))
  y = Math.max(0, y - (y % 2))
  right = Math.min(frameWidth, right + (right % 2))
  bottom = Math.min(frameHeight, bottom + (bottom % 2))

  let width = right - x
  let height = bottom - y
  if (width % 2 !== 0) {
    if (right < frameWidth) right += 1
    else if (x > 0) {
      x -= 1
      width += 1
    }
  }
  if (height % 2 !== 0) {
    if (bottom < frameHeight) bottom += 1
    else if (y > 0) {
      y -= 1
      height += 1
    }
  }

  width = Math.max(1, Math.min(frameWidth - x, right - x))
  height = Math.max(1, Math.min(frameHeight - y, bottom - y))
  return { x, y, width, height }
}
