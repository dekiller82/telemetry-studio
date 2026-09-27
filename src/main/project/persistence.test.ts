import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProjectFromFile, saveProjectToFile } from './persistence'
import { createWidget } from '../../shared/widgets/defaults'
import { FORMULA1_FONT_ID } from '../../shared/render/fonts'
import type { ClipInfo, ImportResult, ProjectPayload, VideoMeta } from '../../shared/types'

function makeVideoMeta(path: string, overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    path,
    fileName: path.split(/[\\/]/).pop() ?? path,
    durationMs: 20000,
    fps: 59.94,
    width: 1920,
    height: 1080,
    codec: 'h264',
    pixFmt: 'yuv420p',
    hasAudio: true,
    lrvPath: null,
    ...overrides
  }
}

function makePayload(dir: string, clipCount = 1, crossingAdjustmentsMs: ProjectPayload['crossingAdjustmentsMs'] = {}): ProjectPayload {
  const clips: ClipInfo[] = []
  let offsetMs = 0
  for (let i = 0; i < clipCount; i++) {
    const videoPath = join(dir, `clip${i}.mp4`)
    writeFileSync(videoPath, 'not a real video, just needs to exist')
    clips.push({ video: makeVideoMeta(videoPath), startOffsetMs: offsetMs })
    offsetMs += 20000
  }

  const imported: ImportResult = {
    clips,
    telemetry: {
      deviceName: 'Hero11 Black',
      gpsStream: 'GPS9',
      videoDurationMs: offsetMs,
      samples: [
        { cts: 0, lat: 51.5, lon: -0.1, altitude: 10, speed2D: 5, speed3D: 5.1 },
        { cts: 1000, lat: 51.5001, lon: -0.1001, altitude: 10.2, speed2D: 6, speed3D: 6.1 }
      ],
      accel: [],
      gyro: [],
      gravity: []
    }
  }

  return {
    imported,
    widgets: [createWidget('gpsTrack'), createWidget('speedometerAnalog'), createWidget('timer')],
    startFinish: { lat: 51.5, lon: -0.1 },
    startFinishRadiusM: 15,
    crossingAdjustmentsMs,
    ignoredCrossings: {},
    trimStartMs: 0,
    trimEndMs: offsetMs,
    defaultFontFamily: FORMULA1_FONT_ID
  }
}

describe('project persistence', () => {
  const dirs: string[] = []

  afterEach(() => {
    dirs.length = 0
  })

  it('round-trips a single-clip project file (widgets, clips, telemetry cache, trim) through save + load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir)
    const projectPath = join(dir, 'session.gpo')

    await saveProjectToFile(projectPath, payload)
    const loaded = await loadProjectFromFile(projectPath)

    expect(loaded.imported.clips).toEqual(payload.imported.clips)
    expect(loaded.imported.telemetry).toEqual(payload.imported.telemetry)
    expect(loaded.widgets).toEqual(payload.widgets)
    expect(loaded.startFinish).toEqual(payload.startFinish)
    expect(loaded.crossingAdjustmentsMs).toEqual(payload.crossingAdjustmentsMs)
    expect(loaded.trimStartMs).toBe(payload.trimStartMs)
    expect(loaded.trimEndMs).toBe(payload.trimEndMs)
    expect(loaded.defaultFontFamily).toBe(payload.defaultFontFamily)
  })

  it('round-trips manual per-crossing adjustments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir, 1, { '0': -133, '2': 66 })
    const projectPath = join(dir, 'session.gpo')

    await saveProjectToFile(projectPath, payload)
    const loaded = await loadProjectFromFile(projectPath)

    expect(loaded.crossingAdjustmentsMs).toEqual({ '0': -133, '2': 66 })
  })

  it('round-trips a multi-clip project file with trim points', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir, 3)
    payload.trimStartMs = 1000
    payload.trimEndMs = 55000
    const projectPath = join(dir, 'session.gpo')

    await saveProjectToFile(projectPath, payload)
    const loaded = await loadProjectFromFile(projectPath)

    expect(loaded.imported.clips.length).toBe(3)
    expect(loaded.imported.clips.map((c) => c.startOffsetMs)).toEqual([0, 20000, 40000])
    expect(loaded.trimStartMs).toBe(1000)
    expect(loaded.trimEndMs).toBe(55000)
  })

  it('throws a clear error naming which clip no longer exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir, 2)
    const projectPath = join(dir, 'session.gpo')
    await saveProjectToFile(projectPath, payload)

    // Simulate only the SECOND clip having been moved/deleted after saving.
    const { unlinkSync } = await import('fs')
    const secondClipPath = payload.imported.clips[1].video.path
    unlinkSync(secondClipPath)

    await expect(loadProjectFromFile(projectPath)).rejects.toThrow(/Source video not found/)
    await expect(loadProjectFromFile(projectPath)).rejects.toThrow(new RegExp(secondClipPath.replace(/\\/g, '\\\\')))
  })

  it('rejects a corrupted project file instead of silently loading garbage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const projectPath = join(dir, 'broken.gpo')
    writeFileSync(projectPath, JSON.stringify({ version: 2, widgets: 'not-an-array' }))

    await expect(loadProjectFromFile(projectPath)).rejects.toThrow()
  })

  it('migrates an old v1 (single-clip) project file into the current v2 shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const videoPath = join(dir, 'clip.mp4')
    writeFileSync(videoPath, 'not a real video, just needs to exist')

    const telemetryFileName = 'v1session.gpo.telemetry.json'
    writeFileSync(
      join(dir, telemetryFileName),
      JSON.stringify({
        deviceName: 'Hero9 Black',
        gpsStream: 'GPS5',
        videoDurationMs: 15000,
        samples: [{ cts: 0, lat: 1, lon: 2, altitude: 3, speed2D: 4, speed3D: 5 }]
      })
    )

    const v1Project = {
      version: 1,
      id: 'old-id',
      sourceVideo: {
        path: videoPath,
        fileName: 'clip.mp4',
        durationMs: 15000,
        fps: 29.97,
        width: 1280,
        height: 720,
        codec: 'h264',
        pixFmt: 'yuv420p'
        // no hasAudio -- v1 predates that field entirely
      },
      telemetryCacheFile: telemetryFileName,
      widgets: [],
      startFinish: null
    }
    const projectPath = join(dir, 'v1session.gpo')
    writeFileSync(projectPath, JSON.stringify(v1Project))

    const loaded = await loadProjectFromFile(projectPath)

    expect(loaded.imported.clips).toEqual([{ video: { ...v1Project.sourceVideo, hasAudio: true, lrvPath: null }, startOffsetMs: 0 }])
    expect(loaded.trimStartMs).toBe(0)
    expect(loaded.trimEndMs).toBe(15000)
    expect(loaded.startFinish).toBeNull()
  })

  it('loads an existing v2 project whose gpsTrack style predates the speed/braking color-mode fields', async () => {
    // Simulates a project saved before colorMode/slowColor/fastColor/brakingColor/acceleratingColor/
    // neutralColor/brakingThresholdMps2 were added to gpsStyleSchema -- those fields must be zod
    // `.default(...)`, not required, or a real already-saved file like this would fail to parse.
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const videoPath = join(dir, 'clip.mp4')
    writeFileSync(videoPath, 'not a real video, just needs to exist')

    const telemetryFileName = 'oldgps.gpo.telemetry.json'
    writeFileSync(
      join(dir, telemetryFileName),
      JSON.stringify({ deviceName: 'Hero9 Black', gpsStream: 'GPS5', videoDurationMs: 15000, samples: [] })
    )

    const projectWithOldGpsStyle = {
      version: 2,
      id: 'old-gps-style-id',
      clips: [
        {
          video: {
            path: videoPath,
            fileName: 'clip.mp4',
            durationMs: 15000,
            fps: 29.97,
            width: 1280,
            height: 720,
            codec: 'h264',
            pixFmt: 'yuv420p',
            hasAudio: true
          },
          startOffsetMs: 0
        }
      ],
      telemetryCacheFile: telemetryFileName,
      widgets: [
        {
          id: 'w1',
          type: 'gpsTrack',
          x: 0,
          y: 0,
          w: 0.2,
          h: 0.2,
          rotation: 0,
          zIndex: 1,
          style: {
            lineColor: '#ffffff',
            lineWidth: 3,
            lineOpacity: 0.85,
            dotColor: '#ff3b30',
            dotRadius: 7,
            dotGlow: true
            // no colorMode/slowColor/fastColor/brakingColor/acceleratingColor/neutralColor/brakingThresholdMps2
          }
        }
      ],
      startFinish: null,
      trimStartMs: 0,
      trimEndMs: 15000
    }
    const projectPath = join(dir, 'oldgps.gpo')
    writeFileSync(projectPath, JSON.stringify(projectWithOldGpsStyle))

    const loaded = await loadProjectFromFile(projectPath)
    const gpsWidget = loaded.widgets[0]
    if (gpsWidget.type !== 'gpsTrack') throw new Error('expected a gpsTrack widget')
    expect(gpsWidget.style.colorMode).toBe('solid')
    expect(gpsWidget.style.brakingThresholdMps2).toBe(1.5)

    // This fixture's video object also predates lrvPath entirely (written before LRV sidecar
    // support existed) -- confirms videoMetaSchema's .default(null) covers a real already-saved file.
    expect(loaded.imported.clips[0].video.lrvPath).toBeNull()

    // The telemetry cache fixture above also predates accel/gyro/gravity entirely (written before
    // the G-Force Diagram/Roll Angle widgets added IMU parsing) -- confirms telemetryDataSchema's
    // .default([]) fields cover this real scenario, not just the widget-style ones.
    expect(loaded.imported.telemetry.accel).toEqual([])
    expect(loaded.imported.telemetry.gyro).toEqual([])
    expect(loaded.imported.telemetry.gravity).toEqual([])

    // This fixture's widget and project object also predate fontFamily/defaultFontFamily entirely
    // (written before the font picker feature existed) -- confirms both new fields fall back to
    // "inherit"/the bundled default rather than failing to parse.
    expect(gpsWidget.fontFamily).toBeNull()
    expect(loaded.defaultFontFamily).toBe(FORMULA1_FONT_ID)
  })
})
