type ProcessOutcome = { kind: 'closed' } | { kind: 'failed'; error: unknown }

/** Observe the child's rejection immediately and interrupt individual waits without accumulating
 * Promise.race handlers on one long-lived exit promise for every exported frame. */
export function createExportProcessWaiter(
  exitPromise: Promise<void>,
  signal: AbortSignal | undefined,
  cancellationError: () => Error
) {
  let outcome: ProcessOutcome | null = null
  const subscribers = new Set<() => void>()
  const notify = (): void => {
    for (const subscriber of [...subscribers]) subscriber()
  }
  // Both branches return normally: this observer itself can never become an unhandled rejection.
  void exitPromise.then(
    () => { outcome = { kind: 'closed' }; notify() },
    (error: unknown) => { outcome = { kind: 'failed', error }; notify() }
  )
  const onAbort = (): void => notify()
  signal?.addEventListener('abort', onAbort, { once: true })

  return {
    waitFor<T>(work: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (action: () => void): void => {
          if (settled) return
          settled = true
          subscribers.delete(onInterrupted)
          action()
        }
        const onInterrupted = (): void => {
          if (signal?.aborted) finish(() => reject(cancellationError()))
          else if (outcome?.kind === 'failed') {
            const error = outcome.error
            finish(() => reject(error))
          } else if (outcome?.kind === 'closed') {
            finish(() => reject(new Error('ffmpeg input closed before export completed')))
          }
        }
        // Always observe the work too, even if cancellation/exit wins and it rejects later.
        void work.then(
          (value) => { onInterrupted(); finish(() => resolve(value)) },
          (error: unknown) => { onInterrupted(); finish(() => reject(error)) }
        )
        subscribers.add(onInterrupted)
        onInterrupted()
      })
    },
    dispose(): void {
      signal?.removeEventListener('abort', onAbort)
      subscribers.clear()
    }
  }
}
