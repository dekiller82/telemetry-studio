/** Escalation ladder VideoPlayer.tsx works through when the <video> element fails to play a clip's
 *  source with a format/codec error (MediaError code 3 or 4):
 *   - 'lrv': GoPro's own low-res sidecar proxy, when one exists -- cheapest, no transcode wait.
 *   - 'remux': a fast stream-copy into a clean container -- fixes container/metadata quirks, but
 *     does NOT change the video codec.
 *   - 'transcode': a real VP9/WebM re-encode -- the only tier that can fix a genuinely undecodable
 *     source codec, since remux (and the LRV, which is just as much a straight copy of the original
 *     encode) never touch it.
 */
export type ProxyStage = 'lrv' | 'remux' | 'transcode'

export interface InitialPreviewSource {
  path: string
  /** The fallback stage already represented by `path`, if it is a sidecar/proxy. */
  stage: ProxyStage | undefined
}

/** Start live preview from the original; proxies are only used after a playback format error. */
export function initialPreviewSource(videoPath: string): InitialPreviewSource {
  return { path: videoPath, stage: undefined }
}

/**
 * Decides the next tier to try after a format-error event, given what's already been tried for
 * this clip and whether an LRV sidecar is available. Returns null once every tier is exhausted.
 *
 * The key case this exists to get right: a "successful" remux is NOT proof the result is actually
 * playable -- ffmpeg happily stream-copies a codec it can't itself decode, so the remuxed file can
 * fail with the exact same error as the original. `currentStage === 'remux'` (a remux was already
 * tried and it ALSO just failed) is what triggers escalating to the real re-encode instead of
 * reporting the same generic "unsupported" error a second time.
 */
export function nextProxyStage(currentStage: ProxyStage | undefined, hasLrv: boolean): ProxyStage | null {
  if (!currentStage && hasLrv) return 'lrv'
  if (currentStage === 'transcode') return null
  return currentStage === 'remux' ? 'transcode' : 'remux'
}
