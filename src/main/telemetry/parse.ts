import { createReadStream, type ReadStream } from 'fs'
import { stat } from 'fs/promises'
import gpmfExtract from 'gpmf-extract'
import goproTelemetry from 'gopro-telemetry'
import { normalizeTelemetry, type RawGoProTelemetry } from '../../shared/telemetry/normalize'
import { filterGpsTrack } from '../../shared/telemetry/gpsTrackFilter'
import type { TelemetryData } from '../../shared/types'

// Matches gpmf-extract's own browser-mode worker chunk size (code/readBlock.js).
const CHUNK_SIZE = 1024 * 1024 * 16

// Keep 2D/3D fixes with DOP <= 5. Gross coordinate jumps are filtered after
// normalization by comparing coordinate movement with GPS5/GPS9's own speed2D;
// unlike gopro-telemetry's fixed WrongSpeed ceiling, that remains useful for
// both low-speed karting and high-speed motorsport.
const MIN_GPS_FIX = 2 as const
const MAX_GPS_PRECISION = 500

// Deliberately not the full shared `ImportProgress` (which also carries clipIndex/totalClips) --
// this module parses one file at a time and has no notion of its own position in a multi-clip
// import; the caller (which does know that) wraps this into the full ImportProgress shape.
export interface FileParseProgress {
  phase: 'extracting' | 'parsing'
  fraction: number
}

type OnProgress = (progress: FileParseProgress) => void

type FileStartArrayBuffer = ArrayBuffer & { fileStart: number }

interface Mp4BoxFileLike {
  appendBuffer(buffer: FileStartArrayBuffer): void
  flush?: () => void
  onError?: (error: unknown) => void
}

/**
 * gpmf-extract's Node API accepts a callback that receives mp4box.js's real internal file
 * instance. Its shipped .d.ts claims `appendBuffer(buffer: Buffer)`, but the actual runtime
 * contract (verified by reading gpmf-extract's own browser-mode reader, code/readBlock.js +
 * index.js) needs an ArrayBuffer with a `.fileStart` offset, fed sequentially -- so we stream
 * the source file in chunks instead of loading it whole into memory. GoPro clips routinely
 * exceed Node's ~2GiB fs.readFile limit (ERR_FS_FILE_TOO_LARGE), which is what this replaces.
 *
 * gpmf-extract's own `progress` option is only wired up for its *browser*-mode readers, so when
 * driving mp4box ourselves in Node we report bytes-read progress here instead.
 */
function streamFileIntoMp4Box(filePath: string, fileSize: number, mp4boxFile: Mp4BoxFileLike, onProgress?: OnProgress): ReadStream {
  let offset = 0
  const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE })

  stream.on('data', (chunk: Buffer) => {
    const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as FileStartArrayBuffer
    arrayBuffer.fileStart = offset
    offset += chunk.byteLength
    onProgress?.({ phase: 'extracting', fraction: fileSize > 0 ? Math.min(1, offset / fileSize) : 0 })
    try {
      mp4boxFile.appendBuffer(arrayBuffer)
    } catch (err) {
      stream.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  })

  stream.on('end', () => mp4boxFile.flush?.())
  stream.on('error', (err) => mp4boxFile.onError?.(err))

  return stream
}

export async function parseGoProTelemetry(
  filePath: string,
  videoDurationMs: number,
  onProgress?: OnProgress
): Promise<TelemetryData> {
  let stream: ReadStream | undefined

  try {
    const { size: fileSize } = await stat(filePath)

    const extracted = await gpmfExtract(
      ((mp4boxFile: Mp4BoxFileLike) => {
        stream = streamFileIntoMp4Box(filePath, fileSize, mp4boxFile, onProgress)
      }) as unknown as Parameters<typeof gpmfExtract>[0],
      { browserMode: false }
    )

    onProgress?.({ phase: 'parsing', fraction: 0 })
    // GPS is mandatory (every other widget depends on it); ACCL/GYRO are present on every camera
    // model tested, GRAV only on newer ones -- gopro-telemetry tolerates requesting a stream that
    // isn't present in the file, it's just absent from the result, so no separate fallback call is needed.
    const raw = await goproTelemetry(
      { rawData: extracted.rawData, timing: extracted.timing },
      {
        stream: ['GPS', 'ACCL', 'GYRO', 'GRAV'],
        GPS5Fix: MIN_GPS_FIX,
        GPS5Precision: MAX_GPS_PRECISION,
        progress: (fraction: number) => onProgress?.({ phase: 'parsing', fraction })
      }
    )
    onProgress?.({ phase: 'parsing', fraction: 1 })
    const normalized = normalizeTelemetry(raw as unknown as RawGoProTelemetry, videoDurationMs)
    const filteredTrack = filterGpsTrack(normalized.samples)
    return { ...normalized, samples: filteredTrack.samples }
  } catch (err) {
    // gpmf-extract's own Node-mode "no metadata track found" path throws a confusing internal
    // TypeError ("Cannot read properties of undefined (reading 'terminate')") instead of a clean
    // rejection. This is a real, common case here -- karting footage often has GPS disabled or
    // unlocked (indoor tracks, no signal) -- so surface something actionable instead.
    if (err instanceof TypeError && /terminate/.test(err.message)) {
      throw new Error(
        'No GPS telemetry found in this clip. Make sure GPS was enabled and had a signal lock while recording (indoor karting tracks often have no GPS signal).'
      )
    }
    throw err
  } finally {
    // Once gpmfExtract resolves (gpmd samples found), stop reading the rest of a multi-GB file.
    stream?.destroy()
  }
}
