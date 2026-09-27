import { describe, expect, it } from 'vitest'
import type { TelemetrySample } from '../types'
import { filterGpsTrack, isGpsTransitionPlausible } from './gpsTrackFilter'

const METERS_PER_DEGREE_AT_EQUATOR = 111_195

function point(cts: number, eastM: number, northM: number, speed2D: number): TelemetrySample {
  return {
    cts,
    lat: northM / METERS_PER_DEGREE_AT_EQUATOR,
    lon: eastM / METERS_PER_DEGREE_AT_EQUATOR,
    altitude: 0,
    speed2D,
    speed3D: speed2D
  }
}

function linearTrack(startCts: number, count: number, intervalMs: number, startEastM: number, speedMps: number): TelemetrySample[] {
  return Array.from({ length: count }, (_, i) =>
    point(startCts + i * intervalMs, startEastM + speedMps * ((i * intervalMs) / 1000), 0, speedMps)
  )
}

describe('isGpsTransitionPlausible', () => {
  it('rejects the real HERO8 snap despite its plausible reported speed', () => {
    const before: TelemetrySample = {
      cts: 222747.39284210542,
      lat: 29.6359115,
      lon: 106.3387148,
      altitude: 0,
      speed2D: 18.57,
      speed3D: 18.57
    }
    const after: TelemetrySample = {
      cts: 222802.67536842122,
      lat: 29.6347304,
      lon: 106.3395988,
      altitude: 0,
      speed2D: 18.943,
      speed3D: 18.943
    }

    expect(isGpsTransitionPlausible(before, after)).toBe(false)
  })

  it('keeps a legitimate 300 km/h transition at an 18 Hz GPS sample rate', () => {
    const speedMps = 300 / 3.6
    const intervalMs = 55
    const distanceM = speedMps * (intervalMs / 1000)
    expect(isGpsTransitionPlausible(point(0, 0, 0, speedMps), point(intervalMs, distanceM, 0, speedMps))).toBe(true)
  })

  it('allows consumer-GPS position jitter while nearly stationary', () => {
    expect(isGpsTransitionPlausible(point(0, 0, 0, 0.2), point(55, 9, 0, 0.2))).toBe(true)
  })
})

describe('filterGpsTrack', () => {
  it('returns an already plausible track unchanged', () => {
    const input = linearTrack(0, 100, 500, 0, 20)
    const result = filterGpsTrack(input)
    expect(result.samples).toEqual(input)
    expect(result.report.status).toBe('clean')
    expect(result.report.removedSamples).toBe(0)
  })

  it('selects a clearly dominant stable suffix after a sustained bad startup branch', () => {
    const badPrefix = linearTrack(0, 40, 500, 0, 10)
    const stableSuffix = linearTrack(20_000, 200, 500, 2_000, 20)
    const result = filterGpsTrack([...badPrefix, ...stableSuffix])

    expect(result.samples).toEqual(stableSuffix)
    expect(result.report.status).toBe('filtered')
    expect(result.report.segmentSizes).toEqual([40, 200])
    expect(result.report.dominantShare).toBeCloseTo(200 / 240)
  })

  it('bridges and removes a short spike without discarding either good side', () => {
    const before = linearTrack(0, 50, 500, 0, 10)
    const spike = point(25_000, 50_000, 50_000, 10)
    const after = linearTrack(25_500, 50, 500, 255, 10)
    const result = filterGpsTrack([...before, spike, ...after])

    expect(result.samples).toEqual([...before, ...after])
    expect(result.report.status).toBe('filtered')
    expect(result.report.removedSamples).toBe(1)
  })

  it('does not silently discard one of two similarly-sized ambiguous branches', () => {
    const first = linearTrack(0, 60, 500, 0, 10)
    const second = linearTrack(30_000, 40, 500, 5_000, 10)
    const input = [...first, ...second]
    const result = filterGpsTrack(input)

    expect(result.samples).toEqual(input)
    expect(result.report.status).toBe('ambiguous')
    expect(result.report.dominantShare).toBeCloseTo(0.6)
  })

  it('uses sample support rather than a sparse segment time span', () => {
    const sparse = [point(0, 0, 0, 10), point(40_000, 200, 0, 10)]
    const dense = linearTrack(40_500, 100, 500, 5_000, 10)
    const result = filterGpsTrack([...sparse, ...dense])

    expect(result.samples).toEqual(dense)
    expect(result.report.status).toBe('filtered')
  })
})
