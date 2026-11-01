import { describe, expect, it } from 'vitest'
import { prepareGpsTrackView, type GpsTrackView } from './gpsTrackView'

function sourceTrack(): GpsTrackView {
  return {
    trackPoints: [{ x: -100, y: -80 }, { x: 10, y: 20 }, { x: 30, y: 40 }, { x: 500, y: 600 }],
    bounds: { minX: -100, maxX: 500, minY: -80, maxY: 600 },
    trackCts: [0, 1000, 2000, 3000],
    trackSpeeds: [1, 2, 3, 4]
  }
}

describe('prepareGpsTrackView', () => {
  it('reuses all geometry and bounds when no range is supplied', () => {
    const source = sourceTrack()
    expect(prepareGpsTrackView(source)).toBe(source)
    expect(prepareGpsTrackView(source, 1000)).toBe(source)
  })

  it('keeps full-range trims allocation-free and compatible with the original cache', () => {
    const source = sourceTrack()
    expect(prepareGpsTrackView(source, 0, 3000)).toBe(source)
    expect(prepareGpsTrackView(source, -100, 3100)).toBe(source)
  })

  it('crops inclusive timestamps without re-projecting or changing the input arrays', () => {
    const source = sourceTrack()
    const view = prepareGpsTrackView(source, 1000, 2000)
    expect(view.trackCts).toEqual([1000, 2000])
    expect(view.trackSpeeds).toEqual([2, 3])
    expect(view.trackPoints).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }])
    expect(view.trackPoints[0]).toBe(source.trackPoints[1])
    expect(view.bounds).toEqual({ minX: 10, maxX: 30, minY: 20, maxY: 40 })
    expect(source.trackCts).toEqual([0, 1000, 2000, 3000])
    expect(source.bounds.minX).toBe(-100)
  })

  it('returns empty aligned arrays and finite bounds when no samples overlap', () => {
    const view = prepareGpsTrackView(sourceTrack(), 5000, 6000)
    expect(view.trackPoints).toEqual([])
    expect(view.trackCts).toEqual([])
    expect(view.trackSpeeds).toEqual([])
    expect(view.bounds).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 })
  })

  it('safely reuses an empty GPS stream', () => {
    const source: GpsTrackView = { trackPoints: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, trackCts: [], trackSpeeds: [] }
    expect(prepareGpsTrackView(source, 100, 200)).toBe(source)
  })
})
