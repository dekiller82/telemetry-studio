import { afterEach, describe, expect, it, vi } from 'vitest'
import { canSyncMediaTime, createLatestSeekScheduler } from './latestSeekScheduler'

afterEach(() => vi.useRealTimers())

describe('latest seek scheduler', () => {
  it('bounds rapid requests and keeps the final release target', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => false })
    scheduler.request(0)
    for (let i = 1; i <= 500; i++) scheduler.request(i)
    expect(apply.mock.calls).toEqual([[0]])
    vi.advanceTimersByTime(120)
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
    vi.advanceTimersByTime(40)
    expect(apply).toHaveBeenCalledExactlyOnceWith(2000)
    scheduler.dispose()
  })

  it('recovers from missing media events without extending the deadline on each request', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const scheduler = createLatestSeekScheduler({ apply, busy: () => true })
    for (let i = 0; i < 15; i++) {
      scheduler.request(i)
      vi.advanceTimersByTime(100)
    }
    vi.advanceTimersByTime(40)
    expect(apply).toHaveBeenCalledExactlyOnceWith(14)
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
})
