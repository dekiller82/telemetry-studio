import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import { createFrameRenderer } from './frameRenderer'
import type { FrameRequest, FrameResponse, FrameWorkerData } from './frameWorkerProtocol'

const port = parentPort
if (!port) throw new Error('Frame worker requires a parent port')

async function start(): Promise<void> {
  const data = workerData as FrameWorkerData
  const sampler = createTelemetrySampler(data.telemetry)
  const renderer = await createFrameRenderer(
    data.width,
    data.height,
    data.widgets,
    sampler,
    data.startFinish,
    data.startFinishRadiusM,
    data.crossingAdjustmentsMs,
    data.ignoredCrossings,
    data.trimEndMs,
    data.trimStartMs,
    data.defaultFontFamily,
    data.assetDirectories
  )
  port!.on('message', (request: FrameRequest) => {
    if (request.kind !== 'render') return
    try {
      const startedAt = performance.now()
      const pixels = renderer.renderFrame(request.sampleCts, request.elapsedMs)
      // Small Buffer.from snapshots can occupy Node's shared, non-transferable allocation pool.
      // Only those tiny frames need a separate ArrayBuffer; large RGBA frames transfer as-is.
      const transferred = pixels.byteLength === pixels.buffer.byteLength
        ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
        : Uint8Array.from(pixels)
      const response: FrameResponse = {
        kind: 'frame',
        index: request.index,
        pixels: transferred,
        renderMs: performance.now() - startedAt
      }
      // The owned Canvas snapshot is transferred, not cloned. The worker never touches it again.
      port!.postMessage(response, [transferred.buffer as ArrayBuffer])
    } catch (error) {
      const failure: FrameResponse = {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
      port!.postMessage(failure)
    }
  })
  const ready: FrameResponse = { kind: 'ready' }
  port!.postMessage(ready)
}

void start().catch((error) => {
  const failure: FrameResponse = {
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }
  port?.postMessage(failure)
})
