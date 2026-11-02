import { afterEach, describe, expect, it, vi } from 'vitest'
import { canSyncMediaTime, createLatestSeekScheduler, isMediaSeekBusy } from './latestSeekScheduler'

afterEach(() => vi.useRealTimers())

describe('latest seek scheduler', () => {
  it('bounds rapid requests and keeps the final release target', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => false })
    scheduler.request(0)
    for (let i = 1; i <= 500; i++) scheduler.request(i)
    expect(apply.mock.calls).toEqual([[0]])
    vi.advanceTimersByTime(180)
    expect(apply.mock.calls).toEqual([[0], [500]])
    expect(scheduler.hasPending()).toBe(false)
    scheduler.dispose()
  })

  it('waits for an in-flight seek/source load and replaces intermediate targets', () => {
    vi.useFakeTimers()
    let busy = true
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => busy })
    scheduler.request(10)
    vi.advanceTimersByTime(500)
    scheduler.request(2000)
    expect(apply).not.toHaveBeenCalled()
    busy = false
    scheduler.wake()
    expect(apply).toHaveBeenCalledExactlyOnceWith(2000)
    scheduler.dispose()
  })

  it('never dispatches another seek while the decoder remains busy', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => true })
    for (let i = 0; i < 15; i++) {
      scheduler.request(i)
      vi.advanceTimersByTime(100)
    }
    expect(apply).not.toHaveBeenCalled()
    scheduler.dispose()
  })

  it('applies the latest retained target when the media lifecycle wakes it', () => {
    vi.useFakeTimers()
    let busy = true
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => busy })
    scheduler.request(10)
    scheduler.request(20)
    busy = false
    scheduler.wake()
    expect(apply).toHaveBeenCalledExactlyOnceWith(20)
    scheduler.dispose()
  })

  it('drops queued decoder work when an interactive scrub starts', () => {
    vi.useFakeTimers()
    let busy = true
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => busy })
    scheduler.request(10)
    scheduler.request(20)
    scheduler.cancelPending()
    busy = false
    scheduler.wake()
    vi.runAllTimers()
    expect(apply).not.toHaveBeenCalled()
    expect(scheduler.hasPending()).toBe(false)
    scheduler.dispose()
  })

  it('cancels work on project replacement/unmount and rejects non-finite targets', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => true })
    scheduler.request(NaN)
    scheduler.request(Infinity)
    expect(scheduler.hasPending()).toBe(false)
    scheduler.request(42)
    scheduler.dispose()
    scheduler.request(99)
    vi.runAllTimers()
    expect(apply).not.toHaveBeenCalled()
  })

  it('limits a sustained stream even when the decoder completes immediately', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => false })
    for (let i = 0; i < 100; i++) {
      scheduler.request(i)
      vi.advanceTimersByTime(10)
    }
    expect(apply.mock.calls.length).toBeLessThanOrEqual(9)
    vi.advanceTimersByTime(200)
    expect(apply).toHaveBeenLastCalledWith(99)
    scheduler.dispose()
  })

  it('checks the latest target so navigation can leave a failed chapter', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const busy = vi.fn((ms: number) => ms < 3000)
    const scheduler = createLatestSeekScheduler({ apply, busy })
    scheduler.request(500)
    scheduler.request(3500)
    scheduler.wake()
    expect(busy).toHaveBeenLastCalledWith(3500)
    expect(apply).toHaveBeenCalledExactlyOnceWith(3500)
    scheduler.dispose()
  })
})

describe('media seek readiness', () => {
  const ready = {
    targetIsActiveClip: false,
    hasMetadata: true,
    mediaSeeking: false,
    clipLoadPending: false,
    mediaFailed: false
  }

  it.each(['hasMetadata', 'mediaSeeking', 'clipLoadPending'] as const)(
    'keeps same-chapter seeks waiting while %s is unresolved',
    (field) => {
      const state = { ...ready, targetIsActiveClip: true, [field]: field !== 'hasMetadata' }
      expect(isMediaSeekBusy(state)).toBe(true)
    }
  )

  it('allows normal navigation once decoding and source loading settle', () => {
    expect(isMediaSeekBusy(ready)).toBe(false)
    expect(isMediaSeekBusy({ ...ready, targetIsActiveClip: true })).toBe(false)
  })

  it('lets navigation replace a failed source even with an unresolved clip seek', () => {
    expect(isMediaSeekBusy({ ...ready, hasMetadata: false, clipLoadPending: true, mediaFailed: true })).toBe(false)
  })

  it('does not send another native seek to the same failed source', () => {
    expect(isMediaSeekBusy({ ...ready, targetIsActiveClip: true, mediaFailed: true })).toBe(true)
  })

  it('escapes a stalled old chapter but waits for the replacement decoder before seeking again', () => {
    vi.useFakeTimers()
    let activeChapter = 0
    let state = { ...ready, hasMetadata: false, mediaSeeking: true, clipLoadPending: true }
    const apply = vi.fn((ms: number) => {
      activeChapter = Math.floor(ms / 3000)
      state = { ...state, hasMetadata: false, mediaSeeking: false, clipLoadPending: true }
    })
    const scheduler = createLatestSeekScheduler({ apply, busy: (ms) => isMediaSeekBusy({
      ...state, targetIsActiveClip: Math.floor(ms / 3000) === activeChapter
    }) })
    scheduler.request(500)
    vi.advanceTimersByTime(2000)
    expect(apply).not.toHaveBeenCalled()
    scheduler.request(3500)
    scheduler.wake()
    expect(apply).toHaveBeenCalledExactlyOnceWith(3500)
    scheduler.request(3900)
    vi.advanceTimersByTime(2000)
    expect(apply).toHaveBeenCalledTimes(1)
    state = { ...state, hasMetadata: true, mediaSeeking: false, clipLoadPending: false }
    scheduler.wake()
    expect(apply).toHaveBeenLastCalledWith(3900)
    expect(apply).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })
})

describe('media timeline ownership', () => {
  it('keeps the requested widget time while a same-clip media seek is in flight', () => {
    expect(canSyncMediaTime(false, false, true)).toBe(false)
  })

  it('blocks stale media progress for queued and cross-clip pending targets', () => {
    expect(canSyncMediaTime(true, false, false)).toBe(false)
    expect(canSyncMediaTime(false, true, false)).toBe(false)
  })

  it('returns timeline ownership only after every seek state settles', () => {
    expect(canSyncMediaTime(false, false, false)).toBe(true)
  })

  it('does not let a paused media event overwrite the telemetry-only scrub preview', () => {
    expect(canSyncMediaTime(false, false, false, true)).toBe(false)
  })
})
