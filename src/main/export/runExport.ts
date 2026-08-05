import { spawn } from 'child_process'
import ffmpegPathRaw from 'ffmpeg-static'
import type { ClipInfo, CrossingAdjustments, LatLon, WidgetInstance } from '../../shared/types'
import type { TelemetrySampler } from '../../shared/telemetry/sampleAt'
import { createFrameRenderer } from './frameRenderer'
import { selectVideoEncoder, CPU_ENCODER, type VideoEncoder } from './gpuEncoder'
import { resolveUnpackedBinaryPath } from '../app/binaryPath'

export interface ExportSettings {
  width: number
  height: number
  fps: number
  crf: number
  /** Use a hardware encoder (NVENC/QSV/AMF) if this machine actually has a working one; falls back to libx264 otherwise. Default true. */
  preferGpu?: boolean
  /** When set (a delivery preset was chosen, e.g. "YouTube 1080p"), switches rate control from
   *  quality-based (crf) to target-bitrate mode -- see gpuEncoder.ts's bitrateArgs. Undefined means
   *  the default "source quality" export, unchanged from before this field existed. */
  videoBitrateKbps?: number
  /** Only meaningful alongside videoBitrateKbps -- forces an AAC re-encode (even for the otherwise
   *  stream-copyable single-clip/no-trim case) so the delivery preset's audio bitrate is actually
   *  applied. Undefined (the default export) leaves audio untouched, exactly as before. */
  audioBitrateKbps?: number
}

/** Thrown when an export is stopped via a caller-provided AbortSignal (the user clicked Cancel) --
 *  distinguished from a genuine ffmpeg failure so callers don't show an "export failed" error, retry
 *  with a fallback encoder, or otherwise treat a deliberate stop as a crash. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelledError'
  }
}

export interface RunExportOptions {
  clips: ClipInfo[]
  outputPath: string
  widgets: WidgetInstance[]
  sampler: TelemetrySampler
  /** Shared by every widget that needs lap/sector detection. */
  startFinish: LatLon | null
  /** Manual per-crossing time corrections for startFinish -- see shared/types.ts's CrossingAdjustments. */
  crossingAdjustmentsMs: CrossingAdjustments
  /** Whole-sequence trim, global ms spanning all clips. */
  trimStartMs: number
  trimEndMs: number
  /** Project-wide default font (FORMULA1_FONT_ID or a real system font family) -- any widget's own
   *  fontFamily overrides this. */
  defaultFontFamily: string
  settings: ExportSettings
  onProgress?: (framesWritten: number, totalFrames: number) => void
  onEncoderSelected?: (label: string) => void
  /** Checked once per frame; aborting kills the in-flight ffmpeg process and rejects with
   *  ExportCancelledError instead of letting the frame loop run to completion. */
  signal?: AbortSignal
}

/** This clip's own local seconds for a global-timeline ms position, clamped to [0, its own duration]
 *  -- a global position outside this clip's own range collapses to a safe no-op trim boundary
 *  (0 or the clip's full length) rather than a negative/out-of-range value. */
function clipLocalSeconds(clip: ClipInfo, globalMs: number): number {
  const localMs = globalMs - clip.startOffsetMs
  return Math.max(0, Math.min(clip.video.durationMs, localMs)) / 1000
}

/** AAC bitrate flag for a delivery preset, if one applies -- ffmpeg's own AAC default (~128kbps)
 *  is used when audioBitrateKbps isn't set, same as before this option existed. */
function audioBitrateArgs(settings: ExportSettings): string[] {
  return settings.audioBitrateKbps ? ['-b:a', `${settings.audioBitrateKbps}k`] : []
}

/** Case A's (single clip, no trim) audio codec args. When no delivery preset is active
 *  (videoBitrateKbps undefined), this is EXACTLY the original unconditional `-c:a copy` -- a plain
 *  export stays byte-for-byte unchanged regardless of hasAudio, matching case A's existing
 *  `0:a?` map (ffmpeg's own `?` already skips cleanly when there's no audio stream). A delivery
 *  preset forces an AAC re-encode instead, since it implies a controlled deliverable rather than
 *  preserving the master's own audio untouched -- inert if the clip has no audio at all. */
function resolveStreamCopyableAudioArgs(settings: ExportSettings): string[] {
  return settings.videoBitrateKbps != null ? ['-c:a', 'aac', ...audioBitrateArgs(settings)] : ['-c:a', 'copy']
}

/** Cases B/C's (trim and/or multi-clip concat) audio codec args -- these already forced an AAC
 *  re-encode before delivery presets existed (trim/concat can't stream-copy), so the only change is
 *  adding a preset's own target bitrate on top when one is active. */
function resolveReencodedAudioArgs(hasAudio: boolean, settings: ExportSettings): string[] {
  return hasAudio ? ['-c:a', 'aac', ...audioBitrateArgs(settings)] : ['-an']
}

/**
 * A `,scale=W:H` filter suffix for a clip's own video chain, or '' when the clip is ALREADY that
 * exact size -- ffmpeg's `overlay` filter takes its output size from its base (bottom) input, which
 * is the source clip decoded at its own native resolution, NOT settings.width/height by itself.
 * Without this, a delivery preset's smaller settings.width/height would only resize the rendered
 * *overlay* frame (our own rawvideo pipe) while the actual source video underneath stayed at full
 * native resolution -- the overlay would end up covering just a small corner of an unshrunk frame.
 * Omitted entirely (not just a no-op scale=W:H) when dimensions already match, preserving the
 * default "source quality" export's byte-for-byte-unchanged filter graph.
 */
function scaleSuffixIfNeeded(clip: ClipInfo, settings: ExportSettings): string {
  return clip.video.width === settings.width && clip.video.height === settings.height ? '' : `,scale=${settings.width}:${settings.height}`
}

/**
 * Builds the full ffmpeg args for one encoder attempt. Three shapes, matched 1:1 to real CLI
 * verification done before this was wired in (see project memory) -- particularly the `-frames:v`
 * cap, which is NOT optional: ffmpeg's trim/concat filters can land on a frame count one off from
 * our own authoritative count due to boundary rounding, and the overlay filter pads with a
 * duplicated last frame to match whichever stream is longer if left uncapped.
 */
function buildFfmpegArgs(
  clips: ClipInfo[],
  settings: ExportSettings,
  trimStartMs: number,
  trimEndMs: number,
  totalFrames: number,
  encoder: VideoEncoder,
  outputPath: string
): string[] {
  const hasAudio = clips[0].video.hasAudio
  // When the selected encoder has a smoke-tested decodeHwaccel (see gpuEncoder.ts), every clip's
  // decode is offloaded to the GPU too -- otherwise only the final encode runs on the GPU while
  // software-decoding the source clip(s) on CPU becomes the real bottleneck. Must be repeated
  // before EACH input, not once globally.
  const inputArgs: string[] = []
  for (const clip of clips) {
    if (encoder.decodeHwaccel) inputArgs.push('-hwaccel', encoder.decodeHwaccel)
    inputArgs.push('-i', clip.video.path)
  }
  const overlayInputIndex = clips.length // the rawvideo pipe is the input right after every clip input

  const lastClip = clips[clips.length - 1]
  const sequenceEndMs = lastClip.startOffsetMs + lastClip.video.durationMs
  const needsTrim = trimStartMs > 0 || trimEndMs < sequenceEndMs

  let filterComplex: string
  let videoMapLabel: string
  let audioMapLabel: string | null
  let audioCodecArgs: string[]

  if (clips.length === 1 && !needsTrim && scaleSuffixIfNeeded(clips[0], settings) === '') {
    // Case A: exactly the ORIGINAL single-clip path, byte-for-byte unchanged -- zero risk to any
    // existing single-clip project. `0:a?` (bare stream specifier, not a filter-graph label) lets
    // ffmpeg's own `?` skip audio gracefully if the clip happens to have none. Only reachable when
    // no delivery preset needs to actually resize the output -- otherwise falls through to case B's
    // graph shape (which already has a real video filter chain to attach `scale=` to).
    filterComplex = `[${overlayInputIndex}:v]format=rgba[ov];[0:v][ov]overlay=0:0:format=auto[v]`
    videoMapLabel = '[v]'
    audioMapLabel = '0:a?'
    audioCodecArgs = resolveStreamCopyableAudioArgs(settings)
  } else if (clips.length === 1) {
    // Case B: single clip, trimmed and/or resized for a delivery preset. Either reason forces a
    // decode, so audio can't stay stream-copied.
    const startSec = clipLocalSeconds(clips[0], trimStartMs)
    const endSec = clipLocalSeconds(clips[0], trimEndMs)
    const parts = [`[0:v]trim=start=${startSec}:end=${endSec},setpts=PTS-STARTPTS${scaleSuffixIfNeeded(clips[0], settings)}[vtrim]`]
    if (hasAudio) parts.push(`[0:a]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS[atrim]`)
    parts.push(`[${overlayInputIndex}:v]format=rgba[ov]`, '[vtrim][ov]overlay=0:0:format=auto[v]')
    filterComplex = parts.join(';')
    videoMapLabel = '[v]'
    audioMapLabel = hasAudio ? '[atrim]' : null
    audioCodecArgs = resolveReencodedAudioArgs(hasAudio, settings)
  } else {
    // Case C: N>1 clips, concatenated. Start-trim only applies to the first clip, end-trim only
    // to the last (both are safe no-ops when not actually needed, via clipLocalSeconds' clamping,
    // so the same graph shape covers "no trim at all" too). Concat's pins are interleaved PER
    // SEGMENT ([v0][a0][v1][a1]...), not grouped by kind.
    const segmentParts: string[] = []
    const concatPins: string[] = []
    clips.forEach((clip, i) => {
      const isFirst = i === 0
      const isLast = i === clips.length - 1
      const vLabel = `v${i}`
      const aLabel = `a${i}`

      const scaleSuffix = scaleSuffixIfNeeded(clip, settings)
      if (isFirst && isLast) {
        const startSec = clipLocalSeconds(clip, trimStartMs)
        const endSec = clipLocalSeconds(clip, trimEndMs)
        segmentParts.push(`[${i}:v]trim=start=${startSec}:end=${endSec},setpts=PTS-STARTPTS${scaleSuffix}[${vLabel}]`)
        if (hasAudio) segmentParts.push(`[${i}:a]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS[${aLabel}]`)
      } else if (isFirst) {
        const startSec = clipLocalSeconds(clip, trimStartMs)
        segmentParts.push(`[${i}:v]trim=start=${startSec},setpts=PTS-STARTPTS${scaleSuffix}[${vLabel}]`)
        if (hasAudio) segmentParts.push(`[${i}:a]atrim=start=${startSec},asetpts=PTS-STARTPTS[${aLabel}]`)
      } else if (isLast) {
        const endSec = clipLocalSeconds(clip, trimEndMs)
        segmentParts.push(`[${i}:v]trim=end=${endSec},setpts=PTS-STARTPTS${scaleSuffix}[${vLabel}]`)
        if (hasAudio) segmentParts.push(`[${i}:a]atrim=end=${endSec},asetpts=PTS-STARTPTS[${aLabel}]`)
      } else {
        segmentParts.push(`[${i}:v]setpts=PTS-STARTPTS${scaleSuffix}[${vLabel}]`)
        if (hasAudio) segmentParts.push(`[${i}:a]asetpts=PTS-STARTPTS[${aLabel}]`)
      }

      concatPins.push(`[${vLabel}]`)
      if (hasAudio) concatPins.push(`[${aLabel}]`)
    })

    const concatOutputs = hasAudio ? '[vconcat][aconcat]' : '[vconcat]'
    segmentParts.push(`${concatPins.join('')}concat=n=${clips.length}:v=1:a=${hasAudio ? 1 : 0}${concatOutputs}`)
    segmentParts.push(`[${overlayInputIndex}:v]format=rgba[ov]`, '[vconcat][ov]overlay=0:0:format=auto[vout]')

    filterComplex = segmentParts.join(';')
    videoMapLabel = '[vout]'
    audioMapLabel = hasAudio ? '[aconcat]' : null
    audioCodecArgs = resolveReencodedAudioArgs(hasAudio, settings)
  }

  const args = [
    '-y',
    ...inputArgs,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${settings.width}x${settings.height}`,
    '-r',
    String(settings.fps),
    '-i',
    'pipe:0',
    '-filter_complex',
    filterComplex,
    '-map',
    videoMapLabel
  ]
  if (audioMapLabel) args.push('-map', audioMapLabel)
  args.push('-frames:v', String(totalFrames))
  const videoRateControlArgs =
    settings.videoBitrateKbps != null
      ? encoder.bitrateArgs(settings.videoBitrateKbps)
      : encoder.qualityArgs(settings.crf, settings.width, settings.height, settings.fps)
  args.push('-c:v', encoder.codec, ...videoRateControlArgs, '-pix_fmt', 'yuv420p', ...audioCodecArgs, outputPath)
  return args
}

/** Runs one full ffmpeg pass with a specific encoder. Rejects (without partial output left behind by ffmpeg's own -y overwrite semantics) if that encoder fails partway through. */
function runWithEncoder(
  resolvedFfmpegPath: string,
  encoder: VideoEncoder,
  clips: ClipInfo[],
  outputPath: string,
  settings: ExportSettings,
  trimStartMs: number,
  trimEndMs: number,
  totalFrames: number,
  renderFrame: (sampleCts: number, elapsedMs: number) => Buffer,
  onProgress?: (framesWritten: number, totalFrames: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const args = buildFfmpegArgs(clips, settings, trimStartMs, trimEndMs, totalFrames, encoder, outputPath)

  return new Promise((resolveOuter, rejectOuter) => {
    void (async () => {
      const ff = spawn(resolvedFfmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })

      let stderrTail = ''
      ff.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000)
      })

      let writeError: unknown = null
      ff.stdin.on('error', (err) => {
        writeError = err
      })

      const exitPromise = new Promise<void>((resolve, reject) => {
        ff.on('error', reject)
        ff.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg (${encoder.label}) exited with code ${code}\n${stderrTail}`))
        })
      })

      let cancelled = false
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        if (writeError) break
        if (signal?.aborted) {
          cancelled = true
          break
        }

        const elapsedMs = (frameIndex / settings.fps) * 1000
        const sampleCts = trimStartMs + elapsedMs
        const frameBuffer = renderFrame(sampleCts, elapsedMs)

        try {
          const canWriteMore = ff.stdin.write(frameBuffer)
          if (!canWriteMore) {
            await new Promise<void>((resolve) => ff.stdin.once('drain', resolve))
          }
        } catch (err) {
          writeError = err
          break
        }

        onProgress?.(frameIndex + 1, totalFrames)
      }

      if (cancelled) {
        // Kill outright rather than a graceful stdin.end() -- there's no output worth finishing,
        // and closing stdin normally would just make ffmpeg run to completion on the frames already
        // buffered/written so far instead of stopping promptly.
        ff.kill()
      } else {
        try {
          ff.stdin.end()
        } catch {
          // stream may already be closed if ffmpeg exited early; the real error surfaces via exitPromise
        }
      }

      try {
        await exitPromise
        if (cancelled) rejectOuter(new ExportCancelledError())
        else resolveOuter()
      } catch (err) {
        rejectOuter(cancelled ? new ExportCancelledError() : err)
      }
    })()
  })
}

export async function runExport(options: RunExportOptions): Promise<void> {
  const {
    clips,
    outputPath,
    widgets,
    sampler,
    startFinish,
    crossingAdjustmentsMs,
    trimStartMs,
    trimEndMs,
    defaultFontFamily,
    settings,
    onProgress,
    onEncoderSelected,
    signal
  } = options

  const ffmpegPath = resolveUnpackedBinaryPath(ffmpegPathRaw)
  if (!ffmpegPath) throw new Error('Bundled ffmpeg binary not found for this platform')
  if (widgets.length === 0) throw new Error('No widgets to export')
  if (clips.length === 0) throw new Error('No clips to export')
  const resolvedFfmpegPath: string = ffmpegPath

  const totalFrames = Math.max(1, Math.round(((trimEndMs - trimStartMs) / 1000) * settings.fps))
  const renderFrame = await createFrameRenderer(
    settings.width,
    settings.height,
    widgets,
    sampler,
    startFinish,
    crossingAdjustmentsMs,
    trimEndMs,
    trimStartMs,
    defaultFontFamily
  )

  const encoder = await selectVideoEncoder(resolvedFfmpegPath, settings.preferGpu ?? true)
  console.log(`[export] using video encoder: ${encoder.label} (${encoder.codec})`)
  onEncoderSelected?.(encoder.label)

  try {
    await runWithEncoder(resolvedFfmpegPath, encoder, clips, outputPath, settings, trimStartMs, trimEndMs, totalFrames, renderFrame, onProgress, signal)
  } catch (err) {
    // A deliberate cancellation is never retried with a fallback encoder -- there's nothing to
    // recover from, the user asked to stop.
    if (err instanceof ExportCancelledError) throw err
    // The quick smoke-test in selectVideoEncoder can pass while the real export (much larger
    // resolution/duration) still hits a GPU-specific limit -- fall back to CPU once rather than
    // failing the whole export outright.
    if (encoder.codec === CPU_ENCODER.codec) throw err
    console.warn(`[export] ${encoder.label} failed mid-export, retrying with CPU encoder:`, err)
    onEncoderSelected?.(`${CPU_ENCODER.label} (fallback after ${encoder.label} failed)`)
    await runWithEncoder(resolvedFfmpegPath, CPU_ENCODER, clips, outputPath, settings, trimStartMs, trimEndMs, totalFrames, renderFrame, onProgress, signal)
  }
}
