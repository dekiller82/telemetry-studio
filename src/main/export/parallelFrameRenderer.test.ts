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
  it.each([2, 3, 4] as const)('forwards lap detection settings and manual crossings to all %i workers', async (workerCount) => {
    const configured = { ...data, startFinishRadiusM: 6, ignoredCrossings: { '1': true }, crossingAdjustmentsMs: { '2': 40 } }
    const source = await createParallelFrameRenderer(configured, undefined, workerCount)
    expect(workers()).toHaveLength(workerCount)
    for (const worker of workers()) {
      expect(worker.workerData.startFinishRadiusM).toBe(6)
      expect(worker.workerData.ignoredCrossings).toEqual({ '1': true })
      expect(worker.workerData.crossingAdjustmentsMs).toEqual({ '2': 40 })
    }
    await source.close()
  })

  it.each([2, 3, 4] as const)('bounds %i workers and preserves frame identities when replies arrive backwards', async (workerCount) => {
    const source = await createParallelFrameRenderer(data, undefined, workerCount)
    expect(source.workerCount).toBe(workerCount)
    expect(source.prefetchCount).toBe(workerCount)
    expect(workers()).toHaveLength(workerCount)

    const frames = Array.from({ length: workerCount }, (_, index) => source.renderFrame(index, index * 20, index * 20))
    expect(workers().every(worker => worker.requests.length === 1)).toBe(true)
    await expect(source.renderFrame(workerCount, 60, 60)).rejects.toThrow('still busy')
    for (let index = workerCount - 1; index >= 0; index--) {
      workers()[index].emit('message', { kind: 'frame', index, pixels: Uint8Array.of(index), renderMs: 2 })
    }
    expect((await Promise.all(frames)).map(frame => frame.pixels[0])).toEqual(Array.from({ length: workerCount }, (_, index) => index))

    const next = source.renderFrame(workerCount, 60, 60)
    expect(workers()[0].requests).toHaveLength(2)
    workers()[0].emit('message', { kind: 'frame', index: workerCount, pixels: Uint8Array.of(workerCount), renderMs: 4 })
    expect((await next).pixels[0]).toBe(workerCount)
    await source.close()
    expect(workers().every((worker) => worker.terminated)).toBe(true)
  })

  it.each([2, 3, 4] as const)('rejects all pending frames and terminates %i workers on cancellation', async (workerCount) => {
    const controller = new AbortController()
    const source = await createParallelFrameRenderer(data, controller.signal, workerCount)
    const rejected = Array.from({ length: workerCount }, (_, index) => expect(source.renderFrame(index, index * 20, index * 20)).rejects.toThrow('Export cancelled'))
    controller.abort()
    await Promise.all(rejected)
    await source.close()
    expect(workers().every((worker) => worker.terminated)).toBe(true)
  })

  it.each([-1, 0, 1, 5, 4.5, Infinity, NaN])('rejects unsupported parallel worker count %s before allocating workers', async count => {
    await expect(createParallelFrameRenderer(data, undefined, count as 2)).rejects.toThrow('two, three or four')
    expect(workers()).toHaveLength(0)
  })

  it.each([2, 3, 4] as const)('propagates a worker failure to all %i pending frames', async (workerCount) => {
    const source = await createParallelFrameRenderer(data, undefined, workerCount)
    const rejected = Array.from({ length: workerCount }, (_, index) => expect(source.renderFrame(index, index * 20, index * 20)).rejects.toThrow('worker failed'))
    workers()[0].emit('error', new Error('worker failed'))
    await Promise.all(rejected)
    await source.close()
    expect(workers().every(worker => worker.terminated && worker.terminationCalls === 1)).toBe(true)
    await expect(source.renderFrame(workerCount, 60, 60)).rejects.toThrow('worker failed')
  })

  it.each([['cancel', 2], ['close', 2], ['cancel', 3], ['close', 3], ['cancel', 4], ['close', 4]] as const)('waits for every exit after %s with %i workers and repeated close calls', async (action, workerCount) => {
    const controller = new AbortController()
    const source = await createParallelFrameRenderer(data, controller.signal, workerCount)
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
    expect(workers().map((worker) => worker.terminationCalls)).toEqual(Array(workerCount).fill(1))

    for (let index = 0; index < workerCount - 1; index++) finishTermination[index]()
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).toEqual([])

    finishTermination[workerCount - 1]()
    await Promise.all([firstClose, secondClose])
    expect(completed).toEqual(['first', 'second'])
    expect(workers().map((worker) => worker.terminationCalls)).toEqual(Array(workerCount).fill(1))
  })
})
