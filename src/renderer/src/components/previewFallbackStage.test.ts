import { describe, expect, it } from 'vitest'
import { initialPreviewSource, nextProxyStage } from './previewFallbackStage'

describe('initialPreviewSource', () => {
  it('uses the original GoPro MP4 for live preview', () => {
    expect(initialPreviewSource('GH010230.MP4')).toEqual({ path: 'GH010230.MP4', stage: undefined })
  })

  it('also uses the original source for videos without a sidecar', () => {
    expect(initialPreviewSource('camera.mp4')).toEqual({ path: 'camera.mp4', stage: undefined })
  })
})

describe('nextProxyStage', () => {
  it('tries the LRV sidecar first when one is available', () => {
    expect(nextProxyStage(undefined, true)).toBe('lrv')
  })

  it('skips straight to remux when no LRV sidecar exists', () => {
    expect(nextProxyStage(undefined, false)).toBe('remux')
  })

  it('escalates to remux after the LRV also fails, LRV still nominally available', () => {
    // hasLrv stays true (the sidecar still exists), but currentStage='lrv' means it was ALREADY
    // tried and failed -- must not loop back to 'lrv' again.
    expect(nextProxyStage('lrv', true)).toBe('remux')
  })

  it('escalates to remux after the LRV fails when there was never an LRV to begin with', () => {
    expect(nextProxyStage('lrv', false)).toBe('remux')
  })

  it('escalates from remux to a real transcode -- the key case: a remux that generated fine but did not play', () => {
    expect(nextProxyStage('remux', true)).toBe('transcode')
    expect(nextProxyStage('remux', false)).toBe('transcode')
  })

  it('returns null once the transcode tier has also failed -- nothing left to try', () => {
    expect(nextProxyStage('transcode', true)).toBeNull()
    expect(nextProxyStage('transcode', false)).toBeNull()
  })
})
