import { createCanvas, type Canvas } from '@napi-rs/canvas'
import type { Canvas2DLike, CanvasImageLike } from '../../shared/render/canvas2d'
import { scaleToRect } from '../../shared/render/canvas2d'
import {
  drawSpeedDistanceGraphLayer, prepareSpeedDistanceGraph,
  type DrawSpeedDistanceGraphOptions, type SpeedDistanceGraphCache
} from '../../shared/render/drawSpeedDistanceGraph'
import type { LapSpeedTrace } from '../../shared/telemetry/speedTrace'

/** Shared by graph widgets in ONE renderer/worker. Oversized graphs use immediate drawing.
 * Two workers explicitly retain at most 32 MiB in these surfaces, independent of export length;
 * native rasterizer temporaries and the main output canvas are outside this pixel budget. */
export class GraphCacheBudget {
  usedBytes = 0
  constructor(readonly maxBytes = 16 * 1024 * 1024) {}
}

function traceValues(trace: LapSpeedTrace | null): number[] {
  if (!trace) return []
  const values = [trace.lapNumber, trace.totalDistanceM]
  for (const point of trace.points) values.push(point.distanceM, point.speedMps)
  return values
}

/** Two reusable widget-sized surfaces: axes/history, and the most recent complete graph. The
 * latter is reused between GPS samples, even though the video frame and other widgets advance.
 * Completed traces are immutable for a renderer's lifetime; live traces are compared by value. */
export class ExportSpeedDistanceGraphCache implements SpeedDistanceGraphCache {
  readonly stats = { referenceRenders: 0, frameRenders: 0, bytes: 0 }
  private reference: Canvas | null = null
  private frame: Canvas | null = null
  private referenceKey = ''
  private referenceTraces: LapSpeedTrace[] = []
  private currentValues: number[] = []

  constructor(private readonly budget: GraphCacheBudget) {}

  draw(ctx: Canvas2DLike, options: DrawSpeedDistanceGraphOptions): boolean {
    const { rect, style } = options
    // A moving window changes the entire plot every sample. Keep the existing path until its
    // own cache has measured value. Rotation is excluded by the caller to preserve pixel phase.
    if (style.viewMode === 'window' || ![rect.x, rect.y, rect.w, rect.h, style.lineWidth].every(Number.isFinite)
      || rect.w <= 0 || rect.h <= 0 || style.lineWidth < 0) return false

    // Include stroke/glow and labels outside the panel. Integer origins retain the fractional
    // pixel phase of the original rect; rounding the rect itself would move text and thin lines.
    const margin = Math.ceil(Math.max(32, scaleToRect(style.lineWidth, rect) * 8, rect.h * 0.18))
    const left = Math.floor(rect.x - margin)
    const top = Math.floor(rect.y - margin)
    const width = Math.ceil(rect.x + rect.w + margin) - left
    const height = Math.ceil(rect.y + rect.h + margin) - top
    const bytes = width * height * 4 * 2
    if (!Number.isSafeInteger(bytes) || bytes > this.budget.maxBytes) return false
    if (this.reference?.width !== width || this.reference.height !== height) {
      if (this.budget.usedBytes - this.stats.bytes + bytes > this.budget.maxBytes) return false
      this.budget.usedBytes += bytes - this.stats.bytes
      this.stats.bytes = bytes
      // Release the previous native surfaces before replacing them (no GC-dependent pixel pool).
      if (this.reference) this.reference.width = 1
      if (this.frame) this.frame.width = 1
      this.reference = createCanvas(width, height)
      this.frame = createCanvas(width, height)
      this.referenceKey = ''
    }
    const reference = this.reference!
    const frame = this.frame!
    const localOptions = { ...options, rect: { ...rect, x: rect.x - left, y: rect.y - top }, cache: undefined }
    const graph = prepareSpeedDistanceGraph(localOptions)
    const references = options.lapTraces.slice(-Math.max(1, style.maxLapsShown))
    const key = JSON.stringify([
      localOptions.rect, style, options.fontFamily,
      graph && [graph.domainStart, graph.domainEnd, graph.minSpeed, graph.maxSpeed]
    ])
    const referenceChanged = key !== this.referenceKey || references.length !== this.referenceTraces.length
      || references.some((trace, index) => trace !== this.referenceTraces[index])
    if (referenceChanged) {
      const referenceCtx = reference.getContext('2d')
      referenceCtx.clearRect(0, 0, width, height)
      drawSpeedDistanceGraphLayer(referenceCtx as unknown as Canvas2DLike, localOptions, graph, 'reference')
      this.referenceKey = key
      this.referenceTraces = references
      this.stats.referenceRenders++
    }
    // Exact values, including intermediate points: equal endpoints/count alone can hide a
    // changed curve after a seek. Only retain one live trace, never one entry per frame/time.
    const values = traceValues(style.showCurrentLap ? options.currentLapTrace : null)
    if (referenceChanged || values.length !== this.currentValues.length || values.some((value, index) => value !== this.currentValues[index])) {
      const frameCtx = frame.getContext('2d')
      frameCtx.clearRect(0, 0, width, height)
      frameCtx.drawImage(reference, 0, 0)
      drawSpeedDistanceGraphLayer(frameCtx as unknown as Canvas2DLike, localOptions, graph, 'current')
      this.currentValues = values
      this.stats.frameRenders++
    }
    ctx.drawImage(frame as unknown as CanvasImageLike, left, top, width, height)
    return true
  }
}
