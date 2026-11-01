import { beforeEach, expect, it, vi } from 'vitest'
import type { FrameWorkerData } from './frameWorkerProtocol'

const state = vi.hoisted(() => ({ postMessage: vi.fn(), on: vi.fn(), createFrameRenderer: vi.fn(), renderFrame: vi.fn() }))
const data: FrameWorkerData = {
  width: 160, height: 90, widgets: [],
  telemetry: { deviceName: 'test', gpsStream: 'GPS5', videoDurationMs: 1000, samples: [], accel: [], gyro: [], gravity: [] },
  startFinish: { lat: 51, lon: -0.1 }, startFinishRadiusM: 6,
  crossingAdjustmentsMs: { '2': 40 }, ignoredCrossings: { '1': true },
  trimStartMs: 200, trimEndMs: 1000, defaultFontFamily: 'Arial',
  assetDirectories: { fonts: 'fonts', icons: 'icons' }
}

vi.mock('node:worker_threads', () => ({
  parentPort: { postMessage: state.postMessage, on: state.on },
  get workerData() { return data }
}))
vi.mock('./frameRenderer', () => ({ createFrameRenderer: state.createFrameRenderer }))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  state.createFrameRenderer.mockResolvedValue({ renderFrame: state.renderFrame })
  await import('./frameWorker')
  await vi.waitFor(() => expect(state.postMessage).toHaveBeenCalledWith({ kind: 'ready' }))
})

it('passes project lap settings and the absolute trim range into the worker renderer', () => {
  expect(state.createFrameRenderer).toHaveBeenCalledWith(
    data.width, data.height, data.widgets, expect.any(Object), data.startFinish,
    data.startFinishRadiusM, data.crossingAdjustmentsMs, data.ignoredCrossings,
    data.trimEndMs, data.trimStartMs, data.defaultFontFamily, data.assetDirectories
  )
})

it('makes tiny pooled snapshots transferable without exposing unrelated pooled bytes', () => {
  const pixels = Buffer.from([1, 2, 3, 4])
  state.renderFrame.mockReturnValue(pixels)
  const onRequest = state.on.mock.calls.find(([event]) => event === 'message')![1]
  onRequest({ kind: 'render', index: 0, sampleCts: 200, elapsedMs: 0 })
  const [response, transferList] = state.postMessage.mock.lastCall!
  expect(response.kind).toBe('frame')
  expect([...response.pixels]).toEqual([1, 2, 3, 4])
  expect(response.pixels.buffer.byteLength).toBe(4)
  expect(transferList).toEqual([response.pixels.buffer])
  expect(response.pixels.buffer).not.toBe(pixels.buffer)
})
