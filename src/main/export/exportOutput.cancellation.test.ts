import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportCancelledError } from './exportCancellation'
import { commitAttemptOutput, ExportOutputRecoveryError } from './exportOutput'

const io = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn(), rename: vi.fn(), unlink: vi.fn() }))
vi.mock('node:fs/promises', () => io)

const output = join(tmpdir(), 'publication-test-output.mp4')
const attempt = `${output}.attempt.mp4`
const source = join(tmpdir(), 'publication-test-source.mp4')
const backup = `${output}.telemetry-studio-test.backup`
const files = new Map<string, { data: string; ino: bigint }>()
let beforeStat: ((file: string) => Promise<void>) | undefined
let beforeRename: ((from: string, to: string) => Promise<void>) | undefined
let afterRename: ((from: string, to: string) => Promise<void>) | undefined
let beforeUnlink: ((file: string) => void) | undefined

function missing(): Error {
  return Object.assign(new Error('missing file'), { code: 'ENOENT' })
}

function gate() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const resumed = new Promise<void>(resolve => { release = resolve })
  return { started, release, wait: async () => { entered(); await resumed } }
}

beforeEach(() => {
  vi.clearAllMocks()
  files.clear()
  files.set(output, { data: 'previous-export', ino: 1n })
  files.set(attempt, { data: 'completed-attempt', ino: 2n })
  files.set(source, { data: 'original-GPMF', ino: 3n })
  beforeStat = beforeRename = afterRename = beforeUnlink = undefined
  io.realpath.mockImplementation(async (file: string) => {
    if (!files.has(file)) throw missing()
    return file
  })
  io.stat.mockImplementation(async (file: string) => {
    await beforeStat?.(file)
    const entry = files.get(file)
    if (!entry) throw missing()
    return { dev: 1n, ino: entry.ino }
  })
  io.rename.mockImplementation(async (from: string, to: string) => {
    await beforeRename?.(from, to)
    const entry = files.get(from)
    if (!entry) throw missing()
    files.set(to, entry)
    files.delete(from)
    await afterRename?.(from, to)
  })
  io.unlink.mockImplementation(async (file: string) => {
    beforeUnlink?.(file)
    if (!files.delete(file)) throw missing()
  })
})

function publish(controller: AbortController) {
  return commitAttemptOutput(attempt, output, 'test', [source], controller.signal)
}

describe('cancellation during output publication', () => {
  it('rejects an already cancelled publication without touching any files', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(publish(controller)).rejects.toBeInstanceOf(ExportCancelledError)
    expect(io.rename).not.toHaveBeenCalled()
    expect(io.stat).not.toHaveBeenCalled()
    expect(files.get(output)?.data).toBe('previous-export')
  })

  it('honors cancellation while source identity checks are pending', async () => {
    const controller = new AbortController()
    const safety = gate()
    beforeStat = async file => { if (file === source) await safety.wait() }
    const result = publish(controller).catch(error => error)
    await safety.started
    controller.abort()
    safety.release()
    expect(await result).toBeInstanceOf(ExportCancelledError)
    expect(io.rename).not.toHaveBeenCalled()
    expect(files.get(output)?.data).toBe('previous-export')
    expect(files.get(attempt)?.data).toBe('completed-attempt')
    expect(files.get(source)?.data).toBe('original-GPMF')
  })

  it('restores the existing output when cancellation arrives during its backup rename', async () => {
    const controller = new AbortController()
    const renamed = gate()
    afterRename = async (from, to) => { if (from === output && to === backup) await renamed.wait() }
    const result = publish(controller).catch(error => error)
    await renamed.started
    controller.abort()
    renamed.release()
    expect(await result).toBeInstanceOf(ExportCancelledError)
    expect(files.get(output)?.data).toBe('previous-export')
    expect(files.get(attempt)?.data).toBe('completed-attempt')
    expect(files.has(backup)).toBe(false)
    expect(io.rename).not.toHaveBeenCalledWith(attempt, output)
  })

  it.each([true, false])('rolls back cancellation during the final rename, previous output=%s', async existing => {
    if (!existing) files.delete(output)
    const controller = new AbortController()
    const renamed = gate()
    afterRename = async (from, to) => { if (from === attempt && to === output) await renamed.wait() }
    const result = publish(controller).catch(error => error)
    await renamed.started
    expect(files.get(output)?.data).toBe('completed-attempt')
    controller.abort()
    renamed.release()
    expect(await result).toBeInstanceOf(ExportCancelledError)
    expect(files.get(output)?.data).toBe(existing ? 'previous-export' : undefined)
    expect(files.has(backup)).toBe(false)
    expect(files.get(source)?.data).toBe('original-GPMF')
  })

  it('treats backup removal as post-commit cleanup rather than cancelling an already committed output', async () => {
    const controller = new AbortController()
    beforeUnlink = file => { if (file === backup) controller.abort() }
    await publish(controller)
    expect(controller.signal.aborted).toBe(true)
    expect(files.get(output)?.data).toBe('completed-attempt')
    expect(files.has(backup)).toBe(false)
  })

  it('keeps the previous backup and reports its location if cancellation rollback fails', async () => {
    const controller = new AbortController()
    afterRename = async from => { if (from === attempt) controller.abort() }
    beforeRename = async from => {
      if (from === backup) throw Object.assign(new Error('destination locked during restore'), { code: 'EACCES' })
    }
    const error = await publish(controller).catch(error => error)
    expect(error).toBeInstanceOf(ExportOutputRecoveryError)
    expect(error.message).toContain(backup)
    expect(files.get(backup)?.data).toBe('previous-export')
    expect(files.get(output)?.data).toBe('completed-attempt')
    expect(io.unlink).not.toHaveBeenCalledWith(backup)
  })

  it('reports an unremoved new destination if cancellation cleanup fails without a previous output', async () => {
    files.delete(output)
    const controller = new AbortController()
    afterRename = async from => { if (from === attempt) controller.abort() }
    beforeUnlink = file => {
      if (file === output) throw Object.assign(new Error('new destination locked'), { code: 'EACCES' })
    }
    const error = await publish(controller).catch(error => error)
    expect(error).toBeInstanceOf(ExportOutputRecoveryError)
    expect(error.message).toContain(output)
    expect(files.get(output)?.data).toBe('completed-attempt')
    expect(files.has(backup)).toBe(false)
  })
})
