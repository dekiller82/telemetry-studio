import { describe, expect, it } from 'vitest'
import type { TelemetryData, TelemetrySample } from '../types'
import { filterGpsTrack } from './gpsTrackFilter'
import { createTelemetrySampler } from './sampleAt'
import { isGpsRangeContinuous } from './gpsContinuity'
import { detectLapCrossings, fastestLapRange, getLapStateAt, nearestLatLon, lapTimesFromCrossings } from './laps'
import { computeLapDistanceCurves, getDeltaStateAt } from './deltaTime'
import { computeLapSpeedTraces } from './speedTrace'
import { computeLapSectors, getSectorStateAt } from './sectors'
import { stitchClipTelemetry } from './stitchClips'

function track(start: number, count: number, offset = 0): TelemetrySample[] {
  return Array.from({ length: count }, (_, i) => ({ cts: start + i * 1000,
    lat: 30 + (offset + i * 10) / 111195, lon: 106, altitude: 300, speed2D: 10, speed3D: 10 }))
}
function data(samples: TelemetrySample[]): TelemetryData {
  return { samples, deviceName: 'test', gpsStream: 'GPS5', videoDurationMs: samples.at(-1)?.cts ?? 0, accel: [], gyro: [], gravity: [] }
}

describe('GPS reliability across all consumers', () => {
  it('drops malformed and duplicate cache points without reordering the surviving source', () => {
    const samples = track(0, 5)
    const input = [samples[0], { ...samples[1], lat: NaN }, samples[1], samples[1],
      { ...samples[2], lon: 181 }, samples[2], { ...samples[3], cts: -1 }, samples[3], samples[4]]
    expect(filterGpsTrack(input).samples).toEqual(samples)
    expect(input).toHaveLength(9)
  })

  it('does not detect a crossing at a gap or position snap', () => {
    const point = track(0, 1)[0]
    const distant = { ...point, lat: point.lat + 1 }
    expect(detectLapCrossings([{ ...distant, cts: 0 }, { ...point, cts: 1000 },
      { ...distant, cts: 2000 }], point)).toEqual([])
    expect(detectLapCrossings([{ ...point, cts: 0, lat: point.lat + 0.0001 },
      { ...point, cts: 5000 }, { ...point, cts: 6000, lat: point.lat + 0.0001 }], point)).toEqual([])
  })

  it('removes a reacquisition burst without requiring one of the good branches to dominate', () => {
    const burst = track(0, 13).map((s, i) => ({ ...s, cts: i * 55, lat: 42 + i * 0.3, lon: 91, speed2D: 0 }))
    const first = track(1000, 40)
    const second = track(41000, 35, 5000)
    const input = [...burst, ...first, ...second]
    const result = filterGpsTrack(input)
    expect(result.samples).toEqual([...first, ...second])
    expect(result.report.status).toBe('ambiguous')
    expect(result.report.removedSamples).toBe(13)
    expect(filterGpsTrack(result.samples).samples).toEqual(result.samples)
    expect(input).toHaveLength(88)
  })

  it('rejects wholly incoherent positions, but preserves a short coherent recording', () => {
    expect(filterGpsTrack(track(0, 8).map((s, i) => ({ ...s, lat: 30 + i }))).samples).toEqual([])
    const short = track(0, 2)
    expect(filterGpsTrack(short).samples).toEqual(short)
  })

  it('can open a recording with only one retained GPS fix', () => {
    const samples = track(1000, 1)
    const sampler = createTelemetrySampler(data(filterGpsTrack(samples).samples))
    expect(sampler.hasPositionAt(1000)).toBe(true)
    expect(sampler.hasPositionAt(1100)).toBe(false)
    expect(sampler.headingAt(1000)).toBe(0)
    expect(sampler.distanceAt(1000)).toBe(0)
    expect(sampler.gpsCoverageFraction).toBe(0)
  })

  it('keeps heading, speed and elevation smoothing inside each continuous segment', () => {
    const first = Array.from({ length: 8 }, (_, i) => ({ ...track(0, 1)[0], cts: i * 100,
      lat: 30 + i / 111195, altitude: 100, speed2D: 10 }))
    const second = Array.from({ length: 8 }, (_, i) => ({ ...track(0, 1)[0], cts: 800 + i * 100,
      lat: 31, lon: 107 + i / 111195, altitude: 900, speed2D: 30 }))
    const sampler = createTelemetrySampler(data([...first, ...second]))
    expect(sampler.hasPositionAt(750)).toBe(false)
    for (const smoothingMs of [60, 10000]) {
      expect(sampler.speedAt(700, smoothingMs)).toBeCloseTo(10, 6)
      expect(sampler.speedAt(800, smoothingMs)).toBeCloseTo(30, 6)
      expect(sampler.elevationAt(700, smoothingMs)).toBeCloseTo(100, 6)
      expect(sampler.elevationAt(800, smoothingMs)).toBeCloseTo(900, 6)
      expect(sampler.headingAt(700, smoothingMs)).toBeCloseTo(0, 4)
      expect(sampler.headingAt(800, smoothingMs)).toBeCloseTo(90, 4)
    }
  })

  it('does not interpolate, smooth or accumulate distance across a 193-second gap', () => {
    const first = track(0, 4)
    const second = track(196000, 4, 3000)
    const samples = [...first, ...second]
    const sampler = createTelemetrySampler(data(samples))
    expect(sampler.hasPositionAt(100000)).toBe(false)
    expect(sampler.hasPositionAt(196000)).toBe(true)
    expect(sampler.distanceAt(196000)).toBe(sampler.distanceAt(3000))
    expect(sampler.distanceAt(199000)).toBeCloseTo(60, 1)
    expect(sampler.trackPoints[4].breakBefore).toBe(true)
    expect(sampler.trackPoints[4].y - sampler.trackPoints[3].y).toBeGreaterThan(2900)
    expect(sampler.positionAt(100000)).toEqual(sampler.trackPoints[3])
    expect(nearestLatLon(samples, 100000)).toBeNull()
    expect(isGpsRangeContinuous(samples, 196000, 198000)).toBe(true)
    expect(isGpsRangeContinuous(samples, 100000, 197000)).toBe(false)
    expect(sampler.gpsCoverageFraction).toBeLessThan(0.04)
  })

  it('removes a short spike while preserving both good sides of a gap longer than two seconds', () => {
    const makeTrack = (start: number, count: number, offset: number) =>
      Array.from({ length: count }, (_, i) => ({ ...track(0, 1)[0], cts: start + i * 500,
        lat: 30 + (offset + i * 5) / 111195 }))
    const before = makeTrack(0, 200, 0)
    const spike = makeTrack(100000, 4, 50000)
    const after = makeTrack(102000, 40, 1020)
    const result = filterGpsTrack([...before, ...spike, ...after])
    expect(result.samples).toEqual([...before, ...after])
    expect(result.report.removedSamples).toBe(4)
    expect(filterGpsTrack(result.samples).samples).toEqual(result.samples)

    const sampler = createTelemetrySampler(data(result.samples))
    expect(sampler.hasPositionAt(100500)).toBe(false)
    expect(sampler.hasPositionAt(102000)).toBe(true)
    expect(sampler.trackPoints[200].breakBefore).toBe(true)
    expect(sampler.distanceAt(102000)).toBe(sampler.distanceAt(99500))
    expect(isGpsRangeContinuous(result.samples, 0, 121500)).toBe(false)
    expect(lapTimesFromCrossings([0, 121500], result.samples)).toEqual([null])
  })

  it('excludes incomplete laps from timing, fastest lap, sectors and predictions', () => {
    const samples = [...track(0, 21), ...track(40000, 21, 400)]
    const crossings = [0, 20000, 40000, 60000]
    expect(lapTimesFromCrossings(crossings, samples)).toEqual([20000, null, 20000])
    expect(fastestLapRange([20000, 40000], samples)).toBeNull()
    const state = getLapStateAt(crossings, 60000, samples)
    expect(state.history.map((lap) => lap.lapNumber)).toEqual([3, 1])
    expect(getLapStateAt(crossings, 30000, samples).currentLapValid).toBe(false)
    expect(computeLapDistanceCurves(samples, crossings).map((lap) => lap.lapNumber)).toEqual([1, 3])
    expect(computeLapSpeedTraces(samples, crossings).map((lap) => lap.lapNumber)).toEqual([1, 3])
    expect(computeLapSectors(samples, crossings).map((lap) => lap.lapNumber)).toEqual([1, 3])
    expect(getDeltaStateAt(computeLapDistanceCurves(samples, crossings), crossings, samples, 30000).predictedLapMs).toBeNull()
  })

  it('keeps chapter overlap from breaking the global time ordering', () => {
    const first = data(track(0, 3))
    const second = data(track(0, 3, 20))
    const stitched = stitchClipTelemetry([{ telemetry: first, durationMs: 1990 }, { telemetry: second, durationMs: 3000 }])
    expect(stitched.samples.map((s) => s.cts)).toEqual([0, 1000, 2000, 2990, 3990])
    expect(isGpsRangeContinuous(stitched.samples, 0, 3990)).toBe(true)
  })

  it('resets sector clocks at crossings even when an incomplete lap has no sector entry', () => {
    const samples = [...track(0, 21), ...track(40000, 21, 400)]
    const crossings = [0, 20000, 40000, 60000, 80000]
    const boundaries = computeLapSectors(samples, crossings)
    const incomplete = getSectorStateAt(boundaries, 30000, crossings)
    expect(incomplete.currentSector).toBe(1)
    expect(incomplete.currentSectorElapsedMs).toBe(10000)
    expect(incomplete.currentLapS1Ms).toBeNull()
    const trailing = getSectorStateAt(boundaries, 85000, crossings)
    expect(trailing.currentSectorElapsedMs).toBe(5000)
    expect(trailing.lastLap?.lapNumber).toBe(3)
    expect(trailing.bestS3Ms).toBeGreaterThan(0)
    expect(Number.isFinite(trailing.bestS3Ms)).toBe(true)
  })
})
