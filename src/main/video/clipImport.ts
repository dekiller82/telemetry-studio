import { probeVideo } from './probe'
import { parseGoProTelemetry } from '../telemetry/parse'
import { stitchClipTelemetry } from '../../shared/telemetry/stitchClips'
import type { ClipInfo, ImportProgress, ImportResult, ImuSample, TelemetryData, VideoMeta } from '../../shared/types'

export interface ProbedClip {
  video: VideoMeta
  telemetry: TelemetryData
}

/** Throws a clear, specific error naming the mismatched clip rather than letting an inconsistent
 *  combination silently produce a broken stitched result or fail confusingly later in ffmpeg. */
export function validateClipsCompatible(clips: VideoMeta[]): void {
  if (clips.length === 0) return
  const first = clips[0]
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i]
    if (c.width !== first.width || c.height !== first.height) {
      throw new Error(
        `"${c.fileName}" is ${c.width}x${c.height}, but "${first.fileName}" is ${first.width}x${first.height} -- clips must all match resolution to be combined into one timeline.`
      )
    }
    if (Math.abs(c.fps - first.fps) > 0.01) {
      throw new Error(
        `"${c.fileName}" is ${c.fps.toFixed(2)}fps, but "${first.fileName}" is ${first.fps.toFixed(2)}fps -- clips must all match frame rate to be combined into one timeline.`
      )
    }
    if (c.hasAudio !== first.hasAudio) {
      throw new Error(
        `"${c.fileName}" ${c.hasAudio ? 'has' : 'has no'} audio track, but "${first.fileName}" ${first.hasAudio ? 'has' : 'has no'} -- can't combine clips with mixed audio presence.`
      )
    }
  }
}

export async function probeAndParseClip(
  filePath: string,
  clipIndex: number,
  totalClips: number,
  onProgress?: (progress: ImportProgress) => void
): Promise<ProbedClip> {
  const video = await probeVideo(filePath)
  const telemetry = await parseGoProTelemetry(filePath, video.durationMs, (progress) => {
    onProgress?.({ ...progress, clipIndex, totalClips })
  })
  return { video, telemetry }
}

/** Validates, computes each clip's position in the global timeline, and stitches telemetry. */
export function buildImportResult(probed: ProbedClip[]): ImportResult {
  validateClipsCompatible(probed.map((p) => p.video))

  const clips: ClipInfo[] = []
  let offsetMs = 0
  for (const p of probed) {
    clips.push({ video: p.video, startOffsetMs: offsetMs })
    offsetMs += p.video.durationMs
  }

  const telemetry = stitchClipTelemetry(probed.map((p) => ({ telemetry: p.telemetry, durationMs: p.video.durationMs })))

  // A single clip with no fix yet (e.g. the first chapter of a recording, started before GPS
  // locked) contributes zero samples but shouldn't fail the whole import -- see
  // normalizeGpsTelemetry's own doc comment. Only reject here, once every clip has been stitched
  // together, if the ENTIRE session has no usable GPS anywhere.
  if (telemetry.samples.length === 0) {
    throw new Error(
      'No usable GPS telemetry found in any selected clip. Make sure GPS was enabled and had a signal lock while recording (indoor tracks or covered areas often have no GPS signal).'
    )
  }

  return { clips, telemetry }
}

function sliceImuSamples(samples: ImuSample[], start: number, end: number): ImuSample[] {
  return samples.filter((s) => s.cts >= start && s.cts < end).map((s) => ({ ...s, cts: s.cts - start }))
}

/** Reconstructs a clip's own clip-local raw telemetry by slicing it back out of the already
 *  stitched global telemetry -- lets "add more clips" re-stitch everything without re-parsing
 *  GPMF for clips that were already imported (the expensive part). Same slice+offset treatment
 *  applies to the IMU streams (accel/gyro/gravity) as to GPS samples. */
export function sliceClipTelemetry(clip: ClipInfo, stitchedTelemetry: TelemetryData): TelemetryData {
  const start = clip.startOffsetMs
  const end = clip.startOffsetMs + clip.video.durationMs
  const samples = stitchedTelemetry.samples.filter((s) => s.cts >= start && s.cts < end).map((s) => ({ ...s, cts: s.cts - start }))
  return {
    deviceName: stitchedTelemetry.deviceName,
    gpsStream: stitchedTelemetry.gpsStream,
    samples,
    videoDurationMs: clip.video.durationMs,
    accel: sliceImuSamples(stitchedTelemetry.accel, start, end),
    gyro: sliceImuSamples(stitchedTelemetry.gyro, start, end),
    gravity: sliceImuSamples(stitchedTelemetry.gravity, start, end)
  }
}
