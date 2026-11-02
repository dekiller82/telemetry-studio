/** One pending target, never a queue of decoder work.
 *
 * A previous version forced a new seek after `maxWaitMs` even when the media element still
 * reported `seeking`. That is dangerous for large GoPro files: Chromium can keep the old random
 * access decode alive while the next seek allocates another decode window, so a long drag can turn
 * into an unbounded native-memory spike. We now keep only the latest target and wait for the media
 * lifecycle to tell us that the current seek/source load is idle. `wake()` is deliberately explicit
 * so the caller can resume immediately from `loadeddata`/`seeked` without polling a stuck decoder
 * into another seek. */
export function createLatestSeekScheduler(options: {
  apply: (ms: number) => void
  busy: (ms: number) => boolean
  intervalMs?: number
}) {
  const interval = options.intervalMs ?? 180
  const retryInterval = Math.min(50, interval)
  let pending: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastApplied = -Infinity
  let disposed = false

  const pump = (): void => {
    timer = null
    if (disposed || pending === null) return
    const now = Date.now()
    // Never issue a second seek while the media element is still resolving the previous one. The
    // pending slot is intentionally left intact, so rapid dragging still lands on the latest
    // release position without building a native decoder queue.
    if (options.busy(pending)) {
      timer = setTimeout(pump, retryInterval)
      return
    }
    const waitForInterval = interval - (now - lastApplied)
    if (waitForInterval > 0) {
      timer = setTimeout(pump, waitForInterval)
      return
    }
    const target = pending
    pending = null
    lastApplied = now
    options.apply(target)
  }

  return {
    request(ms: number): void {
      if (disposed || !Number.isFinite(ms)) return
      pending = ms
      if (timer === null) pump()
    },
    hasPending: () => pending !== null,
    /** Wake a pending request after the media element reports that its current operation settled. */
    wake(): void {
      if (disposed || pending === null) return
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pump()
    },
    /** Drop a target that has not reached the media element yet.
     *
     * This is used when an interactive scrub starts: the UI can preview telemetry positions while
     * deliberately keeping Chromium's native decoder at its current frame. An already-dispatched
     * seek cannot be cancelled here, but no additional decoder work will be issued for the drag. */
    cancelPending(): void {
      pending = null
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    dispose(): void {
      disposed = true
      pending = null
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
  }
}

/** Replacing the resource is recovery, not a second seek into the busy decoder. */
export function isMediaSeekBusy(state: {
  targetIsActiveClip: boolean
  hasMetadata: boolean
  mediaSeeking: boolean
  clipLoadPending: boolean
  mediaFailed: boolean
}): boolean {
  // A chapter switch replaces the old source via load(). Waiting for that old source can
  // deadlock forever after a stalled load, failed fallback, or abandoned pending seek.
  if (!state.targetIsActiveClip) return false
  if (state.mediaFailed) return true
  return !state.hasMetadata || state.mediaSeeking || state.clipLoadPending
}

/** Media progress owns the shared timeline only when no newer requested position is queued,
 * waiting on a clip load, or still being resolved by the media element itself. */
export function canSyncMediaTime(
  schedulerPending: boolean,
  clipLoadPending: boolean,
  mediaSeeking: boolean,
  scrubPreviewActive = false
): boolean {
  return !schedulerPending && !clipLoadPending && !mediaSeeking && !scrubPreviewActive
}
