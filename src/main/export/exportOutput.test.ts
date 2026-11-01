import { link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertSafeExportOutput, attemptOutputPath, commitAttemptOutput, exportPathKey } from './exportOutput'
import { ExportCancelledError } from './exportCancellation'

const cancellation = vi.hoisted(() => ({ from: null as string | null, controller: null as AbortController | null }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      await real.rename(...args)
      if (String(args[0]) === cancellation.from) cancellation.controller?.abort()
    }
  }
})

afterEach(() => { cancellation.from = null; cancellation.controller = null })

describe('export output ownership', () => {
  it.each([
    ['backup', true], ['publish', true], ['publish', false]
  ] as const)('rolls back native filesystem changes after cancellation at %s, existing=%s', async (stage, existing) => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'telemetry-publication-native-cancel-'))
    const output = join(tempDirectory, 'export.mp4')
    const attempt = join(tempDirectory, 'attempt.mp4')
    const source = join(tempDirectory, 'source.mp4')
    try {
      if (existing) await writeFile(output, 'previous-export')
      await writeFile(attempt, 'new-export')
      await writeFile(source, 'original-video-GPMF')
      const controller = new AbortController()
      cancellation.controller = controller
      cancellation.from = stage === 'backup' ? output : attempt
      await expect(commitAttemptOutput(attempt, output, 'native-cancel', [source], controller.signal))
        .rejects.toBeInstanceOf(ExportCancelledError)
      if (existing) expect(await readFile(output, 'utf8')).toBe('previous-export')
      else await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(source, 'utf8')).toBe('original-video-GPMF')
      expect((await readdir(tempDirectory)).sort()).toEqual(
        [...(existing ? ['export.mp4'] : []), ...(stage === 'backup' ? ['attempt.mp4'] : []), 'source.mp4'].sort()
      )
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('publishes a completed attempt and replaces an existing output without leaving a backup', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'telemetry-studio-output-test-'))
    const outputPath = join(tempDirectory, 'export.mp4')
    const attemptPath = join(tempDirectory, 'attempt.mp4')

    try {
      await writeFile(outputPath, 'old-output')
      await writeFile(attemptPath, 'new-output')

      await commitAttemptOutput(attemptPath, outputPath, 'test-job-1', [])

      expect(await readFile(outputPath, 'utf8')).toBe('new-output')
      await expect(stat(attemptPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(tempDirectory)).toEqual(['export.mp4'])
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('keeps the private attempt extension compatible with ffmpeg MP4 muxer selection', () => {
    expect(attemptOutputPath('C:/exports/lap.mp4', 'job', 2)).toBe('C:/exports/lap.mp4.telemetry-studio-job-2.tmp.mp4')
  })

  it('restores an existing output when publishing the attempt fails', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'telemetry-studio-output-restore-test-'))
    const outputPath = join(tempDirectory, 'export.mp4')

    try {
      await writeFile(outputPath, 'keep-this-output')

      await expect(commitAttemptOutput(join(tempDirectory, 'missing.mp4'), outputPath, 'test-job-restore', [])).rejects.toThrow()

      expect(await readFile(outputPath, 'utf8')).toBe('keep-this-output')
      expect(await readdir(tempDirectory)).toEqual(['export.mp4'])
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('normalizes Windows casing, separators, parent segments and extended paths', () => {
    const key = exportPathKey('C:\\GoPro\\GH011552.MP4', 'win32')
    expect(exportPathKey('c:/gopro/part/../gh011552.mp4', 'win32')).toBe(key)
    expect(exportPathKey('\\\\?\\C:\\GoPro\\GH011552.MP4', 'win32')).toBe(key)
    expect(exportPathKey('\\\\SERVER\\share\\GH011552.MP4', 'win32'))
      .toBe(exportPathKey('\\\\?\\UNC\\server\\SHARE\\gh011552.mp4', 'win32'))
  })

  it('rejects normalized and relative source paths, including an excluded chapter', async () => {
    const source = join(process.cwd(), 'videos', 'GH011552.MP4')
    await expect(assertSafeExportOutput(relative(process.cwd(), source), ['other.mp4', source]))
      .rejects.toThrow('must not overwrite a source video')
    await expect(assertSafeExportOutput(join(process.cwd(), 'videos', '..', 'videos', 'GH011552.MP4'), [source]))
      .rejects.toThrow('must not overwrite a source video')
  })

  it('refuses publication before renaming or deleting any original camera data', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'telemetry-studio-source-protection-'))
    const source = join(tempDirectory, 'GH011552.MP4')
    const attempt = join(tempDirectory, 'attempt.mp4')
    try {
      await writeFile(source, 'original-video-audio-GPMF')
      await writeFile(attempt, 'export-without-GPMF')
      await expect(commitAttemptOutput(attempt, source, 'source-job', [source]))
        .rejects.toThrow('must not overwrite a source video')
      expect(await readFile(source, 'utf8')).toBe('original-video-audio-GPMF')
      expect(await readFile(attempt, 'utf8')).toBe('export-without-GPMF')
      expect((await readdir(tempDirectory)).sort()).toEqual(['GH011552.MP4', 'attempt.mp4'])
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('also protects hard-linked aliases of a source', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'telemetry-studio-source-alias-'))
    const source = join(tempDirectory, 'source.mp4')
    const alias = join(tempDirectory, 'alias.mp4')
    try {
      await writeFile(source, 'original-GPMF')
      await link(source, alias)
      await expect(assertSafeExportOutput(alias, [source])).rejects.toThrow('must not overwrite a source video')
      expect(await readFile(source, 'utf8')).toBe('original-GPMF')
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })
})
