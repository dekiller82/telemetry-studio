import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FrameRequest, FrameResponse, FrameWorkerData } from './frameWorkerProtocol'

const mockState = vi.hoisted(() => ({ workers: [] as unknown[] }))

vi.mock('./frameWorker?modulePath', () => ({ default: 'mock-frame-worker.js' }))
vi.mock('node:worker_threads', () => {
  class MockWorker {
    readonly requests: FrameRequest[] = []
    readonly workerData: FrameWorkerData
    terminated = false
    terminationCalls = 0
    termination: Promise<number> | undefined
    private readonly listeners = new Map<string, Array<(value: unknown) => void>>()

    constructor(_path: string, options: { workerData: FrameWorkerData }) {
      this.workerData = options.workerData
      mockState.workers.push(this)
      queueMicrotask(() => this.emit('message', { kind: 'ready' }))
    }

    on(event: string, listener: (value: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, value: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(value)
    }

    postMessage(request: FrameRequest): void {
      this.requests.push(request)
    }

    terminate(): Promise<number> {
      this.terminated = true
      this.terminationCalls++
      return this.termination ?? Promise.resolve(0)
    }
  }

  return { Worker: MockWorker }
})

import { createParallelFrameRenderer } from './parallelFrameRenderer'

interface MockWorkerView {
  workerData: FrameWorkerData
  requests: FrameRequest[]
  terminated: boolean
  terminationCalls: number
  termination: Promise<number> | undefined
  emit(event: string, value: FrameResponse | Error): void
}

function workers(): MockWorkerView[] {
  return mockState.workers as MockWorkerView[]
}

const data: FrameWorkerData = {
  width: 16,
  height: 8,
  widgets: [],
  telemetry: {
    deviceName: 'test', gpsStream: 'GPS5', samples: [], videoDurationMs: 0,
    accel: [], gyro: [], gravity: []
  },
  startFinish: null,
  startFinishRadiusM: 15,
  crossingAdjustmentsMs: {},
  ignoredCrossings: {},
  trimStartMs: 0,
  trimEndMs: 1000,
  defaultFontFamily: 'Formula1',
  assetDirectories: { fonts: 'fonts', icons: 'icons' }
}

beforeEach(() => {
  mockState.workers = []
})

describe('parallel frame renderer', () => {
  it('forwards the same lap detection radius and deleted crossings to both workers', async () => {
    const configured = { ...data, startFinishRadiusM: 6, ignoredCrossings: { '1': true }, crossingAdjustmentsMs: { '2': 40 } }
    const source = await createParallelFrameRenderer(configured)
    for (const worker of workers()) {
      expect(worker.workerData.startFinishRadiusM).toBe(6)
      expect(worker.workerData.ignoredCrossings).toEqual({ '1': true })
      expect(worker.workerData.crossingAdjustmentsMs).toEqual({ '2': 40 })
    }
    await source.close()
  })

  it('bounds work to one outstanding frame per worker and returns the requested frames', async () => {
    const source = await createParallelFrameRenderer(data)
    expect(source.workerCount).toBe(2)
    expect(source.prefetchCount).toBe(2)
    expect(workers()).toHaveLength(2)

    const first = source.renderFrame(0, 0, 0)
    const second = source.renderFrame(1, 20, 20)
    expect(workers()[0].requests).toHaveLength(1)
    expect(workers()[1].requests).toHaveLength(1)
    await expect(source.renderFrame(2, 40, 40)).rejects.toThrow('still busy')

    workers()[1].emit('message', { kind: 'frame', index: 1, pixels: Uint8Array.of(1), renderMs: 2 })
    workers()[0].emit('message', { kind: 'frame', index: 0, pixels: Uint8Array.of(0), renderMs: 3 })
    expect((await first).pixels[0]).toBe(0)
    expect((await second).pixels[0]).toBe(1)

    const third = source.renderFrame(2, 40, 40)
    expect(workers()[0].requests).toHaveLength(2)
    workers()[0].emit('message', { kind: 'frame', index: 2, pixels: Uint8Array.of(2), renderMs: 4 })
    expect((await third).pixels[0]).toBe(2)
    await source.close()
    expect(workers().every((worker) => worker.terminated)).toBe(true)
  })

  it('rejects pending frames and terminates both workers on cancellation', async () => {
    const controller = new AbortController()
    const source = await createParallelFrameRenderer(data, controller.signal)
    const first = source.renderFrame(0, 0, 0)
    const second = source.renderFrame(1, 20, 20)
    const firstRejected = expect(first).rejects.toThrow('Export cancelled')
    const secondRejected = expect(second).rejects.toThrow('Export cancelled')
    controller.abort()
    await Promise.all([firstRejected, secondRejected])
    await source.close()
    expect(workers().every((worker) => worker.terminated)).toBe(true)
  })

  it('propagates an unexpected worker failure to all pending frames', async () => {
    const source = await createParallelFrameRenderer(data)
    const first = source.renderFrame(0, 0, 0)
    const second = source.renderFrame(1, 20, 20)
    const firstRejected = expect(first).rejects.toThrow('worker failed')
    const secondRejected = expect(second).rejects.toThrow('worker failed')
    workers()[0].emit('error', new Error('worker failed'))
    await Promise.all([firstRejected, secondRejected])
    await source.close()
  })

  it.each(['cancel', 'close'] as const)('waits for both worker exits across repeated close calls after %s', async (action) => {
    const controller = new AbortController()
    const source = await createParallelFrameRenderer(data, controller.signal)
    const finishTermination: Array<() => void> = []
    for (const worker of workers()) {
      worker.termination = new Promise<number>((resolve) => finishTermination.push(() => resolve(0)))
    }

    if (action === 'cancel') controller.abort()
    const completed: string[] = []
    const firstClose = source.close().then(() => completed.push('first'))
    const secondClose = source.close().then(() => completed.push('second'))
    await Promise.resolve()
    expect(completed).toEqual([])
    expect(workers().map((worker) => worker.terminationCalls)).toEqual([1, 1])

    finishTermination[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).toEqual([])

    finishTermination[1]()
    await Promise.all([firstClose, secondClose])
    expect(completed).toEqual(['first', 'second'])
    expect(workers().map((worker) => worker.terminationCalls)).toEqual([1, 1])
  })
})
