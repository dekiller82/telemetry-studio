import type { ImuSample, TelemetryData } from '../types'

export interface ClipTelemetryInput {
  telemetry: TelemetryData
  /** This clip's own video duration (not the telemetry's own videoDurationMs, which may not
   *  exactly match) -- the authoritative offset basis, since playback/export timing is driven by
   *  the video files themselves. */
  durationMs: number
}

function stitchImuSamples(clips: ClipTelemetryInput[], select: (t: TelemetryData) => ImuSample[]): ImuSample[] {
  const stitched: ImuSample[] = []
  let offsetMs = 0
  for (const clip of clips) {
    for (const sample of select(clip.telemetry)) {
      stitched.push({ ...sample, cts: sample.cts + offsetMs })
    }
    offsetMs += clip.durationMs
  }
  return stitched
}

/**
 * Stitches multiple clips' telemetry (each with its own `cts` relative to that clip's own start)
 * into ONE continuous array with globally-offset `cts`, in clip order. Every telemetry/lap/sector
 * consumer downstream (sampleAt.ts, laps.ts, sectors.ts, all draw*.ts widgets) operates purely on
 * a flat `TelemetrySample[]` + a `cts`/`currentTimeMs` number with no notion of "which clip" --
 * this is the one place that bridges "N clip-relative telemetry streams" into "one global-cts
 * stream," so nothing downstream needs to change for multi-clip support. Same offsetting applies to
 * the IMU streams (accel/gyro/gravity), independently of the GPS samples since they run at a
 * different rate.
 */
export function stitchClipTelemetry(clips: ClipTelemetryInput[]): TelemetryData {
  if (clips.length === 0) {
    return { deviceName: '', gpsStream: 'GPS5', samples: [], videoDurationMs: 0, accel: [], gyro: [], gravity: [] }
  }

  const samples: TelemetryData['samples'] = []
  let offsetMs = 0
  for (const clip of clips) {
    for (const sample of clip.telemetry.samples) {
      samples.push({ ...sample, cts: sample.cts + offsetMs })
    }
    offsetMs += clip.durationMs
  }

  // A clip with no usable GPS of its own (see normalize.ts's normalizeGpsTelemetry) reports a
  // placeholder deviceName/gpsStream -- prefer whichever clip actually has real GPS for this
  // session-wide metadata instead of blindly trusting clips[0].
  const metadataSource = clips.find((c) => c.telemetry.samples.length > 0) ?? clips[0]

  return {
    deviceName: metadataSource.telemetry.deviceName,
    gpsStream: metadataSource.telemetry.gpsStream,
    samples,
    videoDurationMs: offsetMs,
    accel: stitchImuSamples(clips, (t) => t.accel),
    gyro: stitchImuSamples(clips, (t) => t.gyro),
    gravity: stitchImuSamples(clips, (t) => t.gravity)
  }
}
