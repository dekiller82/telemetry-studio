import { describe, expect, it, vi } from 'vitest'
import type { Canvas2DLike, CanvasImageLike } from './canvas2d'
import { drawWidget, type WidgetDrawContext } from './drawWidget'
import { createWidget } from '../widgets/defaults'
import { prepareGpsTrackView } from './gpsTrackView'
import { formatTime } from '../format'
import { getLapStateAt } from '../telemetry/laps'
import { computeLapSectors, getSectorStateAt } from '../telemetry/sectors'
import { createTelemetrySampler } from '../telemetry/sampleAt'
import type { TelemetrySample } from '../types'

function mockCanvas(): Canvas2DLike {
  const noop = (): void => undefined
  return {
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    clearRect: noop,
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: () => ({ width: 20 }),
    translate: noop,
    rotate: noop,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    shadowBlur: 0,
    shadowColor: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: ''
  }
}

function drawContext(hasGpsPosition: boolean): WidgetDrawContext {
  return {
    trackPoints: [
      { x: 0, y: 0 },
      { x: 10, y: 10 }
    ],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    dotPosition: { x: 5, y: 5 },
    hasGpsPosition,
    speedMps: 20,
    elapsedMs: 0,
    cts: 0,
    elevationReading: 100,
    elevationProfile: [
      { cts: 0, distanceM: 0, altitude: 100 },
      { cts: 1_000, distanceM: 20, altitude: 101 }
    ],
    distanceReading: 20,
    headingReading: 45
  }
}

function expectNoContentDrawn(ctx: Canvas2DLike): void {
  expect(ctx.arc).not.toHaveBeenCalled()
  expect(ctx.stroke).not.toHaveBeenCalled()
  expect(ctx.fill).not.toHaveBeenCalled()
  expect(ctx.fillRect).not.toHaveBeenCalled()
  expect(ctx.fillText).not.toHaveBeenCalled()
  expect(ctx.strokeText).not.toHaveBeenCalled()
}

describe('drawWidget GPS availability', () => {
  it.each(['speedometerAnalog', 'speedometerDigital', 'elevation', 'distance', 'compass'] as const)(
    'hides %s while the current frame has no trustworthy GPS position',
    (type) => {
      const ctx = mockCanvas()
      drawWidget(ctx, createWidget(type), { x: 0, y: 0, w: 400, h: 400 }, drawContext(false))
      expectNoContentDrawn(ctx)
    }
  )

  it('keeps the static GPS track visible but hides its live dot', () => {
    const ctx = mockCanvas()
    drawWidget(ctx, createWidget('gpsTrack'), { x: 0, y: 0, w: 400, h: 400 }, drawContext(false))
    expect(ctx.stroke).toHaveBeenCalled()
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('draws live GPS readouts when the current frame is trustworthy', () => {
    const ctx = mockCanvas()
    drawWidget(ctx, createWidget('speedometerDigital'), { x: 0, y: 0, w: 400, h: 400 }, drawContext(true))
    expect(ctx.fillText).toHaveBeenCalled()
  })
})

describe('drawWidget GPS gap timing', () => {
  // Lap 1 is a valid 30-second lap. The shorter lap 2 closes inside a GPS gap; lap 3
  // still contains that gap after GPS returns. Neither can replace lap 1's verified results.
  const samples: TelemetrySample[] = [
    ...Array.from({ length: 31 }, (_, i) => i * 1000),
    ...Array.from({ length: 11 }, (_, i) => 60000 + i * 1000)
  ].map((cts) => ({ cts, lat: 30 + cts / 1000 * 10 / 111195, lon: 106,
    altitude: 100, speed2D: 10, speed3D: 10 }))
  const crossings = [0, 30000, 50000]
  const boundaries = computeLapSectors(samples, crossings)
  const sampler = createTelemetrySampler({ samples, videoDurationMs: 70000,
    deviceName: 'test', gpsStream: 'GPS5', accel: [], gyro: [], gravity: [] })
  const moments = [
    { stage: 'during the gap', cts: 40000, elapsedMs: 10000, hasPosition: false },
    { stage: 'after the next crossing', cts: 55000, elapsedMs: 5000, hasPosition: false },
    { stage: 'after GPS reacquisition', cts: 65000, elapsedMs: 15000, hasPosition: true }
  ]

  function timingContext(cts: number): WidgetDrawContext {
    return {
      ...drawContext(sampler.hasPositionAt(cts)), cts,
      lapState: getLapStateAt(crossings, cts, samples),
      sectorState: getSectorStateAt(boundaries, cts, crossings)
    }
  }

  it.each(moments)('keeps verified timing tower history $stage', ({ cts, hasPosition }) => {
    const data = timingContext(cts)
    expect(data.hasGpsPosition).toBe(hasPosition)
    expect(data.lapState?.currentLapValid).toBe(false)
    expect(data.lapState?.history).toEqual([{ lapNumber: 1, timeMs: 30000, isBest: true }])
    expect(data.lapState?.bestLapMs).toBe(30000)

    const widget = createWidget('timer')
    if (widget.type !== 'timer') throw new Error('expected a timer widget')
    widget.style.mode = 'laps'
    widget.style.headerText = ''
    const ctx = mockCanvas()
    drawWidget(ctx, widget, { x: 0, y: 0, w: 400, h: 400 }, data)
    expect(vi.mocked(ctx.fillText).mock.calls.map(([text]) => text)).toEqual(['1', '00:30.00'])
  })

  it.each(moments)('keeps the sector running clock and last valid row $stage', ({ cts, elapsedMs }) => {
    const data = timingContext(cts)
    const state = data.sectorState!
    expect(data.lapState?.currentLapValid).toBe(false)
    expect(boundaries.map((boundary) => boundary.lapNumber)).toEqual([1])
    expect(state.currentSector).toBe(1)
    expect(state.currentSectorElapsedMs).toBe(elapsedMs)
    expect(state.currentLapS1Ms).toBeNull()
    expect(state.currentLapS2Ms).toBeNull()
    expect(state.isCurrentLapS1Best).toBe(false)
    expect(state.isCurrentLapS2Best).toBe(false)
    const last = state.lastLap!
    expect(last.lapNumber).toBe(1)
    expect(last.totalMs).toBe(30000)
    expect([state.bestS1Ms, state.bestS2Ms, state.bestS3Ms]).toEqual([last.s1Ms, last.s2Ms, last.s3Ms])

    const widget = createWidget('sectorTimer')
    if (widget.type !== 'sectorTimer') throw new Error('expected a sectorTimer widget')
    widget.style.showLastLapRow = true
    const ctx = mockCanvas()
    drawWidget(ctx, widget, { x: 0, y: 0, w: 400, h: 400 }, data)
    // Sector values are rendered one character at a time to keep digit widths stable.
    const text = vi.mocked(ctx.fillText).mock.calls.map(([value]) => value).join('')
    expect(text).toBe(`S1${formatTime(elapsedMs, true)}S2--.--S3--.--` +
      `S1${formatTime(last.s1Ms, true)}S2${formatTime(last.s2Ms, true)}S3${formatTime(last.s3Ms, true)}`)
  })
})

describe('drawWidget gpsTrack trimAware', () => {
  // Two points outside the trim range (a pre-trim GPS excursion, e.g. parked under cover) and two
  // inside it -- style.trimAware should crop the drawn shape/dot down to just the latter.
  function trimAwareContext(cts: number): WidgetDrawContext {
    return {
      ...drawContext(true),
      trackPoints: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 1, y: 1 },
        { x: 2, y: 2 }
      ],
      trackCts: [0, 500, 1000, 2000],
      trackSpeeds: [1, 1, 1, 1],
      cts,
      trimStartMs: 1000,
      sessionEndMs: 2000
    }
  }

  function trimAwareGpsWidget() {
    const widget = createWidget('gpsTrack')
    if (widget.type !== 'gpsTrack') throw new Error('expected a gpsTrack widget')
    widget.style.trimAware = true
    return widget
  }

  it('hides the dot when the current frame is outside the trim range', () => {
    const ctx = mockCanvas()
    drawWidget(ctx, trimAwareGpsWidget(), { x: 0, y: 0, w: 400, h: 400 }, trimAwareContext(500))
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('shows the dot when the current frame is inside the trim range', () => {
    const ctx = mockCanvas()
    drawWidget(ctx, trimAwareGpsWidget(), { x: 0, y: 0, w: 400, h: 400 }, trimAwareContext(1500))
    expect(ctx.arc).toHaveBeenCalled()
  })

  it('draws nothing when the trim range excludes every sample', () => {
    const ctx = mockCanvas()
    const data = trimAwareContext(1500)
    data.trimStartMs = 5000
    data.sessionEndMs = 6000
    drawWidget(ctx, trimAwareGpsWidget(), { x: 0, y: 0, w: 400, h: 400 }, data)
    expect(ctx.stroke).not.toHaveBeenCalled()
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('falls back to the untrimmed shape when the caller supplies no trim range', () => {
    const ctx = mockCanvas()
    const data = drawContext(true) // no trimStartMs/sessionEndMs
    drawWidget(ctx, trimAwareGpsWidget(), { x: 0, y: 0, w: 400, h: 400 }, data)
    expect(ctx.arc).toHaveBeenCalled()
    expect(ctx.stroke).toHaveBeenCalled()
  })

  it('does not crop when style.trimAware is explicitly off, even with a trim range that excludes the current frame', () => {
    const ctx = mockCanvas()
    const widget = createWidget('gpsTrack')
    if (widget.type !== 'gpsTrack') throw new Error('expected a gpsTrack widget')
    widget.style.trimAware = false
    drawWidget(ctx, widget, { x: 0, y: 0, w: 400, h: 400 }, trimAwareContext(500))
    expect(ctx.arc).toHaveBeenCalled()
  })

  it('defaults to on for a freshly created widget -- crops without any explicit opt-in', () => {
    const ctx = mockCanvas()
    const widget = createWidget('gpsTrack')
    drawWidget(ctx, widget, { x: 0, y: 0, w: 400, h: 400 }, trimAwareContext(500))
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('uses a cache built for prepared cropped geometry instead of re-drawing its segments', () => {
    const ctx = mockCanvas()
    const widget = trimAwareGpsWidget()
    widget.style.colorMode = 'speed'
    const data = trimAwareContext(1500)
    data.preparedGpsTrack = prepareGpsTrackView({
      trackPoints: data.trackPoints, bounds: data.bounds,
      trackCts: data.trackCts!, trackSpeeds: data.trackSpeeds!
    }, data.trimStartMs, data.sessionEndMs)
    const cache = { width: 400, height: 400 } as CanvasImageLike
    data.speedBounds = { min: 0, max: 2 }
    data.coloredTrackImage = cache
    drawWidget(ctx, widget, { x: 0, y: 0, w: 400, h: 400 }, data)
    expect(ctx.drawImage).toHaveBeenCalledWith(cache, 0, 0, 400, 400)
    expect(ctx.arc).toHaveBeenCalled()
  })

  it('keeps an untrimmed colored cache when the supplied range covers every sample', () => {
    const ctx = mockCanvas()
    const widget = trimAwareGpsWidget()
    widget.style.colorMode = 'speed'
    const data = trimAwareContext(1500)
    data.trimStartMs = 0
    data.sessionEndMs = 3000
    data.speedBounds = { min: 0, max: 2 }
    data.coloredTrackImage = { width: 400, height: 400 } as CanvasImageLike
    drawWidget(ctx, widget, { x: 0, y: 0, w: 400, h: 400 }, data)
    expect(ctx.drawImage).toHaveBeenCalled()
  })

  it('does not reuse a legacy full-track cache for an unprepared partial trim', () => {
    const ctx = mockCanvas()
    const widget = trimAwareGpsWidget()
    widget.style.colorMode = 'speed'
    const data = trimAwareContext(1500)
    data.speedBounds = { min: 0, max: 2 }
    data.coloredTrackImage = { width: 400, height: 400 } as CanvasImageLike
    drawWidget(ctx, widget, { x: 0, y: 0, w: 400, h: 400 }, data)
    expect(ctx.drawImage).not.toHaveBeenCalled()
    expect(ctx.stroke).toHaveBeenCalled()
  })
})
