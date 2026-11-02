export interface TrimRange {
  trimStartMs: number
  trimEndMs: number
}

export type TrimDragMode = 'trimStart' | 'trimEnd'
const MIN_TRIM_GAP_MS = 200

/** A trim gesture owns a local draft. Only release may publish a new project range, so neither
 * GPS caches nor session summaries react to every mouse move. */
export function createTrimDragSession(options: {
  mode: TrimDragMode
  range: TrimRange
  durationMs: number
  onPreview: (range: TrimRange) => void
  onCommit: (range: TrimRange) => void
}) {
  const { mode, range, durationMs } = options
  const gap = Math.min(MIN_TRIM_GAP_MS, durationMs)
  let finished = false
  const rangeAt = (targetMs: number): TrimRange => {
    const ms = Math.min(durationMs, Math.max(0, targetMs))
    return mode === 'trimStart'
      ? { trimStartMs: Math.max(0, Math.min(ms, range.trimEndMs - gap)), trimEndMs: range.trimEndMs }
      : { trimStartMs: range.trimStartMs, trimEndMs: Math.min(durationMs, Math.max(ms, range.trimStartMs + gap)) }
  }
  return {
    preview(targetMs: number): void {
      if (!finished && Number.isFinite(targetMs)) options.onPreview(rangeAt(targetMs))
    },
    commit(targetMs: number): void {
      if (finished || !Number.isFinite(targetMs)) return
      finished = true
      options.onCommit(rangeAt(targetMs))
    },
    cancel(): void {
      finished = true
    }
  }
}
