import { describe, expect, it } from 'vitest'
import type { ImuSample, TelemetryData, TelemetrySample } from '../types'
import { createTelemetrySampler } from './sampleAt'

function makeSample(cts: number, overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return { cts, lat: 51.5, lon: -0.1, altitude: 0, speed2D: 0, speed3D: 0, ...overrides }
}

function makeTelemetry(samples: TelemetrySample[], overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    deviceName: 'Test Camera',
    gpsStream: 'GPS5',
    samples,
    videoDurationMs: samples.length ? samples[samples.length - 1].cts : 0,
    accel: [],
    gyro: [],
    gravity: [],
    ...overrides
  }
}

describe('createTelemetrySampler', () => {
  it('exposes a track polyline matching sample count', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      makeSample(i * 100, { lat: 51.5 + i * 0.0001, lon: -0.1 + i * 0.0001 })
    )
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    expect(sampler.trackPoints).toHaveLength(10)
    expect(sampler.bounds.maxX).toBeGreaterThan(sampler.bounds.minX)
    expect(sampler.bounds.maxY).toBeGreaterThan(sampler.bounds.minY)
  })

  it('positionAt tracks the moving dot smoothly across sample boundaries', () => {
    const samples = Array.from({ length: 5 }, (_, i) => makeSample(i * 200, { lat: 51.5 + i * 0.001, lon: -0.1 }))
    const sampler = createTelemetrySampler(makeTelemetry(samples))

    const start = sampler.positionAt(0)
    const end = sampler.positionAt(800)
    const mid = sampler.positionAt(400)

    expect(mid.y).toBeGreaterThan(start.y)
    expect(mid.y).toBeLessThan(end.y)
  })

  it('speedAt smooths a noisy but flat-average speed toward its mean', () => {
    const values = [0, 10, 0, 10, 0, 10, 0, 10]
    const samples = values.map((v, i) => makeSample(i * 100, { speed2D: v }))
    const sampler = createTelemetrySampler(makeTelemetry(samples))

    const smoothed = sampler.speedAt(400, 400)
    expect(smoothed).toBeGreaterThan(2)
    expect(smoothed).toBeLessThan(8)
  })

  it('speedAt never goes negative or NaN for zero-speed samples', () => {
    const samples = Array.from({ length: 5 }, (_, i) => makeSample(i * 100, { speed2D: 0 }))
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    const v = sampler.speedAt(250)
    expect(Number.isNaN(v)).toBe(false)
    expect(v).toBeGreaterThanOrEqual(0)
  })

  it('handles an empty telemetry sample list without throwing', () => {
    const sampler = createTelemetrySampler(makeTelemetry([]))
    expect(sampler.trackPoints).toEqual([])
    expect(sampler.hasPositionAt(0)).toBe(false)
    expect(() => sampler.positionAt(0)).not.toThrow()
    expect(() => sampler.speedAt(0)).not.toThrow()
  })

  it('reports telemetry as unavailable outside the retained GPS time range', () => {
    const samples = [
      makeSample(1_000, { altitude: 123, speed2D: 10 }),
      makeSample(2_000, { lat: 51.501, altitude: 125, speed2D: 12 })
    ]
    const sampler = createTelemetrySampler(makeTelemetry(samples))

    expect(sampler.hasPositionAt(999)).toBe(false)
    expect(sampler.hasPositionAt(1_000)).toBe(true)
    expect(sampler.hasPositionAt(2_000)).toBe(true)
    expect(sampler.hasPositionAt(2_001)).toBe(false)
    expect(sampler.speedAt(999)).toBe(0)
    expect(sampler.elevationAt(999)).toBe(0)
    expect(sampler.headingAt(999)).toBe(0)
    expect(sampler.speedAt(2_001)).toBe(0)
  })
})

function makeImu(cts: number, x: number, y: number, z: number): ImuSample {
  return { cts, x, y, z }
}

describe('createTelemetrySampler IMU methods (gForceAt/gForceHistoryAt/rollAngleAt)', () => {
  // Axis 0 = vertical (~9.8, level), axis 1 = lateral, axis 2 = longitudinal. GPS speed drops then
  // rises to match a real braking-then-accelerating event, so calibrateAxes' correlation picks axis
  // 2 as longitudinal (same convention verified against real fixture data in imuCalibration.test.ts).
  const gpsSamples = [0, 100, 200, 300, 400].map((cts, i) => makeSample(cts, { speed2D: [20, 10, 5, 10, 20][i] }))
  const accel = [
    makeImu(0, 9.8, 0, 5),
    makeImu(100, 9.8, 2, -10),
    makeImu(200, 9.8, -2, -10),
    makeImu(300, 9.8, 2, 10),
    makeImu(400, 9.8, -2, 10)
  ]

  it('hasImuData reflects whether the session has any accel samples at all', () => {
    expect(createTelemetrySampler(makeTelemetry(gpsSamples, { accel })).hasImuData).toBe(true)
    expect(createTelemetrySampler(makeTelemetry(gpsSamples)).hasImuData).toBe(false)
  })

  it('gForceAt reports G-forces relative to 9.80665 m/s^2, using the calibrated longitudinal/lateral axes', () => {
    const sampler = createTelemetrySampler(makeTelemetry(gpsSamples, { accel }))
    const reading = sampler.gForceAt(200, 60)
    // Axis 2 (longitudinal, calibrated) is strongly negative around cts=100-200 (braking) -- expect a
    // real negative G reading, not zero/NaN.
    expect(reading.longitudinalG).toBeLessThan(0)
    expect(Number.isNaN(reading.longitudinalG)).toBe(false)
    expect(Number.isNaN(reading.lateralG)).toBe(false)
  })

  it('gForceAt returns zero, not NaN/throw, when there is no accel data', () => {
    const sampler = createTelemetrySampler(makeTelemetry(gpsSamples))
    expect(sampler.gForceAt(100)).toEqual({ lateralG: 0, longitudinalG: 0 })
  })

  it('gForceHistoryAt returns raw (unsmoothed) points within the requested window, not the whole session', () => {
    const sampler = createTelemetrySampler(makeTelemetry(gpsSamples, { accel }))
    const history = sampler.gForceHistoryAt(300, 150)
    expect(history.length).toBeGreaterThan(0)
    expect(history.length).toBeLessThan(accel.length) // a 150ms window shouldn't include every one of 5 samples spanning 400ms
    for (const p of history) {
      expect(p.cts).toBeGreaterThanOrEqual(150)
      expect(p.cts).toBeLessThanOrEqual(300)
    }
  })

  it('rollAngleAt uses the gravity stream (source "gravity") when present', () => {
    const gravity = [makeImu(0, 0.9, 0.436, 0), makeImu(100, 0.9, 0.436, 0)] // tilted ~26 deg on the lateral axis
    const sampler = createTelemetrySampler(makeTelemetry(gpsSamples, { accel, gravity }))
    const reading = sampler.rollAngleAt(50, 60)
    expect(reading.source).toBe('gravity')
    expect(Math.abs(reading.degrees)).toBeGreaterThan(5)
  })

  it('rollAngleAt falls back to accelerometer tilt (source "accelFallback") when no gravity stream exists', () => {
    const sampler = createTelemetrySampler(makeTelemetry(gpsSamples, { accel }))
    const reading = sampler.rollAngleAt(50, 60)
    expect(reading.source).toBe('accelFallback')
    expect(Number.isNaN(reading.degrees)).toBe(false)
  })

  it('rollAngleAt reads ~0 degrees when level (vertical axis dominant, no lateral tilt)', () => {
    const levelAccel = [makeImu(0, 9.8, 0, 0), makeImu(100, 9.8, 0, 0), makeImu(200, 9.8, 0, 0)]
    const sampler = createTelemetrySampler(makeTelemetry(gpsSamples, { accel: levelAccel }))
    const reading = sampler.rollAngleAt(100, 60)
    expect(Math.abs(reading.degrees)).toBeLessThan(2)
  })
})

describe('createTelemetrySampler sessionStatsAt (Session Summary widget)', () => {
  // Straight line north, constant step size -> equal distance per sample; speed2D deliberately
  // varies (not derived from the GPS movement itself) so max-speed and distance can be asserted
  // independently of each other.
  const samples = [
    makeSample(0, { lat: 51.5, lon: -0.1, speed2D: 10 }),
    makeSample(1000, { lat: 51.501, lon: -0.1, speed2D: 25 }), // fastest point
    makeSample(2000, { lat: 51.502, lon: -0.1, speed2D: 15 }),
    makeSample(3000, { lat: 51.503, lon: -0.1, speed2D: 20 })
  ]

  it('reports zero distance/speed for a zero-width window at the very first sample', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    const stats = sampler.sessionStatsAt(0, 0)
    expect(stats.totalDistanceM).toBeCloseTo(0, 3)
    expect(stats.maxSpeedMps).toBe(10)
  })

  it('accumulates distance and tracks the max speed within [startCts, endCts]', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    const stats = sampler.sessionStatsAt(0, 2000)
    // Distance from sample 0->1->2, each leg the same size (equal lat steps) -- should be ~2x one leg.
    const oneLegM = createTelemetrySampler(makeTelemetry(samples)).sessionStatsAt(0, 1000).totalDistanceM
    expect(stats.totalDistanceM).toBeCloseTo(oneLegM * 2, 1)
    expect(stats.maxSpeedMps).toBe(25) // peak was at t=1000, within [0, 2000]
  })

  // Confirmed as a real, deliberate design choice, not an oversight: this must stay bounded by
  // endCts so scrubbing the editor to earlier than the true session end never shows a later
  // peak/total that "hasn't happened yet" from that point of view -- same discipline as lap/sector state.
  it('never leaks a later peak speed in when endCts is before it occurs', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    const stats = sampler.sessionStatsAt(0, 500) // before the t=1000 speed=25 peak
    expect(stats.maxSpeedMps).toBe(10)
  })

  it('reports the full session totals once queried over the whole [0, lastCts] range', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    const stats = sampler.sessionStatsAt(0, 3000)
    expect(stats.maxSpeedMps).toBe(25)
    expect(stats.totalDistanceM).toBeGreaterThan(0)
  })

  // The actual bug reported: with a start trim positioned close to the end trim, distance/speed
  // from BEFORE startCts must not leak in -- previously this queried "up to endCts" only, so a
  // short trimmed window near the end still reported the ENTIRE session's distance/peak speed
  // (accumulated from cts=0), paired with the short window's tiny elapsed time -> a wildly inflated
  // average speed in the Session Summary widget.
  it('excludes distance/speed from before startCts -- a short window near the end reports only that window\'s own stats', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    // A short window entirely within the last leg (t=2000 -> t=3000), NOT from the start.
    const stats = sampler.sessionStatsAt(2500, 3000)
    const wholeSessionStats = sampler.sessionStatsAt(0, 3000)
    // Must be much smaller than the whole session's distance -- not leaking in samples 0/1/2's legs.
    expect(stats.totalDistanceM).toBeLessThan(wholeSessionStats.totalDistanceM)
    // Peak speed in [2500, 3000] is just sample 3's speed (20), NOT the whole session's peak (25 at t=1000).
    expect(stats.maxSpeedMps).toBe(20)
  })

  it('a zero-width (or near-zero) window at the very end reports ~zero distance, not the whole session\'s', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    const stats = sampler.sessionStatsAt(3000, 3000)
    expect(stats.totalDistanceM).toBeCloseTo(0, 3)
    expect(stats.maxSpeedMps).toBe(20) // just the sample at t=3000, not the earlier t=1000 peak
  })

  it('handles an empty sample array without throwing', () => {
    const sampler = createTelemetrySampler(makeTelemetry([]))
    expect(sampler.sessionStatsAt(0, 1000)).toEqual({ totalDistanceM: 0, maxSpeedMps: 0 })
  })
})

describe('createTelemetrySampler elevation (Elevation widget)', () => {
  const samples = [
    makeSample(0, { lat: 51.5, lon: -0.1, altitude: 100 }),
    makeSample(1000, { lat: 51.501, lon: -0.1, altitude: 120 }),
    makeSample(2000, { lat: 51.502, lon: -0.1, altitude: 90 }),
    makeSample(3000, { lat: 51.503, lon: -0.1, altitude: 110 })
  ]

  it('elevationAt reads the (smoothed) altitude near a given cts', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    // Light smoothing so it stays close to the raw sample at that exact instant.
    expect(sampler.elevationAt(0, 60)).toBeCloseTo(100, 0)
    expect(sampler.elevationAt(1000, 60)).toBeCloseTo(120, 0)
  })

  it('elevationAt returns 0 for an empty sample array without throwing', () => {
    const sampler = createTelemetrySampler(makeTelemetry([]))
    expect(sampler.elevationAt(1000)).toBe(0)
  })

  it('elevationProfile is 1:1 index-aligned with the samples, pairing cumulative distance with altitude', () => {
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    expect(sampler.elevationProfile).toHaveLength(samples.length)
    expect(sampler.elevationProfile[0]).toEqual({ distanceM: 0, altitude: 100, cts: 0 })
    expect(sampler.elevationProfile[1].altitude).toBe(120)
    // Cumulative distance is monotonically non-decreasing (a real GPS arc-length, never goes backwards).
    for (let i = 1; i < sampler.elevationProfile.length; i++) {
      expect(sampler.elevationProfile[i].distanceM).toBeGreaterThanOrEqual(sampler.elevationProfile[i - 1].distanceM)
    }
  })

  it('elevationProfile is empty for an empty sample array', () => {
    const sampler = createTelemetrySampler(makeTelemetry([]))
    expect(sampler.elevationProfile).toEqual([])
  })
})

describe('createTelemetrySampler distanceAt (Distance widget)', () => {
  it('accumulates real GPS arc-length distance up to cts, never goes backwards', () => {
    const samples = [
      makeSample(0, { lat: 51.5, lon: -0.1 }),
      makeSample(1000, { lat: 51.501, lon: -0.1 }),
      makeSample(2000, { lat: 51.502, lon: -0.1 }),
      makeSample(3000, { lat: 51.503, lon: -0.1 })
    ]
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    expect(sampler.distanceAt(0)).toBe(0)
    expect(sampler.distanceAt(1000)).toBeGreaterThan(0)
    expect(sampler.distanceAt(2000)).toBeGreaterThan(sampler.distanceAt(1000))
    expect(sampler.distanceAt(3000)).toBeGreaterThan(sampler.distanceAt(2000))
  })

  it('returns 0 for an empty sample array without throwing', () => {
    const sampler = createTelemetrySampler(makeTelemetry([]))
    expect(sampler.distanceAt(1000)).toBe(0)
  })
})

describe('createTelemetrySampler headingAt (Compass widget)', () => {
  it('reads ~0deg (North) when travelling due north', () => {
    const samples = Array.from({ length: 6 }, (_, i) => makeSample(i * 200, { lat: 51.5 + i * 0.001, lon: -0.1 }))
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    expect(sampler.headingAt(500, 60)).toBeCloseTo(0, 0)
  })

  it('reads ~90deg (East) when travelling due east', () => {
    const samples = Array.from({ length: 6 }, (_, i) => makeSample(i * 200, { lat: 51.5, lon: -0.1 + i * 0.001 }))
    const sampler = createTelemetrySampler(makeTelemetry(samples))
    expect(sampler.headingAt(500, 60)).toBeCloseTo(90, 0)
  })

  it('carries the previous heading forward through a stationary stretch instead of snapping to a false North', () => {
    // Enough samples that smoothTrackPoints' windowed average (radius 3) doesn't blend the whole
    // array into one point -- 8 samples moving east, then 8 stopped at the final position.
    const moving = Array.from({ length: 8 }, (_, i) => makeSample(i * 200, { lat: 51.5, lon: -0.1 + i * 0.001 }))
    const lastLon = moving[moving.length - 1].lon
    const stationary = Array.from({ length: 8 }, (_, i) => makeSample(1600 + i * 200, { lat: 51.5, lon: lastLon }))
    const sampler = createTelemetrySampler(makeTelemetry([...moving, ...stationary]))
    // Deep into the stationary tail -- should still read close to East (carried forward), nowhere
    // near the false North (0deg) a naive "reset to 0 on a zero-length segment" would report.
    const heading = sampler.headingAt(2600, 60)
    expect(heading).toBeGreaterThan(60)
    expect(heading).toBeLessThan(120)
  })

  it('returns 0 for an empty sample array without throwing', () => {
    const sampler = createTelemetrySampler(makeTelemetry([]))
    expect(sampler.headingAt(1000)).toBe(0)
  })
})
