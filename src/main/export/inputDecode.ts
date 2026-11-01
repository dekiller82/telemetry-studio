import { spawn } from 'child_process'

// FFmpeg's automatic thread count can request >32 NVDEC surfaces on a 16-thread host.
// This is an INPUT decoder limit; do not apply it to the encoder or filter graph.
export const CUDA_DECODE_THREADS = 4

export interface DecodeProbeResult {
  ok: boolean
  reason: 'process-error' | 'no-hardware-frame' | 'timeout' | 'cancelled' | null
}

/** Require an actual CUDA frame from the real input. Exit 0 alone also permits empty inputs,
 * and plain -hwaccel cuda can silently fall back to software decoding. wrapped_avframe with a
 * CUDA output pixel format accepts neither case. No output file or source modification. */
export function probeCudaInput(
  ffmpegBin: string,
  inputPath: string,
  seekSeconds: number,
  signal?: AbortSignal,
  timeoutMs = 5000
): Promise<DecodeProbeResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' })
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-v', 'error', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
      '-threads', String(CUDA_DECODE_THREADS), '-ss', String(Math.max(0, seekSeconds)),
      '-i', inputPath, '-map', '0:v:0', '-an', '-frames:v', '1',
      '-c:v', 'wrapped_avframe', '-pix_fmt', 'cuda', '-progress', 'pipe:1', '-f', 'null', '-'
    ]
    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let frameSeen = false
    let progressTail = ''
    let stopReason: DecodeProbeResult['reason'] = null
    let settled = false
    const finish = (result: DecodeProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const stop = (reason: DecodeProbeResult['reason']): void => {
      stopReason ??= reason
      child.kill()
      // Settle on close, so a cancelled/timed-out probe cannot overlap the real export.
    }
    const onAbort = (): void => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      progressTail += chunk.toString()
      const lines = progressTail.split(/\r?\n/)
      progressTail = (lines.pop() ?? '').slice(-256)
      for (const line of lines) if (/^frame=\s*[1-9]\d*\s*$/.test(line)) frameSeen = true
    })
    child.once('error', () => finish({ ok: false, reason: stopReason ?? 'process-error' }))
    child.once('close', code => finish({
      ok: stopReason == null && code === 0 && frameSeen,
      reason: stopReason ?? (code !== 0 ? 'process-error' : frameSeen ? null : 'no-hardware-frame')
    }))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
