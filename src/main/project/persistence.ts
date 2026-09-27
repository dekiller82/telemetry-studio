import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { parseProjectFile, telemetryDataSchema, type ProjectFile } from '../../shared/project/schema'
import type { ProjectPayload, WidgetInstance } from '../../shared/types'

export async function saveProjectToFile(projectPath: string, payload: ProjectPayload): Promise<void> {
  const telemetryFileName = `${basename(projectPath)}.telemetry.json`
  const telemetryPath = join(dirname(projectPath), telemetryFileName)

  await writeFile(telemetryPath, JSON.stringify(payload.imported.telemetry))

  const project: ProjectFile = {
    version: 2,
    id: uuidv4(),
    clips: payload.imported.clips,
    telemetryCacheFile: telemetryFileName,
    widgets: payload.widgets as ProjectFile['widgets'],
    startFinish: payload.startFinish,
    startFinishRadiusM: payload.startFinishRadiusM,
    crossingAdjustmentsMs: payload.crossingAdjustmentsMs,
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

  const missingClip = project.clips.find((clip) => !existsSync(clip.video.path))
  if (missingClip) {
    throw new Error(`Source video not found: ${missingClip.video.path}`)
  }

  const telemetryPath = join(dirname(projectPath), project.telemetryCacheFile)
  const rawTelemetry = JSON.parse(await readFile(telemetryPath, 'utf-8'))
  const telemetry = telemetryDataSchema.parse(rawTelemetry)

  return {
    imported: { clips: project.clips, telemetry },
    widgets: project.widgets as WidgetInstance[],
    startFinish: project.startFinish,
    startFinishRadiusM: project.startFinishRadiusM,
    crossingAdjustmentsMs: project.crossingAdjustmentsMs,
    ignoredCrossings: project.ignoredCrossings,
    trimStartMs: project.trimStartMs,
    trimEndMs: project.trimEndMs,
    defaultFontFamily: project.defaultFontFamily
  }
}
