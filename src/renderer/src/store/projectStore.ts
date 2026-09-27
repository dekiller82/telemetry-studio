import { create } from 'zustand'
import type { CrossingAdjustments, ImportResult, LatLon } from '@shared/types'
import { FORMULA1_FONT_ID } from '@shared/render/fonts'

interface ProjectState {
  imported: ImportResult | null
  /** Monotonic identity for a full project/import replacement. Unlike the imported object itself,
   *  this deliberately does not change when "+ Add Clip" extends the current project. */
  projectGeneration: number
  /** Position within the GLOBAL stitched timeline (spans every clip), ms. */
  currentTimeMs: number
  isPlaying: boolean
  /** Shared by every widget that needs lap/sector detection (timer in laps mode, sectorTimer, and
   *  any future widget with the same need) -- set once, used everywhere. */
  startFinish: LatLon | null
  /** Manual per-crossing time corrections for startFinish, keyed by crossing index (see
   *  shared/types.ts's CrossingAdjustments) -- corrects the lap-crossing heuristic registering a
   *  crossing a few frames early/late on a particular lap. Reset whenever startFinish changes,
   *  since a different point recomputes a different crossings array where the same index may no
   *  longer refer to the same lap. */
  crossingAdjustmentsMs: CrossingAdjustments
  /** Whole-sequence trim, global ms spanning all clips. */
  trimStartMs: number
  trimEndMs: number
  /** Project-wide default font -- FORMULA1_FONT_ID or a real OS-installed font family name. Any
   *  widget's own fontFamily overrides this when set. */
  defaultFontFamily: string
  /** True for the duration of a real export -- the export pipeline already works from a one-time
   *  snapshot of `widgets` copied over IPC at the moment Export was clicked (structured-clone, not a
   *  live reference), so editing widgets afterward can never actually change that export's output.
   *  This flag exists purely so the UI can lock widget drag/resize and property-panel editing while
   *  it runs, to avoid the "did that just affect my export?" ambiguity, not to fix a real bug. */
  isExporting: boolean
  setImported: (imported: ImportResult | null) => void
  /** Appending more clips to an in-progress edit -- unlike setImported, this does NOT reset the
   *  playhead/startFinish/trim (the user is extending their existing timeline, not starting a new
   *  one). If trim previously extended to the old sequence's end, it's extended to the new end too
   *  (newly added clips are included in the export range by default); an explicit trim point
   *  somewhere in the middle is left alone. */
  updateImportedClips: (imported: ImportResult) => void
  setCurrentTimeMs: (ms: number) => void
  setIsPlaying: (playing: boolean) => void
  setStartFinish: (latLon: LatLon | null) => void
  /** Loading a saved project restores its own crossing adjustments verbatim (unlike setStartFinish,
   *  which always resets them -- a freshly loaded project didn't just "change" its start/finish
   *  point, it's opening with whatever was already saved for it). */
  setCrossingAdjustmentsMs: (adjustments: CrossingAdjustments) => void
  /** Nudges one crossing's correction by deltaMs (additive -- repeated clicks accumulate). */
  nudgeCrossing: (index: number, deltaMs: number) => void
  /** Clears a single crossing's correction back to zero. */
  resetCrossingAdjustment: (index: number) => void
  setTrim: (trimStartMs: number, trimEndMs: number) => void
  setDefaultFontFamily: (defaultFontFamily: string) => void
  setIsExporting: (isExporting: boolean) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  imported: null,
  projectGeneration: 0,
  currentTimeMs: 0,
  isPlaying: false,
  startFinish: null,
  crossingAdjustmentsMs: {},
  trimStartMs: 0,
  trimEndMs: 0,
  defaultFontFamily: FORMULA1_FONT_ID,
  isExporting: false,
  setImported: (imported) =>
    set((state) => ({
      imported,
      projectGeneration: state.projectGeneration + 1,
      currentTimeMs: 0,
      isPlaying: false,
      startFinish: null,
      crossingAdjustmentsMs: {},
      trimStartMs: 0,
      trimEndMs: imported?.telemetry.videoDurationMs ?? 0,
      defaultFontFamily: FORMULA1_FONT_ID
    })),
  updateImportedClips: (imported) =>
    set((state) => ({
      imported,
      trimEndMs:
        state.imported && state.trimEndMs >= state.imported.telemetry.videoDurationMs
          ? imported.telemetry.videoDurationMs
          : state.trimEndMs
    })),
  setCurrentTimeMs: (currentTimeMs) => set({ currentTimeMs }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setStartFinish: (startFinish) => set({ startFinish, crossingAdjustmentsMs: {} }),
  setCrossingAdjustmentsMs: (crossingAdjustmentsMs) => set({ crossingAdjustmentsMs }),
  nudgeCrossing: (index, deltaMs) =>
    set((state) => {
      const key = String(index)
      const current = state.crossingAdjustmentsMs[key] ?? 0
      return { crossingAdjustmentsMs: { ...state.crossingAdjustmentsMs, [key]: current + deltaMs } }
    }),
  resetCrossingAdjustment: (index) =>
    set((state) => {
      const key = String(index)
      if (!(key in state.crossingAdjustmentsMs)) return {}
      const next = { ...state.crossingAdjustmentsMs }
      delete next[key]
      return { crossingAdjustmentsMs: next }
    }),
  setTrim: (trimStartMs, trimEndMs) => set({ trimStartMs, trimEndMs }),
  setDefaultFontFamily: (defaultFontFamily) => set({ defaultFontFamily }),
  setIsExporting: (isExporting) => set({ isExporting })
}))
