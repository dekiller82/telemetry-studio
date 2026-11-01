import { realpath, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { throwIfExportCancelled } from './exportCancellation'

/** Recovery must be reported even when cancellation triggered it; the user may need the backup. */
export class ExportOutputRecoveryError extends Error {
  readonly name = 'ExportOutputRecoveryError'

  constructor(outputPath: string, backupPath: string | null, publishError: unknown, recoveryError: unknown) {
    const location = backupPath
      ? `The previous file is preserved at ${backupPath}.`
      : `The new output may remain at ${outputPath}.`
    super(
      `Could not restore the export destination ${outputPath}. ${location} ` +
        `Publish error: ${String(publishError)}; recovery error: ${String(recoveryError)}`,
      { cause: recoveryError }
    )
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

/** Compare absolute paths using the target filesystem's spelling rules, not raw strings. */
export function exportPathKey(filePath: string, platform = process.platform): string {
  if (platform === 'win32') {
    // Also equate slash variants and the extended-length \\?\ prefix on Windows.
    return path.win32.toNamespacedPath(path.win32.resolve(filePath)).toLowerCase()
  }
  return path.resolve(filePath)
}

/** A completed export omits the camera's GPMF stream: replacing ANY source is data loss. */
export async function assertSafeExportOutput(outputPath: string, sourcePaths: readonly string[]): Promise<void> {
  const outputKey = exportPathKey(outputPath)
  const rejectSourceOverwrite = (): never => {
    throw new Error('Export output must not overwrite a source video. Choose a different file name or folder.')
  }
  if (sourcePaths.some((sourcePath) => exportPathKey(sourcePath) === outputKey)) rejectSourceOverwrite()

  const identity = async (filePath: string) => {
    try {
      const [canonicalPath, info] = await Promise.all([realpath(filePath), stat(filePath, { bigint: true })])
      return { canonicalKey: exportPathKey(canonicalPath), dev: info.dev, ino: info.ino }
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error // Permission and other filesystem errors fail closed, never authorize replacement.
    }
  }
  const output = await identity(outputPath)
  if (!output) return
  const sources = await Promise.all(sourcePaths.map(identity))
  if (sources.some((source) => source && (
    source.canonicalKey === output.canonicalKey ||
    (source.ino !== 0n && source.dev === output.dev && source.ino === output.ino)
  ))) rejectSourceOverwrite()
}

export async function removeAttemptFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isMissingFile(error)) console.warn(`[export] could not clean temporary output ${filePath}:`, error)
  }
}

export function attemptOutputPath(outputPath: string, jobId: string, attemptId: number): string {
  // Keep the final .mp4 extension so ffmpeg selects the same muxer as the user-facing output.
  return `${outputPath}.telemetry-studio-${jobId}-${attemptId}.tmp.mp4`
}

/**
 * Publishes a completed attempt without exposing a partially encoded file as the final output.
 * The backup is kept in the same directory/volume, so the two renames do not cross filesystems.
 * Failure/cancellation through the final rename restores the old file when possible. After the
 * post-rename cancellation check, publication is committed and backup cleanup is not cancellable.
 */
export async function commitAttemptOutput(
  tempPath: string,
  outputPath: string,
  jobId: string,
  sourcePaths: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  throwIfExportCancelled(signal)
  // Check again after encoding: an existing destination may now alias a source file.
  await assertSafeExportOutput(outputPath, sourcePaths)
  throwIfExportCancelled(signal)
  const backupPath = `${outputPath}.telemetry-studio-${jobId}.backup`
  let backedUpExistingOutput = false
  let published = false

  try {
    try {
      await rename(outputPath, backupPath)
      backedUpExistingOutput = true
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }

    throwIfExportCancelled(signal)
    await rename(tempPath, outputPath)
    published = true
    throwIfExportCancelled(signal)
  } catch (error) {
    try {
      if (backedUpExistingOutput) {
        // This also replaces an already-published attempt if cancellation arrived during rename.
        await rename(backupPath, outputPath)
      } else if (published) {
        await unlink(outputPath)
      }
    } catch (recoveryError) {
      // Keep the backup for manual recovery. Never delete it in a finally block after this error.
      throw new ExportOutputRecoveryError(outputPath, backedUpExistingOutput ? backupPath : null, error, recoveryError)
    }
    throw error
  }

  // Commit point: the replacement succeeded and cancellation was checked. Late cancellation
  // during best-effort backup cleanup cannot undo a committed output or delete its destination.
  if (backedUpExistingOutput) await removeAttemptFile(backupPath)
}
