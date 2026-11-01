import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { cpus } from 'node:os'

const MAX_RENDER_SAMPLES = 256

export type ExportAttemptOutcome = 'success' | 'cancelled' | 'failed'

export interface ExportProfileMetadata {
  jobId: string
  attemptId: number
  encoderLabel: string
  encoderCodec: string
  decodeHwaccel: string | null
  /** A probe proves startup on the input, not that the whole export used hardware decoding. */
  decodeProbeStatus?: 'not-run' | 'passed' | 'failed'
  decodeProbeMs?: number
  decodeProbeFailure?: string | null
  width: number
  height: number
  overlayX: number
  overlayY: number
  overlayWidth: number
  overlayHeight: number
  fps: number
  totalFrames: number
  clipCount: number
  widgetCount: number
  renderWorkers: number
  preferGpu: boolean
  rendererSetupMs: number
  encoderSelectionMs: number
}

export interface ExportProfileSnapshot extends ExportProfileMetadata {
  schemaVersion: 1
  outcome: ExportAttemptOutcome
  platform: NodeJS.Platform
  arch: string
  electronVersion: string | null
  nodeVersion: string
  logicalCpuCount: number
  durationMs: number
  ffmpegSpawnMs: number | null
  /** Sum of individual frame render durations; with multiple workers this can exceed wall time. */
  renderMs: number
  /** Time the FFmpeg submission loop spent waiting for the next ordered frame. */
  renderWaitMs: number
  renderAvgMs: number | null
  renderP95Ms: number | null
  renderMaxMs: number | null
  renderSamples: number
  renderedFrames: number
  submittedFrames: number
  encodedFrames: number | null
  renderedBytes: number
  writeCallMs: number
  drainWaitMs: number
  submissionLoopMs: number
  ffmpegWaitMs: number | null
  closeCode: number | null
  errorName: string | null
  decodeRuntimeStatus: 'software' | 'requested' | 'fallback-detected'
}

export function createExportJobId(): string {
  return randomUUID()
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : error == null ? null : typeof error
}

/**
 * Collects one bounded, end-of-attempt export summary. It deliberately does not retain frames,
 * paths, stderr, or arbitrary per-frame log lines: a long export should produce one small JSON
 * record per encoder attempt rather than another source of memory pressure.
 */
export class ExportAttemptProfiler {
  private readonly startedAtMs = performance.now()
  private ffmpegSpawnStartedAtMs: number | null = null
  private ffmpegSpawnMs: number | null = null
  private submissionStartedAtMs: number | null = null
  private submissionEndedAtMs: number | null = null
  private ffmpegWaitStartedAtMs: number | null = null
  private ffmpegClosedAtMs: number | null = null
  private closeCode: number | null = null
  private renderMs = 0
  private renderWaitMs = 0
  private writeCallMs = 0
  private drainWaitMs = 0
  private renderedFrames = 0
  private submittedFrames = 0
  private renderedBytes = 0
  private renderMaxMs: number | null = null
  private readonly renderSamplesMs: number[] = []
  private readonly renderSampleFrameIndexes: Set<number> | null
  private finished = false
  private decodeFallbackDetected = false
  private decodeDiagnosticTail = ''

  constructor(private readonly metadata: ExportProfileMetadata) {
    const totalFrames = Math.max(1, Math.floor(metadata.totalFrames))
    if (totalFrames <= MAX_RENDER_SAMPLES) {
      this.renderSampleFrameIndexes = null
    } else {
      // Select evenly spaced frame indexes, including the first and last frame. This keeps the
      // percentile sample representative of the whole attempt rather than only its tail.
      this.renderSampleFrameIndexes = new Set(
        Array.from({ length: MAX_RENDER_SAMPLES }, (_, index) => Math.round((index * (totalFrames - 1)) / (MAX_RENDER_SAMPLES - 1)))
      )
    }
  }

  markFfmpegSpawnStart(): void {
    this.ffmpegSpawnStartedAtMs = performance.now()
  }

  /** Observe only bounded diagnostic text, including messages split across stderr chunks.
   * `requested` deliberately does not claim observed hardware throughput or per-frame success. */
  observeFfmpegStderr(text: string): void {
    if (!this.metadata.decodeHwaccel || this.decodeFallbackDetected) return
    const diagnostic = this.decodeDiagnosticTail + text
    this.decodeFallbackDetected = /hwaccel initiali[sz]ation returned error|failed setup for format|cuvidCreateDecoder.*failed|hardware accelerator failed to decode/i.test(diagnostic)
    this.decodeDiagnosticTail = diagnostic.slice(-512)
  }

  markFfmpegSpawned(): void {
    const now = performance.now()
    if (this.ffmpegSpawnStartedAtMs != null) this.ffmpegSpawnMs = Math.max(0, now - this.ffmpegSpawnStartedAtMs)
    this.submissionStartedAtMs = now
  }

  recordRendered(durationMs: number, byteLength: number): void {
    const duration = Math.max(0, durationMs)
    this.renderMs += duration
    this.renderMaxMs = this.renderMaxMs == null ? duration : Math.max(this.renderMaxMs, duration)
    const frameIndex = this.renderedFrames
    this.renderedFrames += 1
    this.renderedBytes += Math.max(0, byteLength)

    // Keep a bounded, deterministic sample spread across the whole attempt. The all-frame maximum
    // is tracked separately above, so a long export cannot hide a mid-run render spike.
    if (this.renderSampleFrameIndexes == null || this.renderSampleFrameIndexes.has(frameIndex)) {
      this.renderSamplesMs.push(duration)
    }
  }

  recordRenderWait(durationMs: number): void {
    this.renderWaitMs += Math.max(0, durationMs)
  }

  recordSubmitted(): void {
    this.submittedFrames += 1
  }

  recordWriteCall(durationMs: number): void {
    this.writeCallMs += Math.max(0, durationMs)
  }

  recordDrainWait(durationMs: number): void {
    this.drainWaitMs += Math.max(0, durationMs)
  }

  markSubmissionComplete(): void {
    if (this.submissionEndedAtMs != null) return
    this.submissionEndedAtMs = performance.now()
    this.ffmpegWaitStartedAtMs = this.submissionEndedAtMs
  }

  markFfmpegClosed(code: number | null): void {
    this.closeCode = code
    this.ffmpegClosedAtMs = performance.now()
  }

  finish(outcome: ExportAttemptOutcome, encodedFrames: number | null, error?: unknown): ExportProfileSnapshot {
    if (this.finished) throw new Error('Export attempt profile already finished')
    this.finished = true

    const finishedAtMs = performance.now()
    const snapshot: ExportProfileSnapshot = {
      ...this.metadata,
      decodeProbeStatus: this.metadata.decodeProbeStatus ?? 'not-run',
      decodeProbeMs: this.metadata.decodeProbeMs ?? 0,
      decodeProbeFailure: this.metadata.decodeProbeFailure ?? null,
      decodeRuntimeStatus: !this.metadata.decodeHwaccel ? 'software' : this.decodeFallbackDetected ? 'fallback-detected' : 'requested',
      schemaVersion: 1,
      outcome,
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron ?? null,
      nodeVersion: process.versions.node,
      logicalCpuCount: cpus().length,
      durationMs: Math.max(0, finishedAtMs - this.startedAtMs),
      ffmpegSpawnMs: this.ffmpegSpawnMs,
      renderMs: this.renderMs,
      renderWaitMs: this.renderWaitMs,
      renderAvgMs: this.renderedFrames > 0 ? this.renderMs / this.renderedFrames : null,
      renderP95Ms: percentile(this.renderSamplesMs, 0.95),
      renderMaxMs: this.renderMaxMs,
      renderSamples: this.renderSamplesMs.length,
      renderedFrames: this.renderedFrames,
      submittedFrames: this.submittedFrames,
      encodedFrames,
      renderedBytes: this.renderedBytes,
      writeCallMs: this.writeCallMs,
      drainWaitMs: this.drainWaitMs,
      submissionLoopMs:
        this.submissionStartedAtMs != null && this.submissionEndedAtMs != null
          ? Math.max(0, this.submissionEndedAtMs - this.submissionStartedAtMs)
          : 0,
      ffmpegWaitMs:
        this.ffmpegWaitStartedAtMs != null && this.ffmpegClosedAtMs != null
          ? Math.max(0, this.ffmpegClosedAtMs - this.ffmpegWaitStartedAtMs)
          : null,
      closeCode: this.closeCode,
      errorName: errorName(error)
    }

    console.log(`[export:profile] ${JSON.stringify(snapshot)}`)
    return snapshot
  }
}
