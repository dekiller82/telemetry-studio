/** The export stopped because the destination volume ran out of space; retrying cannot help. */
export class InsufficientDiskSpaceError extends Error {
  readonly name = 'InsufficientDiskSpaceError'

  constructor(readonly outputPath: string, cause?: unknown) {
    super(`Not enough disk space to write ${outputPath}`, { cause })
  }
}

const DISK_FULL_TEXT = /no space left on device|not enough space on the disk|there is not enough space|disk full/i
// ffmpeg exits with -ENOSPC (-28); Windows reports that as an unsigned 32-bit code.
const DISK_FULL_EXIT_CODES = new Set([-28, 4294967268])

/** Checked before the hardware-failure heuristics: ffmpeg's muxer lines name the encoder
 *  (e.g. `[vost#0:0/h264_nvenc] Error submitting a packet to the muxer: No space left on device`),
 *  so a full disk would otherwise look like an NVENC fault and trigger a pointless CPU retry. */
export function isDiskFullError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, exitCode, stderrTail, cause } = error as {
    code?: unknown; exitCode?: unknown; stderrTail?: unknown; cause?: unknown
  }
  if (code === 'ENOSPC') return true
  if (typeof exitCode === 'number' && DISK_FULL_EXIT_CODES.has(exitCode)) return true
  if (typeof stderrTail === 'string' && DISK_FULL_TEXT.test(stderrTail)) return true
  return cause !== undefined && cause !== error && isDiskFullError(cause)
}
