import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProjectFromFile, saveProjectToFile } from './persistence'
import { createWidget } from '../../shared/widgets/defaults'
import { FORMULA1_FONT_ID } from '../../shared/render/fonts'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import { stitchClipTelemetry } from '../../shared/telemetry/stitchClips'
import type { ClipInfo, ImportResult, ProjectPayload, TelemetrySample, VideoMeta } from '../../shared/types'

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

function continuousGpsTrack(startCts: number, count: number, startNorthM = 0, stepMs = 1000): TelemetrySample[] {
  return Array.from({ length: count }, (_, i) => ({
    cts: startCts + i * stepMs,
    lat: 30 + (startNorthM + 10 * i * stepMs / 1000) / 111195,
    lon: 106,
    altitude: 300,
    speed2D: 10,
    speed3D: 10
  }))
}

describe('project persistence', () => {
  const dirs: string[] = []

  it('saves manual result decisions separately from deleted crossings and defaults older projects to no exclusions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-lap-results-'))
    dirs.push(dir)
    const payload = makePayload(dir, 1, { '0': 40 })
    payload.excludedLaps = { '1000:61000': true }
    const file = join(dir, 'results.gpo')
    await saveProjectToFile(file, payload)
    const loaded = await loadProjectFromFile(file)
    expect(loaded.excludedLaps).toEqual(payload.excludedLaps)
    expect(loaded.crossingAdjustmentsMs).toEqual({ '0': 40 })
    expect(loaded.ignoredCrossings).toEqual({})
    const older = JSON.parse(readFileSync(file, 'utf8'))
    delete older.excludedLaps
    writeFileSync(file, JSON.stringify(older))
    expect((await loadProjectFromFile(file)).excludedLaps).toEqual({})
  })

  it('round-trips fixed sector coordinates and defaults older projects to automatic gates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-sectors-'))
    dirs.push(dir)
    const payload = makePayload(dir)
    payload.sectorTiming = { s1: { lat: 30.0001, lon: 106.0002 }, s2: { lat: 30.0003, lon: 106.0004 } }
    const file = join(dir, 'sectors.gpo')
    await saveProjectToFile(file, payload)
    expect((await loadProjectFromFile(file)).sectorTiming).toEqual(payload.sectorTiming)
    const older = JSON.parse(readFileSync(file, 'utf8'))
    delete older.sectorTiming
    writeFileSync(file, JSON.stringify(older))
    expect((await loadProjectFromFile(file)).sectorTiming).toEqual({ s1: null, s2: null })
  })

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

  it.each(['current', 'legacy'])('preserves both valid GPS chapters in a %s cache across save and reopen', async (format) => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir, 2)
    payload.imported.clips[0].video.durationMs = 120000
    payload.imported.clips[1].startOffsetMs = 120000
    payload.imported.clips[1].video.durationMs = 600000
    payload.imported.telemetry.samples = [
      ...continuousGpsTrack(0, 120),
      ...continuousGpsTrack(120000, 600, 6000)
    ]
    payload.imported.telemetry.videoDurationMs = payload.trimEndMs = 720000
    payload.startFinish = null
    const projectPath = join(dir, 'chapters.gpo')
    await saveProjectToFile(projectPath, payload)
    if (format === 'legacy') {
      const project = JSON.parse(readFileSync(projectPath, 'utf8'))
      delete project.crossingReferenceTimes
      delete project.gpsTrackFilterVersion
      writeFileSync(projectPath, JSON.stringify(project))
    }
    const cacheBefore = readFileSync(`${projectPath}.telemetry.json`, 'utf8')
    const projectBefore = readFileSync(projectPath, 'utf8')

    const loaded = await loadProjectFromFile(projectPath)
    expect(loaded.imported.telemetry.samples).toEqual(payload.imported.telemetry.samples)
    const originalSampler = createTelemetrySampler(payload.imported.telemetry)
    const loadedSampler = createTelemetrySampler(loaded.imported.telemetry)
    expect(loadedSampler.hasPositionAt(60000)).toBe(true)
    expect(loadedSampler.sessionStatsAt(0, 720000)).toEqual(originalSampler.sessionStatsAt(0, 720000))
    expect(readFileSync(`${projectPath}.telemetry.json`, 'utf8')).toBe(cacheBefore)
    expect(readFileSync(projectPath, 'utf8')).toBe(projectBefore)

    const updatedPath = join(dir, 'resaved.gpo')
    await saveProjectToFile(updatedPath, loaded)
    expect((await loadProjectFromFile(updatedPath)).imported.telemetry).toEqual(payload.imported.telemetry)
  })

  it('keeps short chapters and the last GPS packet at the video end when reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir, 2)
    payload.imported.clips[0].video.durationMs = 90
    payload.imported.clips[1].startOffsetMs = 90
    payload.imported.clips[1].video.durationMs = 100
    payload.imported.telemetry.samples = [
      ...continuousGpsTrack(0, 2, 0, 50),
      ...continuousGpsTrack(90, 3, 6000, 50)
    ]
    payload.imported.telemetry.videoDurationMs = payload.trimEndMs = 190
    payload.startFinish = null
    const projectPath = join(dir, 'short-chapters.gpo')
    await saveProjectToFile(projectPath, payload)

    expect((await loadProjectFromFile(projectPath)).imported.telemetry.samples).toEqual(payload.imported.telemetry.samples)
  })

  it('preserves already-cleaned GPS packets that spill across a video chapter boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir, 2)
    payload.imported.clips[0].video.durationMs = 1990
    payload.imported.clips[1].startOffsetMs = 1990
    payload.imported.clips[1].video.durationMs = 2010
    payload.imported.telemetry = stitchClipTelemetry([
      { durationMs: 1990, telemetry: { ...payload.imported.telemetry, samples: continuousGpsTrack(0, 3), videoDurationMs: 1990 } },
      { durationMs: 2010, telemetry: { ...payload.imported.telemetry, samples: continuousGpsTrack(0, 3, 6000), videoDurationMs: 2010 } }
    ])
    payload.trimEndMs = 4000
    payload.startFinish = null
    expect(payload.imported.telemetry.samples.map((s) => s.cts)).toEqual([0, 1000, 2000, 2990, 3990])
    const projectPath = join(dir, 'packet-overlap.gpo')
    await saveProjectToFile(projectPath, payload)

    expect((await loadProjectFromFile(projectPath)).imported.telemetry).toEqual(payload.imported.telemetry)
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

  it.each(['missing', 'stale'])('rediscovers an LRV sidecar when its saved path is %s', async (savedPath) => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const sourcePath = join(dir, 'GH010230.MP4')
    const lrvPath = join(dir, 'GL010230.LRV')
    writeFileSync(sourcePath, 'not a real video')
    writeFileSync(lrvPath, 'not a real lrv')

    const payload = makePayload(dir)
    payload.imported.clips[0].video = { ...makeVideoMeta(sourcePath), lrvPath: null }
    const projectPath = join(dir, 'legacy.gpo')
    await saveProjectToFile(projectPath, payload)
    const legacy = JSON.parse(readFileSync(projectPath, 'utf8'))
    if (savedPath === 'missing') delete legacy.clips[0].video.lrvPath
    else legacy.clips[0].video.lrvPath = join(dir, 'missing.LRV')
    writeFileSync(projectPath, JSON.stringify(legacy))

    const loaded = await loadProjectFromFile(projectPath)
    expect(loaded.imported.clips[0].video.lrvPath).toBe(lrvPath)
  })

  it('cleans legacy telemetry in memory and remaps corrections by time rather than shifted crossing index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpo-persist-'))
    dirs.push(dir)
    const payload = makePayload(dir)
    const point = payload.imported.telemetry.samples[0]
    payload.imported.telemetry.samples = [
      { ...point, cts: 0, lat: 52 },
      { ...point, cts: 1000 }, // old false crossing from a huge GPS snap
      { ...point, cts: 2000, lat: 53 },
      ...[0.0002, 0.00009, 0.0002, 0.0003].map((offset, i) => ({ ...point, cts: 20000 + 1000 * i, lat: 51.5 + offset }))
    ]
    payload.crossingAdjustmentsMs = { '0': 123, '1': 40 }
    payload.ignoredCrossings = { '0': true, '1': true }
    const projectPath = join(dir, 'legacy-gps.gpo')
    await saveProjectToFile(projectPath, payload)
    const legacy = JSON.parse(readFileSync(projectPath, 'utf8'))
    delete legacy.crossingReferenceTimes
    delete legacy.gpsTrackFilterVersion
    writeFileSync(projectPath, JSON.stringify(legacy))
    const cachePath = `${projectPath}.telemetry.json`
    const cacheBefore = readFileSync(cachePath, 'utf8')
    const projectBefore = readFileSync(projectPath, 'utf8')

    const loaded = await loadProjectFromFile(projectPath)
    expect(loaded.imported.telemetry.samples.map(s => s.cts)).toEqual([20000, 21000, 22000, 23000])
    expect(loaded.crossingAdjustmentsMs).toEqual({ '0': 40 })
    expect(loaded.ignoredCrossings).toEqual({ '0': true })
    expect(readFileSync(cachePath, 'utf8')).toBe(cacheBefore)
    expect(readFileSync(projectPath, 'utf8')).toBe(projectBefore)

    const updatedPath = join(dir, 'updated.gpo')
    await saveProjectToFile(updatedPath, loaded)
    const reopened = await loadProjectFromFile(updatedPath)
    expect(reopened.imported.telemetry).toEqual(loaded.imported.telemetry)
    expect(reopened.crossingAdjustmentsMs).toEqual(loaded.crossingAdjustmentsMs)
    expect(reopened.ignoredCrossings).toEqual(loaded.ignoredCrossings)
  })
})
