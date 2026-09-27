import { CSSProperties, RefObject, useEffect, useRef, useState } from 'react'
import { toAppVideoUrl } from '@shared/fileUrl'
import { clipIndexAtGlobalMs, localMsWithinClip } from '@shared/timeline/clipTiming'
import { useProjectStore } from '../store/projectStore'
import { nextProxyStage, type ProxyStage } from './previewFallbackStage'
import { canSyncMediaTime, createLatestSeekScheduler } from './latestSeekScheduler'

/** Imperative seek API -- Editor.tsx creates one ref and hands it to both VideoPlayer (which
 *  populates it) and Timeline (which calls it). A direct method call has no state to go stale,
 *  unlike a store-field "seek request" mailbox that needs its own "was this consumed yet"
 *  bookkeeping across an inherently async clip switch. */
export interface PlayerApi {
  seekToGlobalMs(ms: number): void
}

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>
  style: CSSProperties
  playerApiRef: RefObject<PlayerApi | null>
}

const MEDIA_ERROR_MESSAGES: Record<number, string> = {
  1: 'Loading was aborted.',
  2: 'A network error interrupted loading.',
  3: "This clip's video could not be decoded — the codec may not be supported for preview.",
  4: "This clip's format/codec isn't supported for preview (MEDIA_ERR_SRC_NOT_SUPPORTED)."
}

/** Codec/format errors are worth retrying via a transcoded proxy; aborts/network errors are not. */
function isFormatError(code: number): boolean {
  return code === 3 || code === 4
}

type LoadState = 'loading' | 'ready' | 'transcoding' | 'error'

interface PendingSeek {
  generation: number
  targetSec: number
}

function VideoPlayer({ videoRef, style, playerApiRef }: Props): React.JSX.Element | null {
  const imported = useProjectStore((s) => s.imported)
  const projectGeneration = useProjectStore((s) => s.projectGeneration)
  const trimEndMs = useProjectStore((s) => s.trimEndMs)
  const setCurrentTimeMs = useProjectStore((s) => s.setCurrentTimeMs)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)

  const [activeClipIndex, setActiveClipIndex] = useState(0)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [transcodeProgress, setTranscodeProgress] = useState(0)
  // Starts at the active clip's original file (full-res, no transcode); only swapped to a proxy
  // path if native playback fails.
  const [srcPath, setSrcPath] = useState<string | null>(null)

  // Per-clip fallback-ladder position -- see previewFallbackStage.ts's nextProxyStage for why this
  // needs to be a full stage, not just a single "did we try a proxy yet" boolean.
  const proxyStageRef = useRef<Map<number, ProxyStage>>(new Map())
  // Bumped every time the active clip actually changes -- guards every async continuation
  // (proxy-fallback .then(), the pending-seek-on-loadeddata handler) against applying a result
  // for a clip the user has since scrubbed away from.
  const generationRef = useRef(0)
  const pendingSeekRef = useRef<PendingSeek | null>(null)
  // Set right before advancing to the next clip on 'ended' during playback, so playback resumes
  // automatically once that next clip is actually ready rather than just silently stopping.
  const resumeOnLoadRef = useRef(false)
  const seekSchedulerRef = useRef<ReturnType<typeof createLatestSeekScheduler> | null>(null)
  const applySeekRef = useRef<(ms: number) => void>(() => {})

  const activeClip = imported?.clips[activeClipIndex] ?? null

  // A full project replacement disposes queued work even when the old and new projects happen to
  // begin with the same video. Adding clips keeps the generation stable and preserves playback.
  useEffect(() => {
    const scheduler = createLatestSeekScheduler({
      apply: (ms) => applySeekRef.current(ms),
      busy: () => {
        const el = videoRef.current
        return !el || el.seeking || el.readyState < HTMLMediaElement.HAVE_METADATA || pendingSeekRef.current !== null
      }
    })
    seekSchedulerRef.current = scheduler
    return () => {
      scheduler.dispose()
      seekSchedulerRef.current = null
    }
  }, [projectGeneration, videoRef])
  useEffect(() => {
    setActiveClipIndex(0)
    proxyStageRef.current = new Map()
    pendingSeekRef.current = null
  }, [projectGeneration])

  // Single authoritative place that bumps `generationRef` -- fires whenever the active clip
  // actually changes, whether via seekToGlobalMs (a user scrub) or the 'ended' handler (natural
  // advance to the next clip). Re-stamps any already-pending seek with the fresh generation so
  // onLoadedData's later check lines up, rather than seekToGlobalMs needing to predict it.
  useEffect(() => {
    generationRef.current += 1
    if (pendingSeekRef.current) pendingSeekRef.current.generation = generationRef.current
    setSrcPath(activeClip ? activeClip.video.path : null)
    setLoadState('loading')
    setErrorMessage(null)
  }, [activeClipIndex, activeClip])

  useEffect(() => {
    return window.api.onPreviewProxyProgress(({ fraction }) => setTranscodeProgress(fraction))
  }, [])

  // Changing the `src` attribute alone doesn't reliably restart loading once the element has
  // already entered an error state (Chromium quirk) -- explicitly call load() to force a clean
  // reattempt whenever the source path changes, including the native -> proxy fallback swap.
  useEffect(() => {
    const el = videoRef.current
    if (!el || !srcPath) return
    console.log('[video] (re)loading src:', srcPath)
    el.load()
  }, [videoRef, srcPath])

  useEffect(() => {
    applySeekRef.current = (ms: number): void => {
      if (!imported) return
      const el = videoRef.current
      if (!el) return
      const targetClipIndex = clipIndexAtGlobalMs(imported.clips, ms)
      if (targetClipIndex === -1) return
      const targetClip = imported.clips[targetClipIndex]
      const targetLocalSec = localMsWithinClip(targetClip, ms) / 1000
      // currentSrc guards the interval between changing clips and the new resource loading.
      // Metadata is sufficient to seek, even if a stalled source never emits loadeddata.
      if (
        targetClipIndex === activeClipIndex &&
        el.readyState >= HTMLMediaElement.HAVE_METADATA &&
        srcPath &&
        el.currentSrc === toAppVideoUrl(srcPath)
      ) {
        pendingSeekRef.current = null
        el.currentTime = targetLocalSec
        return
      }
      pendingSeekRef.current = { generation: generationRef.current, targetSec: targetLocalSec }
      if (targetClipIndex !== activeClipIndex) setActiveClipIndex(targetClipIndex)
    }
    playerApiRef.current = {
      seekToGlobalMs(ms: number): void {
        if (!imported || !Number.isFinite(ms) || clipIndexAtGlobalMs(imported.clips, ms) === -1) return
        // Widgets follow the latest requested time immediately, even while the decoder catches up.
        setCurrentTimeMs(ms)
        seekSchedulerRef.current?.request(ms)
      }
    }
    return () => {
      playerApiRef.current = null
    }
  }, [playerApiRef, videoRef, imported, activeClipIndex, srcPath, setCurrentTimeMs])

  useEffect(() => {
    const el = videoRef.current
    if (!el || !imported || !activeClip) return

    // `timeupdate` fires at most ~4-66Hz depending on the browser and isn't tied to display
    // refresh, so anything driven by it (the GPS dot, the timer's centiseconds) visibly steps
    // instead of moving smoothly. Drive a rAF loop while playing instead, for a per-frame update;
    // fall back to `seeked`/`pause` for the paused/scrubbing case where no rAF loop is running.
    let rafId: number | null = null
    const mediaMayOwnTimeline = (): boolean =>
      canSyncMediaTime(
        Boolean(seekSchedulerRef.current?.hasPending()),
        pendingSeekRef.current !== null,
        el.seeking
      )
    const tick = (): void => {
      const globalMs = activeClip.startOffsetMs + el.currentTime * 1000
      if (mediaMayOwnTimeline()) setCurrentTimeMs(globalMs)
      if (globalMs >= trimEndMs) {
        el.pause()
        return
      }
      rafId = requestAnimationFrame(tick)
    }
    const startLoop = (): void => {
      if (rafId === null) rafId = requestAnimationFrame(tick)
    }
    const stopLoop = (): void => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    }

    const onPlay = (): void => {
      setIsPlaying(true)
      startLoop()
    }
    const onPause = (): void => {
      setIsPlaying(false)
      stopLoop()
      syncTime()
    }
    const syncTime = (): void => {
      if (mediaMayOwnTimeline()) {
        setCurrentTimeMs(activeClip.startOffsetMs + el.currentTime * 1000)
      }
    }
    const onSeeked = syncTime
    const onLoadedData = (): void => {
      console.log('[video] loadeddata:', srcPath)
      setLoadState('ready')

      const pending = pendingSeekRef.current
      if (pending && pending.generation === generationRef.current) {
        el.currentTime = pending.targetSec
        pendingSeekRef.current = null
      }
      if (resumeOnLoadRef.current) {
        resumeOnLoadRef.current = false
        el.play().catch((err) => console.error('[video] auto-resume into next clip failed:', err))
      }
      syncTime()
    }

    // Advances to the next clip when one finishes during playback -- if this was the last clip,
    // or the trim-out point falls at/before this clip's own end, just let it pause naturally
    // (matches the original single-clip behavior).
    const onEnded = (): void => {
      const isLastClip = activeClipIndex >= imported.clips.length - 1
      const clipEndMs = activeClip.startOffsetMs + activeClip.video.durationMs
      if (isLastClip || clipEndMs >= trimEndMs) return
      resumeOnLoadRef.current = true
      setActiveClipIndex((i) => i + 1)
    }

    const onError = (): void => {
      const mediaError = el.error
      const code = mediaError?.code ?? 0
      console.error('[video] error event for src:', srcPath, 'code:', code, mediaError?.message)

      if (!isFormatError(code)) {
        setErrorMessage(mediaError ? (MEDIA_ERROR_MESSAGES[code] ?? `Video error (code ${code}).`) : 'Unknown video error.')
        setLoadState('error')
        return
      }

      const stage = proxyStageRef.current.get(activeClipIndex)
      const next = nextProxyStage(stage, Boolean(activeClip.video.lrvPath))

      if (next === null) {
        // Every tier (LRV if any, remux, real transcode) has been tried and none of them played --
        // nothing left to try.
        setErrorMessage(mediaError ? (MEDIA_ERROR_MESSAGES[code] ?? `Video error (code ${code}).`) : 'Unknown video error.')
        setLoadState('error')
        return
      }
      proxyStageRef.current.set(activeClipIndex, next)

      // GoPro's own LRV sidecar (see main/video/lrv.ts) is already a small, fast-start H.264 file,
      // so this is a simple src swap -- no transcode wait at all, and it also sidesteps the
      // slow-SD-card seek stall this same error path is often actually caused by (see README's
      // Known limitations), since the LRV is far smaller and faster to seek through than the original.
      if (next === 'lrv') {
        console.log('[video] native playback failed, trying LRV sidecar:', activeClip.video.lrvPath)
        setSrcPath(activeClip.video.lrvPath!)
        return
      }
      setLoadState('transcoding')
      setTranscodeProgress(0)
      const generationAtScheduling = generationRef.current
      const clipToFix = activeClip
      console.log(`[video] native playback failed, requesting preview proxy (${next}) for:`, clipToFix.video.path)
      window.api
        .ensurePreviewProxy(clipToFix.video, next === 'transcode')
        .then((proxyPath) => {
          // Stale -- the user has since scrubbed away from this clip; applying this now would
          // yank playback back to a clip they're no longer on.
          if (generationAtScheduling !== generationRef.current) return
          console.log('[video] proxy ready, switching src to:', proxyPath)
          setSrcPath(proxyPath)
        })
        .catch((err) => {
          if (generationAtScheduling !== generationRef.current) return
          console.error('[video] preview proxy fallback failed:', err)
          setErrorMessage(
            `Native preview isn't supported for this file, and generating a compatible preview also failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
          setLoadState('error')
        })
    }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('loadeddata', onLoadedData)
    el.addEventListener('ended', onEnded)
    el.addEventListener('error', onError)
    if (!el.paused) startLoop() // effect re-ran (e.g. src swap) while already playing
    return () => {
      stopLoop()
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('loadeddata', onLoadedData)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('error', onError)
    }
  }, [videoRef, setCurrentTimeMs, setIsPlaying, imported, activeClip, activeClipIndex, srcPath, trimEndMs])

  if (!imported || !srcPath) return null

  return (
    <>
      <video ref={videoRef} src={toAppVideoUrl(srcPath)} className="video-stage__video" style={style} />
      {loadState === 'loading' && (
        <div className="video-stage__status" style={style}>
          Loading preview…
        </div>
      )}
      {loadState === 'transcoding' && (
        <div className="video-stage__status video-stage__status--warning" style={style}>
          Native preview isn't supported for this file — preparing a compatible preview…{' '}
          {Math.round(transcodeProgress * 100)}%
        </div>
      )}
      {loadState === 'error' && (
        <div className="video-stage__status video-stage__status--error" style={style}>
          {errorMessage}
        </div>
      )}
    </>
  )
}

export default VideoPlayer
