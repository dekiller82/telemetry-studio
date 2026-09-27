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
  useProjectStore.setState({ imported: null, projectGeneration: 0, currentTimeMs: 0, trimStartMs: 0, trimEndMs: 0 })
})

describe('project replacement generation', () => {
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
