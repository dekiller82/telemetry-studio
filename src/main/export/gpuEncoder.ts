import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

/** VBV-style peak/buffer multipliers shared by every encoder's bitrateArgs below -- a single-pass
 *  target-bitrate encode needs slack above the target to absorb complex frames without visible
 *  quality dips, and a buffer large enough that the rate controller isn't fighting it every frame.
 *  Not two-pass (would ~double export time for a closer bitrate match) -- delivery presets aim for
 *  "close to the platform's own recommendation," not an exact file size. */
const BITRATE_MAXRATE_MULTIPLIER = 1.5
const BITRATE_BUFSIZE_MULTIPLIER = 2

export interface VideoEncoder {
  codec: string
  /** Quality/rate-control flags for this encoder; CRF isn't universal across GPU encoders.
   *  width/height/fps are only used by encoders with no real constant-quality mode of their own
   *  (VideoToolbox -- see below), to derive a resolution-aware bitrate instead; every other
   *  encoder here ignores them. */
  qualityArgs: (crf: number, width: number, height: number, fps: number) => string[]
  /** Target-bitrate rate-control flags (delivery presets, e.g. "YouTube 1080p") -- a different
   *  rate-control mode from qualityArgs above, not just a different number; mutually exclusive
   *  with it in a single ffmpeg invocation. */
  bitrateArgs: (kbps: number) => string[]
  label: string
  /** ffmpeg -hwaccel value to pair with this encoder for GPU-accelerated decode too, if this
   *  machine was smoke-tested to actually support it. Undefined means decode stays on CPU while
   *  only the encode step runs on the GPU -- still a real speedup, just a smaller one. */
  decodeHwaccel?: string
}

// Tried in order; the bundled ffmpeg-static build has NVENC/QSV/AMF compiled in, but whether
// each actually works depends on the machine's GPU/drivers, so each candidate is smoke-tested
// with a throwaway 2-frame encode before being trusted for the real (long) export.
const GPU_ENCODER_CANDIDATES: VideoEncoder[] = [
  {
    codec: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    qualityArgs: (crf) => ['-preset', 'p5', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0'], // width/height/fps unused: NVENC has its own real constant-quality mode (-cq)
    bitrateArgs: (kbps) => [
      '-preset',
      'p5',
      '-rc',
      'vbr',
      '-b:v',
      `${kbps}k`,
      '-maxrate',
      `${Math.round(kbps * BITRATE_MAXRATE_MULTIPLIER)}k`,
      '-bufsize',
      `${Math.round(kbps * BITRATE_BUFSIZE_MULTIPLIER)}k`
    ],
    // NVDEC pairs reliably with NVENC across driver versions and was verified via real CLI runs
    // during this app's initial export work -- trusted unconditionally, unlike QSV below.
    decodeHwaccel: 'cuda'
  },
  {
    codec: 'h264_qsv',
    label: 'Intel Quick Sync',
    qualityArgs: (crf) => ['-preset', 'medium', '-global_quality', String(crf)],
    bitrateArgs: (kbps) => [
      '-preset',
      'medium',
      '-b:v',
      `${kbps}k`,
      '-maxrate',
      `${Math.round(kbps * BITRATE_MAXRATE_MULTIPLIER)}k`,
      '-bufsize',
      `${Math.round(kbps * BITRATE_BUFSIZE_MULTIPLIER)}k`
    ]
  },
  {
    codec: 'h264_amf',
    label: 'AMD AMF',
    qualityArgs: (crf) => ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf)],
    bitrateArgs: (kbps) => [
      '-quality',
      'balanced',
      '-rc',
      'vbr_peak',
      '-b:v',
      `${kbps}k`,
      '-maxrate',
      `${Math.round(kbps * BITRATE_MAXRATE_MULTIPLIER)}k`
    ]
    // No decodeHwaccel probe here: AMD's decode hwaccel pairing is platform-dependent (d3d11va on
    // Windows, vaapi on Linux) and untested on any real AMD machine. Encode-only GPU acceleration
    // is still a real win; guessing the wrong decode flag would risk breaking the export outright.
  },
  {
    codec: 'h264_videotoolbox',
    label: 'Apple VideoToolbox',
    // VideoToolbox's ffmpeg quality mode (-q:v, added for the 6.1 dev cycle) isn't in the ffmpeg
    // version ffmpeg-static actually bundles for macOS -- confirmed directly by extracting the real
    // mac binary from a shipped release and checking: it self-reports "FFmpeg version 6.0", and a
    // real Apple Silicon tester saw export silently fall back to CPU, meaning testEncoder's smoke
    // test genuinely failed with -q:v, exactly as this app is designed to react to an encoder that
    // doesn't actually work -- not a false negative, a real one. Falls back to plain bitrate mode
    // instead, which VideoToolbox has supported since ffmpeg first wrapped it (macOS 10.8+), using a
    // bits-per-pixel estimate from CRF: x264's own rule of thumb is roughly half the bitrate per +6
    // CRF, anchored so CRF 18 (this app's default) lands well above the YouTube-1080p delivery
    // preset's cited 8 Mbps target (a lower-quality target than the default "source quality" export
    // is meant to be) -- an approximation once removed from CRF's real meaning, same as -q:v was.
    qualityArgs: (crf, width, height, fps) => {
      const bpp = 0.14 * Math.pow(2, (23 - crf) / 6)
      const kbps = Math.max(1000, Math.round((width * height * fps * bpp) / 1000))
      return [
        '-b:v',
        `${kbps}k`,
        '-maxrate',
        `${Math.round(kbps * BITRATE_MAXRATE_MULTIPLIER)}k`,
        '-bufsize',
        `${Math.round(kbps * BITRATE_BUFSIZE_MULTIPLIER)}k`
      ]
    },
    bitrateArgs: (kbps) => [
      '-b:v',
      `${kbps}k`,
      '-maxrate',
      `${Math.round(kbps * BITRATE_MAXRATE_MULTIPLIER)}k`,
      '-bufsize',
      `${Math.round(kbps * BITRATE_BUFSIZE_MULTIPLIER)}k`
    ]
    // No unconditional decodeHwaccel here, unlike NVENC/cuda -- there's no Apple Silicon machine
    // available to have verified that pairing directly, so -hwaccel videotoolbox is only trusted
    // after its own real roundtrip probe passes (same treatment as QSV below), not assumed.
  }
]

export const CPU_ENCODER: VideoEncoder = {
  codec: 'libx264',
  label: 'CPU (libx264)',
  qualityArgs: (crf) => ['-preset', 'medium', '-crf', String(crf)],
  bitrateArgs: (kbps) => [
    '-preset',
    'medium',
    '-b:v',
    `${kbps}k`,
    '-maxrate',
    `${Math.round(kbps * BITRATE_MAXRATE_MULTIPLIER)}k`,
    '-bufsize',
    `${Math.round(kbps * BITRATE_BUFSIZE_MULTIPLIER)}k`
  ]
}

/** Runs one throwaway ffmpeg invocation to completion, ignoring its output; resolves true iff it exits 0. */
function runFfmpeg(ffmpegBin: string, args: string[], timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const proc = spawn(ffmpegBin, args, { stdio: 'ignore' })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    proc.on('error', () => finish(false))
    proc.on('close', (code) => finish(code === 0))
    // Guard against a hung probe (e.g. a driver popping a blocking dialog) stalling export startup.
    setTimeout(() => {
      if (!settled) {
        proc.kill()
        finish(false)
      }
    }, timeoutMs)
  })
}

function testEncoder(ffmpegBin: string, encoder: VideoEncoder): Promise<boolean> {
  return runFfmpeg(ffmpegBin, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    // NVENC in particular rejects anything much smaller than this ("Frame Dimension less than
    // the minimum supported value") -- 64x64 looked like a safe tiny probe but produced a false
    // negative, silently falling back to CPU on machines with a perfectly working GPU encoder.
    'color=black:size=256x256:rate=5:duration=0.4',
    '-c:v',
    encoder.codec,
    ...encoder.qualityArgs(23, 256, 256, 5),
    '-frames:v',
    '2',
    '-f',
    'null',
    '-'
  ])
}

/**
 * Real decode+encode roundtrip probe for a candidate `-hwaccel` value, mirroring testEncoder's
 * "trust nothing without a real throwaway run" discipline. Unlike the encoder smoke test, decode
 * acceleration needs an actual encoded source to decode -- a synthetic lavfi source bypasses the
 * decoder entirely -- so this first encodes a tiny real file with CPU libx264, then attempts to
 * decode+re-encode it using the GPU hwaccel + encoder together.
 */
async function testDecodeHwaccel(ffmpegBin: string, hwaccel: string, encoder: VideoEncoder): Promise<boolean> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpo-hwaccel-'))
  const sourcePath = path.join(dir, 'probe.mp4')
  try {
    const encoded = await runFfmpeg(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=black:size=256x256:rate=5:duration=0.4',
      '-c:v',
      'libx264',
      '-frames:v',
      '2',
      sourcePath
    ])
    if (!encoded) return false

    return await runFfmpeg(ffmpegBin, [
      '-y',
      '-hwaccel',
      hwaccel,
      '-i',
      sourcePath,
      '-c:v',
      encoder.codec,
      ...encoder.qualityArgs(23, 256, 256, 5),
      '-frames:v',
      '2',
      '-f',
      'null',
      '-'
    ])
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Picks the fastest working encoder: GPU-accelerated if this machine actually supports one, CPU libx264 otherwise. */
export async function selectVideoEncoder(ffmpegBin: string, preferGpu = true): Promise<VideoEncoder> {
  if (!preferGpu) return CPU_ENCODER

  for (const candidate of GPU_ENCODER_CANDIDATES) {
    try {
      if (!(await testEncoder(ffmpegBin, candidate))) continue

      // Intel Quick Sync's and Apple VideoToolbox's decode hwaccel aren't verified on any real
      // machine of their kind (unlike NVENC's cuda pairing above), so each is only trusted after
      // its own real roundtrip probe passes.
      const unverifiedDecodeHwaccel: Record<string, string> = { h264_qsv: 'qsv', h264_videotoolbox: 'videotoolbox' }
      const probeHwaccel = unverifiedDecodeHwaccel[candidate.codec]
      if (probeHwaccel) {
        const decodeOk = await testDecodeHwaccel(ffmpegBin, probeHwaccel, candidate).catch(() => false)
        return decodeOk ? { ...candidate, decodeHwaccel: probeHwaccel } : candidate
      }

      return candidate
    } catch {
      // fall through to the next candidate
    }
  }
  return CPU_ENCODER
}
