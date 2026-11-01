import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunExportOptions } from './runExport'
import type { ExportFrameSource } from './parallelFrameRenderer'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import { createGpsTrackWidget } from '../../shared/widgets/defaults'
import { ExportOutputRecoveryError } from './exportOutput'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), selectEncoder: vi.fn(), parallel: vi.fn(), serial: vi.fn(), publish: vi.fn(), remove: vi.fn(), decodeProbe: vi.fn()
}))
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  // Exercise the real export policy on a host below both of the previous hardware thresholds.
  cpus: () => [{ model: 'test-cpu' }], freemem: () => 256 * 1024 * 1024
}))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./frameRenderer', () => ({ createFrameRenderer: mocks.serial }))
vi.mock('./parallelFrameRenderer', () => ({ createParallelFrameRenderer: mocks.parallel }))
vi.mock('./registerFonts', () => ({ getExportFontsDirectory: () => 'fonts' }))
vi.mock('./loadIcons', () => ({ getExportIconsDirectory: () => 'icons' }))
vi.mock('./inputDecode', () => ({ CUDA_DECODE_THREADS: 4, probeCudaInput: mocks.decodeProbe }))
vi.mock('../app/binaryPath', () => ({ resolveUnpackedBinaryPath: () => 'mock-ffmpeg.exe' }))
vi.mock('./gpuEncoder', () => ({
  selectVideoEncoder: mocks.selectEncoder,
  CPU_ENCODER: { codec: 'libx264', label: 'CPU', qualityArgs: () => [], bitrateArgs: () => [] }
}))
vi.mock('./exportOutput', async (importOriginal) => ({
  ...await importOriginal<typeof import('./exportOutput')>(),
  commitAttemptOutput: mocks.publish,
  removeAttemptFile: mocks.remove
}))
const { runExport, ExportCancelledError } = await import('./runExport')

class FakeChild extends EventEmitter {
  readonly stdin = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  readonly stderr = new PassThrough()
  killed = false
  exited = false
  readonly kill = vi.fn(() => {
    this.killed = true
    if (!this.exited) queueMicrotask(() => this.close(1))
    return true
  })
  constructor() {
    super()
    this.stdin.on('finish', () => queueMicrotask(() => this.close(0)))
  }
  close(code: number): void {
    if (this.exited) return
    this.exited = true
    this.emit('close', code)
  }
}

function options(overrides: Partial<RunExportOptions> = {}): RunExportOptions {
  const telemetry = {
    deviceName: 'lifecycle-test', gpsStream: 'GPS5' as const, videoDurationMs: 400,
    samples: [0, 400].map(cts => ({ cts, lat: 39.9, lon: 116.3, altitude: 50, speed2D: 20, speed3D: 20 })),
    accel: [], gyro: [], gravity: []
  }
  return {
    clips: [0, 1].map(index => ({ startOffsetMs: index * 200, video: {
      path: join(tmpdir(), `telemetry-lifecycle-source-${index}.mp4`), fileName: `source-${index}.mp4`,
      durationMs: 200, width: 2, height: 2, fps: 20, codec: 'h264', pixFmt: 'yuv420p', hasAudio: false, lrvPath: null
    } })),
    outputPath: join(tmpdir(), 'telemetry-lifecycle-mock-export.mp4'),
    widgets: [createGpsTrackWidget()], telemetry, sampler: createTelemetrySampler(telemetry),
    startFinish: null, startFinishRadiusM: 6, crossingAdjustmentsMs: {}, ignoredCrossings: {},
    trimStartMs: 0, trimEndMs: 100, defaultFontFamily: 'formula1',
    settings: { width: 2, height: 2, fps: 20, crf: 18, preferGpu: false, renderWorkers: 2 },
    ...overrides
  }
}

let child: FakeChild
let source: ExportFrameSource

beforeEach(() => {
  vi.clearAllMocks()
  child = new FakeChild()
  source = {
    roi: { x: 0, y: 0, width: 2, height: 2 }, workerCount: 2, prefetchCount: 2,
    renderFrame: vi.fn(async () => ({ pixels: Buffer.alloc(16), renderMs: 1 })), close: vi.fn(async () => {})
  }
  mocks.spawn.mockImplementation(() => child)
  mocks.selectEncoder.mockResolvedValue({ codec: 'libx264', label: 'CPU', qualityArgs: () => [], bitrateArgs: () => [] })
  mocks.decodeProbe.mockResolvedValue({ ok: true, reason: null })
  mocks.parallel.mockResolvedValue(source)
  mocks.serial.mockResolvedValue({ roi: source.roi, renderFrame: vi.fn(() => Buffer.alloc(16)) })
  mocks.publish.mockResolvedValue(undefined)
  mocks.remove.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('runExport lifecycle and source protection', () => {
  it('probes only overlapping input clips and preserves NVENC when decoding must fall back', async () => {
    mocks.selectEncoder.mockResolvedValue({ codec: 'h264_nvenc', label: 'NVENC', decodeHwaccel: 'cuda', qualityArgs: () => [], bitrateArgs: () => [] })
    mocks.decodeProbe.mockResolvedValue({ ok: false, reason: 'no-hardware-frame' })
    const config = options({ trimStartMs: 220, trimEndMs: 320 })
    await runExport(config)
    expect(mocks.decodeProbe).toHaveBeenCalledExactlyOnceWith('mock-ffmpeg.exe', config.clips[1].video.path, 0.02, undefined)
    const args = mocks.spawn.mock.calls[0][1] as string[]
    expect(args).toContain('h264_nvenc')
    expect(args).not.toContain('-hwaccel')
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('stops before worker startup if input decode probing is cancelled', async () => {
    mocks.selectEncoder.mockResolvedValue({ codec: 'h264_nvenc', label: 'NVENC', decodeHwaccel: 'cuda', qualityArgs: () => [], bitrateArgs: () => [] })
    mocks.decodeProbe.mockResolvedValue({ ok: false, reason: 'cancelled' })
    await expect(runExport(options())).rejects.toBeInstanceOf(ExportCancelledError)
    expect(mocks.parallel).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('defaults to two workers even for a two-frame export on a low-memory single-core host', async () => {
    const config = options()
    delete config.settings.renderWorkers
    await runExport(config)
    expect(mocks.parallel).toHaveBeenCalledOnce()
    expect(mocks.serial).not.toHaveBeenCalled()
    expect(source.renderFrame).toHaveBeenCalledTimes(2)
    expect(console.log).toHaveBeenCalledWith('[export] frame renderer: 2 worker(s)')
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('still honors an explicit single-renderer override', async () => {
    const config = options()
    config.settings.renderWorkers = 1
    await runExport(config)
    expect(mocks.parallel).not.toHaveBeenCalled()
    expect(mocks.serial).toHaveBeenCalledOnce()
    expect(console.log).toHaveBeenCalledWith('[export] frame renderer: 1 worker(s)')
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('falls back to a single renderer if default worker initialization fails', async () => {
    const config = options()
    delete config.settings.renderWorkers
    mocks.parallel.mockRejectedValueOnce(new Error('worker initialization failed'))
    await runExport(config)
    expect(mocks.parallel).toHaveBeenCalledOnce()
    expect(mocks.serial).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledWith('[export] parallel renderer unavailable; using one renderer:', expect.any(Error))
    expect(console.log).toHaveBeenCalledWith('[export] frame renderer: 1 worker(s)')
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('rejects an excluded input chapter as output before selecting an encoder or starting work', async () => {
    const config = options()
    config.outputPath = config.clips[1].video.path
    await expect(runExport(config)).rejects.toThrow('must not overwrite a source video')
    expect(mocks.selectEncoder).not.toHaveBeenCalled()
    expect(mocks.parallel).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('interrupts a slow Worker at early FFmpeg exit without an unhandled rejection', async () => {
    let frameFinished = false
    source.renderFrame = vi.fn(() => new Promise<never>((_resolve, reject) => setTimeout(() => {
      frameFinished = true
      reject(new Error('late Worker rejection'))
    }, 60)))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    mocks.spawn.mockImplementation(() => {
      setTimeout(() => { child.stderr.write('invalid input'); child.close(1) }, 5)
      return child
    })
    try {
      await expect(runExport(options())).rejects.toMatchObject({ name: 'FfmpegProcessError', exitCode: 1 })
      expect(frameFinished).toBe(false)
      expect(source.close).toHaveBeenCalledOnce()
      expect(mocks.publish).not.toHaveBeenCalled()
      expect(mocks.remove).toHaveBeenCalledOnce()
      await new Promise(resolve => setTimeout(resolve, 70))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
  })

  it('also rejects a premature successful child exit instead of publishing an incomplete file', async () => {
    source.renderFrame = vi.fn(() => new Promise<never>(() => {}))
    mocks.spawn.mockImplementation(() => { setTimeout(() => child.close(0), 5); return child })
    await expect(runExport(options())).rejects.toThrow('ffmpeg input closed before export completed')
    expect(source.close).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('reports a process spawn error while still waiting for the first Worker frame', async () => {
    source.renderFrame = vi.fn(() => new Promise<never>(() => {}))
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')))
      return child
    })
    await expect(runExport(options())).rejects.toMatchObject({ name: 'FfmpegProcessError', exitCode: null })
    expect(child.kill).toHaveBeenCalled()
    expect(source.close).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('cancels even when a Worker frame never resolves, and closes the child and renderer', async () => {
    source.renderFrame = vi.fn(() => new Promise<never>(() => {}))
    const controller = new AbortController()
    const result = runExport(options({ signal: controller.signal }))
    const error = result.catch((failure: unknown) => failure)
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce(), { interval: 1 })
    controller.abort()
    expect(await error).toBeInstanceOf(ExportCancelledError)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(source.close).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.spawn).toHaveBeenCalledOnce() // User cancellation must not trigger a CPU retry.
  })

  it('interrupts backpressure on early child exit and removes the losing drain listeners', async () => {
    vi.spyOn(child.stdin, 'write').mockReturnValue(false)
    mocks.spawn.mockImplementation(() => { setTimeout(() => child.close(1), 5); return child })
    await expect(runExport(options())).rejects.toMatchObject({ name: 'FfmpegProcessError' })
    expect(child.stdin.listenerCount('drain')).toBe(0)
    expect(child.stdin.listenerCount('error')).toBe(0)
    expect(child.stdin.listenerCount('close')).toBe(0)
    expect(source.close).toHaveBeenCalledOnce()
  })

  it('cancels while waiting for pipe drain and releases stream and abort listeners', async () => {
    vi.spyOn(child.stdin, 'write').mockReturnValue(false)
    const controller = new AbortController()
    const result = runExport(options({ signal: controller.signal })).catch((failure: unknown) => failure)
    await vi.waitFor(() => expect(child.stdin.listenerCount('drain')).toBe(1), { interval: 1 })
    controller.abort()
    expect(await result).toBeInstanceOf(ExportCancelledError)
    expect(child.stdin.listenerCount('drain')).toBe(0)
    expect(child.stdin.listenerCount('error')).toBe(0)
    expect(child.stdin.listenerCount('close')).toBe(0)
    expect(source.close).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('finishes ordinary exports and gives publication the full protected source list', async () => {
    const config = options()
    await runExport(config)
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(expect.any(String), config.outputPath,
      expect.any(String), config.clips.map(clip => clip.video.path), config.signal)
    expect(source.close).toHaveBeenCalledOnce()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(child.stdin.listenerCount('error')).toBe(0)
  })

  it.each(['Permission denied', 'No space left on device', 'Invalid data found when processing input'])(
    'does not retry a non-hardware FFmpeg error (%s) merely because NVENC was selected', async (diagnostic) => {
      mocks.selectEncoder.mockResolvedValue({ codec: 'h264_nvenc', label: 'NVIDIA NVENC', qualityArgs: () => [], bitrateArgs: () => [] })
      source.renderFrame = vi.fn(() => new Promise<never>(() => {}))
      mocks.spawn.mockImplementationOnce(() => {
        setTimeout(() => {
          child.stderr.write(`configuration: --enable-nvenc\nStream mapping: h264 (native) -> h264 (h264_nvenc)\n${diagnostic}`)
          child.close(1)
        }, 5)
        return child
      })
      await expect(runExport(options())).rejects.toThrow(diagnostic)
      expect(mocks.spawn).toHaveBeenCalledOnce()
      expect(source.close).toHaveBeenCalledOnce()
      expect(mocks.publish).not.toHaveBeenCalled()
    }
  )

  it('passes cancellation through publication and still cleans up the attempt and workers', async () => {
    const controller = new AbortController()
    const config = options({ signal: controller.signal })
    mocks.publish.mockImplementationOnce(async (...args) => {
      expect(args[4]).toBe(controller.signal)
      controller.abort()
      throw new ExportCancelledError()
    })
    await expect(runExport(config)).rejects.toBeInstanceOf(ExportCancelledError)
    expect(source.close).toHaveBeenCalledOnce()
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('reports failed output recovery even when the signal is aborted', async () => {
    const controller = new AbortController()
    const config = options({ signal: controller.signal })
    const failure = new ExportOutputRecoveryError(config.outputPath, `${config.outputPath}.backup`,
      new ExportCancelledError(), new Error('destination locked'))
    mocks.publish.mockImplementationOnce(async () => {
      controller.abort()
      throw failure
    })
    await expect(runExport(config)).rejects.toBe(failure)
    expect(source.close).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('closes a failed GPU renderer before starting the CPU fallback', async () => {
    mocks.selectEncoder.mockResolvedValue({ codec: 'h264_nvenc', label: 'NVENC', qualityArgs: () => [], bitrateArgs: () => [] })
    const firstChild = child
    const secondChild = new FakeChild()
    const firstSource = { ...source, renderFrame: vi.fn(() => new Promise<never>(() => {})) }
    mocks.parallel.mockResolvedValueOnce(firstSource).mockImplementationOnce(async () => {
      expect(firstSource.close).toHaveBeenCalledOnce()
      return source
    })
    mocks.spawn.mockImplementationOnce(() => {
      setTimeout(() => { firstChild.stderr.write('nvenc initialization failed'); firstChild.close(1) }, 5)
      return firstChild
    }).mockReturnValueOnce(secondChild)
    await runExport(options())
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.publish).toHaveBeenCalledOnce()
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(source.close).toHaveBeenCalledTimes(2)
  })
})
