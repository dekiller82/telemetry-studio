import { describe, expect, it, vi } from 'vitest'
import { createTrimDragSession } from './trimDragSession'

describe('trim drag draft ownership', () => {
  it.each(['trimStart', 'trimEnd'] as const)('keeps 60 %s moves local and commits the release position exactly once', (mode) => {
    const range = { trimStartMs: 1000, trimEndMs: 10000 }
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const session = createTrimDragSession({ mode, range, durationMs: 12000, onPreview, onCommit })
    for (let index = 1; index <= 60; index++) session.preview(2000 + index)
    expect(onPreview).toHaveBeenCalledTimes(60)
    expect(onCommit).not.toHaveBeenCalled()
    expect(range).toEqual({ trimStartMs: 1000, trimEndMs: 10000 })
    session.commit(3000)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(mode === 'trimStart'
      ? { trimStartMs: 3000, trimEndMs: 10000 }
      : { trimStartMs: 1000, trimEndMs: 3000 })
    session.commit(4000)
    session.preview(4000)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenCalledTimes(60)
  })

  it.each([
    { mode: 'trimStart' as const, ms: -1000, expected: { trimStartMs: 0, trimEndMs: 10000 } },
    { mode: 'trimStart' as const, ms: 12000, expected: { trimStartMs: 9800, trimEndMs: 10000 } },
    { mode: 'trimEnd' as const, ms: 0, expected: { trimStartMs: 1000, trimEndMs: 1200 } },
    { mode: 'trimEnd' as const, ms: 13000, expected: { trimStartMs: 1000, trimEndMs: 12000 } }
  ])('preserves bounds and the minimum gap for $mode at $ms ms', ({ mode, ms, expected }) => {
    const onCommit = vi.fn()
    createTrimDragSession({ mode, range: { trimStartMs: 1000, trimEndMs: 10000 }, durationMs: 12000,
      onPreview: vi.fn(), onCommit }).commit(ms)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it('discards a cancelled gesture without changing the project', () => {
    const onCommit = vi.fn()
    const session = createTrimDragSession({ mode: 'trimStart', range: { trimStartMs: 0, trimEndMs: 1000 },
      durationMs: 1000, onPreview: vi.fn(), onCommit })
    session.preview(200)
    session.cancel()
    session.commit(300)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not produce negative trim times for recordings shorter than the normal gap', () => {
    const onCommit = vi.fn()
    createTrimDragSession({ mode: 'trimStart', range: { trimStartMs: 0, trimEndMs: 100 },
      durationMs: 100, onPreview: vi.fn(), onCommit }).commit(80)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({ trimStartMs: 0, trimEndMs: 100 })
  })
})
