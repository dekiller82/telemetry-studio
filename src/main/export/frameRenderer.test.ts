import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrossingIgnoreSet, TelemetryData } from '../../shared/types'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import { createWidget } from '../../shared/widgets/defaults'
import { drawWidget } from '../../shared/render/drawWidget'
import { buildColoredGpsTrackCache } from '../../shared/render/drawGpsWidget'
import { createFrameRenderer } from './frameRenderer'

vi.mock('./registerFonts', () => ({ registerExportFonts: vi.fn() }))
vi.mock('./loadIcons', () => ({ loadFastestLapIcon: async () => null }))
vi.mock('../../shared/render/drawWidget', () => ({ drawWidget: vi.fn() }))
vi.mock('../../shared/render/drawGpsWidget', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/render/drawGpsWidget')>(),
  buildColoredGpsTrackCache: vi.fn()
}))

const startFinish = { lat: 51, lon: -0.1 }
const telemetry: TelemetryData = {
  deviceName: 'test', gpsStream: 'GPS5', videoDurationMs: 33000,
  samples: [
    [0, 0.0002], [1000, 0.00009], [2000, 0.0002],
    [15000, 0.0002], [16000, 0.000045], [17000, 0.0002],
    [30000, 0.0002], [31000, 0.00009], [32000, 0.0002]
  ].map(([cts, offset]) => ({ cts, lat: startFinish.lat + offset, lon: startFinish.lon, altitude: 10, speed2D: 10, speed3D: 10 })),
  accel: [], gyro: [], gravity: []
}

beforeEach(() => vi.clearAllMocks())

async function timerRenderer(radius: number, ignored: CrossingIgnoreSet = {}, adjustments = {}) {
  const timer = createWidget('timer')
  if (timer.type !== 'timer') throw new Error('expected timer')
  timer.style.mode = 'laps'
  return createFrameRenderer(640, 360, [timer], createTelemetrySampler(telemetry), startFinish, radius, adjustments, ignored, 33000, 0, 'Arial')
}

describe('frame renderer upstream integration', () => {
  it('reuses the graph cache across frames and preserves immediate drawing for rotated graphs', async () => {
    const graph = createWidget('speedDistanceGraph')
    const rotated = { ...createWidget('speedDistanceGraph'), rotation: 15 }
    const renderer = await createFrameRenderer(640, 360, [graph, rotated], createTelemetrySampler(telemetry), startFinish, 15, {}, {}, 33000, 0, 'Arial')
    renderer.renderFrame(31000, 31000)
    const first = vi.mocked(drawWidget).mock.calls.find(call => call[1].id === graph.id)![3].speedDistanceGraphCache
    expect(first).toBeDefined()
    expect(vi.mocked(drawWidget).mock.calls.find(call => call[1].id === rotated.id)![3].speedDistanceGraphCache).toBeUndefined()
    vi.mocked(drawWidget).mockClear()
    renderer.renderFrame(31100, 31100)
    expect(vi.mocked(drawWidget).mock.calls.find(call => call[1].id === graph.id)![3].speedDistanceGraphCache).toBe(first)
  })

  it('uses the configured crossing radius instead of the old hardcoded default', async () => {
    const normal = await timerRenderer(15)
    normal.renderFrame(32000, 32000)
    expect(vi.mocked(drawWidget).mock.lastCall![3].lapState?.lapNumber).toBe(3)

    const narrow = await timerRenderer(6)
    const pixels = narrow.renderFrame(32000, 32000)
    expect(vi.mocked(drawWidget).mock.lastCall![3].lapState?.lapNumber).toBe(1)
    expect(pixels.length).toBe(narrow.roi.width * narrow.roi.height * 4)
  })

  it('preserves stable raw-index deletions and time nudges in exported lap state', async () => {
    const renderer = await timerRenderer(15, { '1': true }, { '2': 40 })
    renderer.renderFrame(32000, 32000)
    const state = vi.mocked(drawWidget).mock.lastCall![3].lapState!
    expect(state.lapNumber).toBe(2)
    expect(state.currentLapElapsedMs).toBe(960)
  })

  it('prepares cropped GPS geometry and its colored cache once for all subsequent frames', async () => {
    const gps = createWidget('gpsTrack')
    if (gps.type !== 'gpsTrack') throw new Error('expected gpsTrack')
    gps.style.colorMode = 'speed'
    const sampler = createTelemetrySampler(telemetry)
    const renderer = await createFrameRenderer(640, 360, [gps], sampler, null, 15, {}, {}, 17000, 1000, 'Arial')
    expect(buildColoredGpsTrackCache).toHaveBeenCalledTimes(1)

    renderer.renderFrame(16000, 15000)
    const first = vi.mocked(drawWidget).mock.lastCall![3]
    const view = first.preparedGpsTrack!
    expect(view.trackCts).toEqual([1000, 2000, 15000, 16000, 17000])
    expect(view.trackPoints[0]).toBe(sampler.trackPoints[1])
    expect(vi.mocked(buildColoredGpsTrackCache).mock.calls[0][1]).toBe(view.trackPoints)
    expect(first.trimStartMs).toBe(1000)
    expect(first.sessionEndMs).toBe(17000)
    expect(first.elapsedMs).toBe(15000)
    expect(first.cts).toBe(16000)

    renderer.renderFrame(16500, 15500)
    expect(vi.mocked(drawWidget).mock.lastCall![3].preparedGpsTrack).toBe(view)
    expect(buildColoredGpsTrackCache).toHaveBeenCalledTimes(1)
  })
})
