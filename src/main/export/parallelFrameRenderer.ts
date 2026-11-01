import { Worker } from 'node:worker_threads'
import type { FrameWorkerData, FrameRequest, FrameResponse } from './frameWorkerProtocol'
import { computeOverlayRoi, type OverlayRoi } from './overlayRoi'
import workerPath from './frameWorker?modulePath'

export interface RenderedFrame {
  pixels: Buffer
  renderMs: number
}

export interface ExportFrameSource {
  roi: OverlayRoi
  workerCount: number
  prefetchCount: number
  renderFrame(index: number, sampleCts: number, elapsedMs: number): Promise<RenderedFrame>
  close(): Promise<void>
}

interface PendingFrame {
  resolve(frame: RenderedFrame): void
  reject(error: Error): void
}

interface WorkerSlot {
  worker: Worker
  busy: boolean
  ready: Promise<void>
  rejectReady(error: Error): void
}

/** Two renderers run independently; only one frame per worker may be outstanding. */
export async function createParallelFrameRenderer(data: FrameWorkerData, signal?: AbortSignal): Promise<ExportFrameSource> {
  const workerCount = 2
  const roi = computeOverlayRoi(data.width, data.height, data.widgets)
  const pending = new Map<number, PendingFrame>()
  const slots: WorkerSlot[] = []
  let failure: Error | null = null
  let closing = false
  let closePromise: Promise<void> | null = null

  const fail = (error: Error): void => {
    if (failure || closing) return
    failure = error
    for (const slot of slots) slot.rejectReady(error)
    for (const frame of pending.values()) frame.reject(error)
    pending.clear()
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    signal?.removeEventListener('abort', onAbort)
    for (const frame of pending.values()) frame.reject(failure ?? new Error('Frame renderer closed'))
    pending.clear()
    // Cancellation starts cleanup before runExport's finally block. Every caller must await the
    // same worker exits, including callers that arrive while termination is already in progress.
    closePromise = Promise.allSettled(slots.map((slot) => slot.worker.terminate())).then(() => undefined)
    return closePromise
  }

  const onAbort = (): void => {
    fail(new Error('Export cancelled'))
    void close()
  }

  try {
    for (let slotIndex = 0; slotIndex < workerCount; slotIndex++) {
      const worker = new Worker(workerPath, { workerData: data })
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      // An initialization error can precede Promise.all below. Keep the rejection observed.
      void ready.catch(() => undefined)
      const slot: WorkerSlot = { worker, busy: false, ready, rejectReady }
      slots.push(slot)
      worker.on('message', (message: FrameResponse) => {
        if (message.kind === 'ready') {
          resolveReady()
        } else if (message.kind === 'error') {
          const error = new Error(message.stack || message.message)
          rejectReady(error)
          fail(error)
        } else if (message.kind === 'frame') {
          slot.busy = false
          const frame = pending.get(message.index)
          if (!frame) return
          pending.delete(message.index)
          frame.resolve({
            pixels: Buffer.from(message.pixels.buffer, message.pixels.byteOffset, message.pixels.byteLength),
            renderMs: message.renderMs
          })
        }
      })
      worker.on('error', (error) => {
        const workerError = error instanceof Error ? error : new Error(String(error))
        rejectReady(workerError)
        fail(workerError)
      })
      worker.on('exit', (code) => {
        if (closing) return
        const error = new Error(`Frame worker exited unexpectedly (code ${code})`)
        rejectReady(error)
        fail(error)
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    await Promise.all(slots.map((slot) => slot.ready))
    if (failure) throw failure

    return {
      roi,
      workerCount,
      prefetchCount: workerCount,
      renderFrame(index, sampleCts, elapsedMs) {
        if (failure) return Promise.reject(failure)
        if (closing) return Promise.reject(new Error('Frame renderer closed'))
        const slot = slots[index % workerCount]
        if (slot.busy) return Promise.reject(new Error(`Frame worker ${index % workerCount} is still busy`))
        slot.busy = true
        return new Promise<RenderedFrame>((resolve, reject) => {
          pending.set(index, { resolve, reject })
          const request: FrameRequest = { kind: 'render', index, sampleCts, elapsedMs }
          try {
            slot.worker.postMessage(request)
          } catch (error) {
            pending.delete(index)
            slot.busy = false
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
