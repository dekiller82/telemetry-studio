/** One pending target, never a queue of decoder work. Polling also recovers when a media
 * element never emits seeked (failed loads/source switches), without a rapid retry loop. */
export function createLatestSeekScheduler(options: {
  apply: (ms: number) => void
  busy: () => boolean
  intervalMs?: number
  maxWaitMs?: number
}) {
  const interval = options.intervalMs ?? 120
  const maxWait = options.maxWaitMs ?? 1500
  let pending: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastApplied = -Infinity
  let waitingSince: number | null = null
  let disposed = false

  const pump = (): void => {
    timer = null
    if (disposed || pending === null) return
    const now = Date.now()
    if (waitingSince === null) waitingSince = now
    if (now - lastApplied < interval || (options.busy() && now - waitingSince < maxWait)) {
      timer = setTimeout(pump, Math.max(1, Math.min(40, interval)))
      return
    }
    const target = pending
    pending = null
    waitingSince = null
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
    dispose(): void {
      disposed = true
      pending = null
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
  }
}

/** Media progress owns the shared timeline only when no newer requested position is queued,
 * waiting on a clip load, or still being resolved by the media element itself. */
export function canSyncMediaTime(
  schedulerPending: boolean,
  clipLoadPending: boolean,
  mediaSeeking: boolean
): boolean {
  return !schedulerPending && !clipLoadPending && !mediaSeeking
}
