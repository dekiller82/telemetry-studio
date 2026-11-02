import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportResult } from '@shared/types'
import { useProjectStore } from './projectStore'

function imported(path: string, durationMs: number, clipCount = 1): ImportResult {
  return {
    clips: Array.from({ length: clipCount }, (_, index) => ({
      video: {
        path: index === 0 ? path : `${path}.${index}`,
        fileName: index === 0 ? path : `${path}.${index}`,
        durationMs: durationMs / clipCount,
        fps: 30,
        width: 1920,
        height: 1080,
        codec: 'h264',
        pixFmt: 'yuv420p',
        hasAudio: true,
        lrvPath: null
      },
      startOffsetMs: (durationMs / clipCount) * index
    })),
    telemetry: {
      deviceName: 'test',
      gpsStream: 'GPS5',
      samples: [],
      videoDurationMs: durationMs,
      accel: [],
      gyro: [],
      gravity: []
    }
  }
}

beforeEach(() => {
  useProjectStore.setState({ imported: null, projectGeneration: 0, currentTimeMs: 0, trimStartMs: 0, trimEndMs: 0, excludedLaps: {} })
})

describe('manual lap results', () => {
  it('restores one result without changing crossings or other manual decisions', () => {
    const store = useProjectStore.getState()
    store.setImported(imported('first.mp4', 200_000))
    store.setCrossingAdjustmentsMs({ '1': 40 })
    store.setIgnoredCrossings({ '4': true })
    store.setLapExcluded('1000:61000', true)
    store.setLapExcluded('61000:111000', true)
    store.setLapExcluded('1000:61000', false)
    expect(useProjectStore.getState().excludedLaps).toEqual({ '61000:111000': true })
    expect(useProjectStore.getState().crossingAdjustmentsMs).toEqual({ '1': 40 })
    expect(useProjectStore.getState().ignoredCrossings).toEqual({ '4': true })
  })
  it('keeps decisions when appending clips and resets them for a new project', () => {
    const store = useProjectStore.getState()
    store.setImported(imported('first.mp4', 100_000))
    store.setLapExcluded('1000:61000', true)
    store.updateImportedClips(imported('first.mp4', 200_000, 2))
    expect(useProjectStore.getState().excludedLaps).toEqual({ '1000:61000': true })
    store.setImported(imported('new.mp4', 100_000))
    expect(useProjectStore.getState().excludedLaps).toEqual({})
  })
  it.each(['point', 'radius'])('clears decisions when the start/finish %s changes', (setting) => {
    const store = useProjectStore.getState()
    store.setLapExcluded('1000:61000', true)
    if (setting === 'point') store.setStartFinish({ lat: 30, lon: 106 })
    else store.setStartFinishRadiusM(6)
    expect(useProjectStore.getState().excludedLaps).toEqual({})
    store.setExcludedLaps({ '2000:62000': true })
    expect(useProjectStore.getState().excludedLaps).toEqual({ '2000:62000': true })
  })
})

describe('project replacement generation', () => {
  it('retains fixed sector markers when appending chapters and clears them for a new project', () => {
    const store = useProjectStore.getState()
    store.setImported(imported('first.mp4', 1_000))
    const markers = { s1: { lat: 30.001, lon: 106.001 }, s2: { lat: 30.002, lon: 106.002 } }
    store.setSectorTiming(markers)
    store.updateImportedClips(imported('first.mp4', 2_000, 2))
    expect(useProjectStore.getState().sectorTiming).toEqual(markers)
    store.setImported(imported('second.mp4', 1_000))
    expect(useProjectStore.getState().sectorTiming).toEqual({ s1: null, s2: null })
  })
  it('changes for replacements even when both projects start with the same clip path', () => {
    const first = imported('same.mp4', 1_000)
    const second = imported('same.mp4', 2_000)
    useProjectStore.getState().setImported(first)
    const firstGeneration = useProjectStore.getState().projectGeneration

    useProjectStore.getState().setImported(second)

    expect(useProjectStore.getState().projectGeneration).toBe(firstGeneration + 1)
  })

  it('stays stable when clips are appended to the current project', () => {
    useProjectStore.getState().setImported(imported('first.mp4', 1_000))
    const generation = useProjectStore.getState().projectGeneration

    useProjectStore.getState().updateImportedClips(imported('first.mp4', 2_000, 2))

    expect(useProjectStore.getState().projectGeneration).toBe(generation)
  })
})

describe('ignored (manually deleted) crossings', () => {
  it('marks and restores a crossing by its raw index', () => {
    useProjectStore.getState().ignoreCrossing(2)
    expect(useProjectStore.getState().ignoredCrossings).toEqual({ '2': true })

    useProjectStore.getState().restoreCrossing(2)
    expect(useProjectStore.getState().ignoredCrossings).toEqual({})
  })

  it('clears ignored crossings (and nudge adjustments) when startFinish changes', () => {
    useProjectStore.getState().nudgeCrossing(0, 500)
    useProjectStore.getState().ignoreCrossing(1)

    useProjectStore.getState().setStartFinish({ lat: 1, lon: 2 })

    expect(useProjectStore.getState().crossingAdjustmentsMs).toEqual({})
    expect(useProjectStore.getState().ignoredCrossings).toEqual({})
  })

  it('also clears ignored crossings and nudge adjustments when the detection radius changes', () => {
    // A different radius can reshuffle the RAW detection order those are keyed by -- stale entries
    // must not silently apply to a different lap after the radius changes.
    useProjectStore.getState().nudgeCrossing(0, 500)
    useProjectStore.getState().ignoreCrossing(1)

    useProjectStore.getState().setStartFinishRadiusM(10)

    expect(useProjectStore.getState().startFinishRadiusM).toBe(10)
    expect(useProjectStore.getState().crossingAdjustmentsMs).toEqual({})
    expect(useProjectStore.getState().ignoredCrossings).toEqual({})
  })
})
