import { describe, expect, it, vi } from 'vitest'
import { ExportAttemptProfiler, type ExportProfileMetadata } from './exportProfiling'

describe('ExportAttemptProfiler', () => {
  it('distinguishes a passed startup probe from runtime fallback, including split stderr messages', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const metadata: ExportProfileMetadata = {
      jobId: 'decode-diagnostics', attemptId: 1, encoderLabel: 'NVENC', encoderCodec: 'h264_nvenc',
      decodeHwaccel: 'cuda', decodeProbeStatus: 'passed', decodeProbeMs: 250,
      width: 1920, height: 1080, overlayX: 0, overlayY: 0, overlayWidth: 1920, overlayHeight: 1080,
      fps: 50, totalFrames: 1, clipCount: 1, widgetCount: 1, renderWorkers: 2, preferGpu: true,
      rendererSetupMs: 0, encoderSelectionMs: 0
    }
    const profiler = new ExportAttemptProfiler(metadata)
    profiler.observeFfmpegStderr('x'.repeat(20_000))
    profiler.observeFfmpegStderr('Failed setup for for')
    profiler.observeFfmpegStderr('mat cuda: hwaccel initialisation returned error.\n')
    const profile = profiler.finish('success', null)
    expect(profile.decodeProbeStatus).toBe('passed')
    expect(profile.decodeRuntimeStatus).toBe('fallback-detected')
    expect(JSON.stringify(profile)).not.toContain('Failed setup')
    const requested = new ExportAttemptProfiler(metadata).finish('success', null)
    expect(requested.decodeRuntimeStatus).toBe('requested')
    const software = new ExportAttemptProfiler({ ...metadata, decodeHwaccel: null, decodeProbeStatus: 'failed' }).finish('success', null)
    expect(software.decodeRuntimeStatus).toBe('software')
    log.mockRestore()
  })

  it('emits one bounded summary with distinct rendered/submitted/encoded counts', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const profiler = new ExportAttemptProfiler({
      jobId: 'test-job',
      attemptId: 1,
      encoderLabel: 'test encoder',
      encoderCodec: 'test_codec',
      decodeHwaccel: null,
      width: 1920,
      height: 1080,
      overlayX: 100,
      overlayY: 200,
      overlayWidth: 800,
      overlayHeight: 400,
      fps: 30,
      totalFrames: 2,
      clipCount: 1,
      widgetCount: 3,
      renderWorkers: 1,
      preferGpu: true,
      rendererSetupMs: 4,
      encoderSelectionMs: 5
    })

    profiler.markFfmpegSpawnStart()
    profiler.markFfmpegSpawned()
    profiler.recordRendered(2, 100)
    profiler.recordSubmitted()
    profiler.recordRendered(4, 100)
    profiler.recordSubmitted()
    profiler.recordWriteCall(1)
    profiler.recordDrainWait(3)
    profiler.markSubmissionComplete()
    profiler.markFfmpegClosed(0)

    const snapshot = profiler.finish('success', null)
    expect(snapshot.renderedFrames).toBe(2)
    expect(snapshot.submittedFrames).toBe(2)
    // The current pipeline confirms that ffmpeg exited successfully, but does not yet probe the
    // output container for an exact encoded-frame count. Keep this distinct from submittedFrames.
    expect(snapshot.encodedFrames).toBeNull()
    expect(snapshot.renderedBytes).toBe(200)
    expect(snapshot.renderP95Ms).not.toBeNull()
    expect(snapshot.overlayWidth).toBe(800)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toMatch(/^\[export:profile\] \{/)

    log.mockRestore()
  })

  it('tracks the true render maximum while sampling the whole long attempt', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const profiler = new ExportAttemptProfiler({
      jobId: 'long-job',
      attemptId: 1,
      encoderLabel: 'test encoder',
      encoderCodec: 'test_codec',
      decodeHwaccel: null,
      width: 1920,
      height: 1080,
      overlayX: 0,
      overlayY: 0,
      overlayWidth: 1920,
      overlayHeight: 1080,
      fps: 50,
      totalFrames: 1_000,
      clipCount: 1,
      widgetCount: 1,
      renderWorkers: 1,
      preferGpu: false,
      rendererSetupMs: 0,
      encoderSelectionMs: 0
    })

    for (let frame = 0; frame < 1_000; frame++) profiler.recordRendered(frame === 500 ? 999 : 1, 4)
    profiler.markSubmissionComplete()
    const snapshot = profiler.finish('failed', null, new Error('injected'))

    expect(snapshot.renderMaxMs).toBe(999)
    expect(snapshot.renderSamples).toBe(256)
    expect(snapshot.submissionLoopMs).toBeGreaterThanOrEqual(0)
    log.mockRestore()
  })
})
