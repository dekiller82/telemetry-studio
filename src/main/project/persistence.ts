import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { parseProjectFile, telemetryDataSchema, type ProjectFile } from '../../shared/project/schema'
import type { ProjectPayload, WidgetInstance } from '../../shared/types'
import { findLrvSibling } from '../video/lrv'
import { filterGpsTrack, GPS_TRACK_FILTER_VERSION } from '../../shared/telemetry/gpsTrackFilter'
import { detectLapCrossings, legacyLapCrossingsForMigration } from '../../shared/telemetry/laps'

export async function saveProjectToFile(projectPath: string, payload: ProjectPayload): Promise<void> {
  const telemetryFileName = `${basename(projectPath)}.telemetry.json`
  const telemetryPath = join(dirname(projectPath), telemetryFileName)

  await writeFile(telemetryPath, JSON.stringify(payload.imported.telemetry))

  const project: ProjectFile = {
    version: 2,
    id: uuidv4(),
    clips: payload.imported.clips,
    telemetryCacheFile: telemetryFileName,
    gpsTrackFilterVersion: GPS_TRACK_FILTER_VERSION,
    widgets: payload.widgets as ProjectFile['widgets'],
    startFinish: payload.startFinish,
    startFinishRadiusM: payload.startFinishRadiusM,
    crossingAdjustmentsMs: payload.crossingAdjustmentsMs,
    crossingReferenceTimes: payload.startFinish
      ? detectLapCrossings(payload.imported.telemetry.samples, payload.startFinish, payload.startFinishRadiusM) : [],
    ignoredCrossings: payload.ignoredCrossings,
    trimStartMs: payload.trimStartMs,
    trimEndMs: payload.trimEndMs,
    defaultFontFamily: payload.defaultFontFamily
  }

  await writeFile(projectPath, JSON.stringify(project, null, 2))
}

export async function loadProjectFromFile(projectPath: string): Promise<ProjectPayload> {
  const rawProject = JSON.parse(await readFile(projectPath, 'utf-8'))
  const project = parseProjectFile(rawProject)

  const clips = project.clips.map((clip) => ({
    ...clip,
    video: {
      ...clip.video,
      // Older .gpo files predate the sidecar field, and users can also move/copy a project after
      // saving it. Re-discover a matching LRV beside the source when loading so those projects
      // receive the same format-error fallback as a fresh import; export still uses video.path.
      lrvPath: clip.video.lrvPath && existsSync(clip.video.lrvPath) ? clip.video.lrvPath : findLrvSibling(clip.video.path)
    }
  }))

  const missingClip = clips.find((clip) => !existsSync(clip.video.path))
  if (missingClip) {
    throw new Error(`Source video not found: ${missingClip.video.path}`)
  }

  const telemetryPath = join(dirname(projectPath), project.telemetryCacheFile)
  const rawTelemetry = JSON.parse(await readFile(telemetryPath, 'utf-8'))
  const telemetry = telemetryDataSchema.parse(rawTelemetry)
  const originalCrossings = project.crossingReferenceTimes ?? (project.startFinish
    ? legacyLapCrossingsForMigration(telemetry.samples, project.startFinish, project.startFinishRadiusM) : [])
  // Already-filtered caches must round-trip without reclassification, including packets that spill
  // across a chapter boundary. Legacy migration matches import's per-clip filtering so a shorter
  // chapter cannot become a competing branch of a longer one. Keep migration in memory.
  if (project.gpsTrackFilterVersion !== GPS_TRACK_FILTER_VERSION) {
    const cachedSamples = telemetry.samples
    telemetry.samples = clips.length > 1
      ? clips.flatMap((clip, i) => {
          // The next chapter's start is exclusive. The final packet can reach or slightly exceed the
          // video end, so do not truncate the last chapter's GPS samples to its video duration.
          const endCts = clips[i + 1]?.startOffsetMs ?? Infinity
          return filterGpsTrack(cachedSamples.filter((s) => s.cts >= clip.startOffsetMs && s.cts < endCts)).samples
        })
      : filterGpsTrack(cachedSamples).samples
  }

  // Corrections are indexed by RAW detection order. If cleanup removes an early false crossing,
  // retain later corrections only at the same timestamp, never at their now-shifted old index.
  const crossings = project.startFinish
    ? detectLapCrossings(telemetry.samples, project.startFinish, project.startFinishRadiusM) : []
  const unchanged = originalCrossings.length === crossings.length && originalCrossings.every((time, i) => time === crossings[i])
  const remap = <T>(corrections: Record<string, T>): Record<string, T> => {
    if (unchanged) return corrections
    const indices = new Map(crossings.map((time, i) => [time, i]))
    const mapped: Record<string, T> = {}
    for (const [key, value] of Object.entries(corrections)) {
      const newIndex = indices.get(originalCrossings[Number(key)])
      if (newIndex !== undefined) mapped[String(newIndex)] = value
    }
    return mapped
  }

  return {
    imported: { clips, telemetry },
    widgets: project.widgets as WidgetInstance[],
    startFinish: project.startFinish,
    startFinishRadiusM: project.startFinishRadiusM,
    crossingAdjustmentsMs: remap(project.crossingAdjustmentsMs),
    ignoredCrossings: remap(project.ignoredCrossings),
    trimStartMs: project.trimStartMs,
    trimEndMs: project.trimEndMs,
    defaultFontFamily: project.defaultFontFamily
  }
}
