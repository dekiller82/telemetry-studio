import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import type { Canvas2DLike } from '../../shared/render/canvas2d'
import {
  DEFAULT_SPEED_DISTANCE_GRAPH_STYLE, drawSpeedDistanceGraph, type DrawSpeedDistanceGraphOptions
} from '../../shared/render/drawSpeedDistanceGraph'
import type { LapSpeedTrace } from '../../shared/telemetry/speedTrace'
import { ExportSpeedDistanceGraphCache, GraphCacheBudget } from './speedDistanceGraphCache'

function trace(lapNumber: number, count = 500): LapSpeedTrace {
  const points = Array.from({ length: count }, (_, i) => ({ distanceM: i, speedMps: 12 + 6 * Math.sin(i / 31 + lapNumber) }))
  return { lapNumber, totalDistanceM: count - 1, points }
}

function options(): DrawSpeedDistanceGraphOptions {
  return {
    rect: { x: 80.3, y: 90.7, w: 620.2, h: 210.8 },
    style: { ...DEFAULT_SPEED_DISTANCE_GRAPH_STYLE }, fontFamily: 'Arial',
    lapTraces: [trace(1), trace(2)], currentLapTrace: trace(3, 300)
  }
}

function pixels(config: DrawSpeedDistanceGraphOptions): Buffer {
  const canvas = createCanvas(900, 500)
  drawSpeedDistanceGraph(canvas.getContext('2d') as unknown as Canvas2DLike, config)
  return Buffer.from(canvas.data())
}

describe('bounded export speed/distance graph cache', () => {
  it('reuses the complete image between GPS updates and the reference image as the live line grows', () => {
    const config = options()
    const cache = new ExportSpeedDistanceGraphCache(new GraphCacheBudget())
    pixels({ ...config, cache })
    for (let i = 0; i < 10; i++) pixels({ ...config, currentLapTrace: trace(3, 300), cache })
    expect(cache.stats.referenceRenders).toBe(1)
    expect(cache.stats.frameRenders).toBe(1)
    pixels({ ...config, currentLapTrace: trace(3, 301), cache })
    expect(cache.stats.referenceRenders).toBe(1)
    expect(cache.stats.frameRenders).toBe(2)
  })

  it.each([true, false])('preserves fractional positioning, alpha, labels and glow (highlight=%s)', highlightCurrentLap => {
    const config = options()
    config.style.highlightCurrentLap = highlightCurrentLap
    const cache = new ExportSpeedDistanceGraphCache(new GraphCacheBudget())
    for (const currentLapTrace of [trace(3, 300), trace(3, 305), null, trace(3, 250)]) {
      const reference = pixels({ ...config, currentLapTrace })
      const cached = pixels({ ...config, currentLapTrace, cache })
      let maxError = 0
      let squaredError = 0
      for (let i = 0; i < reference.length; i++) {
        const error = Math.abs(reference[i] - cached[i])
        maxError = Math.max(maxError, error)
        squaredError += error * error
      }
      // Grouping premultiplied transparent layers can round a channel by one byte. Bound both
      // worst-case error and mean error rather than overlooking a moved/clipped line or glow.
      expect(maxError).toBeLessThanOrEqual(2)
      expect(squaredError / reference.length).toBeLessThan(0.1)
    }
  })

  it('invalidates changed axes, completed laps, style/font and fractional position', () => {
    const config = options()
    const cache = new ExportSpeedDistanceGraphCache(new GraphCacheBudget())
    pixels({ ...config, cache })
    const updates: DrawSpeedDistanceGraphOptions[] = [
      { ...config, currentLapTrace: trace(3, 600) },
      { ...config, lapTraces: [trace(2), trace(3)] },
      { ...config, style: { ...config.style, unit: 'mph' } },
      { ...config, fontFamily: 'sans-serif' },
      { ...config, rect: { ...config.rect, x: 80.6 } }
    ]
    for (const update of updates) {
      const previous = cache.stats.referenceRenders
      pixels({ ...update, cache })
      expect(cache.stats.referenceRenders).toBe(previous + 1)
    }
  })

  it('detects changed intermediate points even with equal counts and endpoints', () => {
    const config = options()
    const cache = new ExportSpeedDistanceGraphCache(new GraphCacheBudget())
    pixels({ ...config, cache })
    const currentLapTrace = trace(3, 300)
    currentLapTrace.points[100].speedMps = 14
    pixels({ ...config, currentLapTrace, cache })
    expect(cache.stats.frameRenders).toBe(2)
  })

  it('falls back without allocating for window mode and graphs over the shared budget', () => {
    const budget = new GraphCacheBudget(1)
    const config = options()
    const cache = new ExportSpeedDistanceGraphCache(budget)
    expect(pixels({ ...config, cache }).equals(pixels(config))).toBe(true)
    expect(budget.usedBytes).toBe(0)
    const windowCache = new ExportSpeedDistanceGraphCache(new GraphCacheBudget())
    const windowConfig = { ...config, style: { ...config.style, viewMode: 'window' as const } }
    expect(pixels({ ...windowConfig, cache: windowCache }).equals(pixels(windowConfig))).toBe(true)
    expect(windowCache.stats.bytes).toBe(0)
  })

  it('bounds all widget caches together and releases the previous surfaces on resize', () => {
    const budget = new GraphCacheBudget(3 * 1024 * 1024)
    const config = options()
    const first = new ExportSpeedDistanceGraphCache(budget)
    const second = new ExportSpeedDistanceGraphCache(budget)
    pixels({ ...config, cache: first })
    pixels({ ...config, cache: second })
    expect(second.stats.bytes).toBe(0)
    pixels({ ...config, rect: { ...config.rect, w: 200, h: 100 }, cache: first })
    expect(budget.usedBytes).toBe(first.stats.bytes)
    pixels({ ...config, cache: second })
    expect(budget.usedBytes).toBe(first.stats.bytes + second.stats.bytes)
    expect(budget.usedBytes).toBeLessThanOrEqual(budget.maxBytes)
  })
})
