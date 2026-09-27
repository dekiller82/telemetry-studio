import { ipcMain, dialog, BrowserWindow, app, type OpenDialogOptions } from 'electron'
import { unlink } from 'fs/promises'
import { ensurePreviewProxy } from '../video/previewProxy'
import { probeAndParseClip, buildImportResult, sliceClipTelemetry, type ProbedClip } from '../video/clipImport'
import { orderAndValidateGoProClipPaths } from '../video/goproClipOrder'
import { loadProjectFromFile, saveProjectToFile } from '../project/persistence'
import { listLayoutPresets, saveLayoutPreset, deleteLayoutPreset, defaultLayoutPresetsFilePath } from '../project/layoutPresets'
import { autosaveProjectPath, hasAutosave, clearAutosave } from '../project/autosave'
import { listRecentProjects, addRecentProject, removeRecentProject, defaultRecentProjectsFilePath } from '../project/recentProjects'
import { defaultChangelogPath, readChangelog } from '../app/changelog'
import { checkForUpdate } from '../app/updateCheck'
import { SUPPORTS_IN_APP_UPDATE, startUpdate, quitAndInstallUpdate } from '../app/updater'
import { listSystemFonts } from '../app/systemFonts'
import { runExport, ExportCancelledError } from '../export/runExport'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import { findDeliveryPreset, resolvePresetDimensions } from '../../shared/export/deliveryPresets'
import type { ImportResult, ProjectPayload, VideoMeta, WidgetInstance, WidgetLayoutPreset, RecentProject, UpdateCheckResult } from '../../shared/types'

const PROJECT_FILTERS = [{ name: 'Telemetry Studio Project', extensions: ['gpo'] }]
const VIDEO_FILTERS = [{ name: 'GoPro video', extensions: ['mp4', 'mov', 'MP4', 'MOV'] }]
const EXPORT_CRF = 18

// Only one export can run at a time (the renderer already disables the Export button while
// isExporting), so a single module-level controller is enough to correlate a `export:cancel` call
// with whichever export is currently in flight -- no id/correlation scheme needed.
let currentExportController: AbortController | null = null

export function registerIpcHandlers(): void {
  ipcMain.handle('video:pick', async (): Promise<string[]> => {
    const win = BrowserWindow.getFocusedWindow()
    const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'], filters: VIDEO_FILTERS }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return []
    // Ordering and cross-recording validation happen inside video:import/video:add-clips, where
    // any error is caught by the renderer and shown to the user instead of escaping from the file picker.
    return result.filePaths
  })

  // Preview is attempted natively (full-res, no transcode) first -- this only runs when the
  // renderer's <video> element actually fails to play the original file at runtime. `forceTranscode`
  // is set by the renderer on a SECOND call for the same clip, when the first (remuxed) proxy it
  // already tried also failed to play -- see ensurePreviewProxy's own doc comment for why a
  // successful remux isn't proof of playability.
  ipcMain.handle('video:ensure-preview-proxy', async (event, video: VideoMeta, forceTranscode?: boolean): Promise<string> => {
    return ensurePreviewProxy(
      video,
      (fraction) => {
        event.sender.send('video:preview-proxy-progress', { fraction })
      },
      forceTranscode
    )
  })

  ipcMain.handle('video:import', async (event, filePaths: string[]): Promise<ImportResult> => {
    const orderedPaths = orderAndValidateGoProClipPaths(filePaths)
    const probed: ProbedClip[] = []
    for (let i = 0; i < orderedPaths.length; i++) {
      probed.push(
        await probeAndParseClip(orderedPaths[i], i, orderedPaths.length, (progress) => {
          event.sender.send('video:import-progress', progress)
        })
      )
    }
    return buildImportResult(probed)
  })

  // Appends more clips to an already-imported project without re-parsing GPMF for clips that are
  // already imported (the expensive part) -- reconstructs their raw per-clip telemetry by slicing
  // it back out of the already-stitched result instead.
  ipcMain.handle('video:add-clips', async (event, existing: ImportResult, newFilePaths: string[]): Promise<ImportResult> => {
    const existingPaths = existing.clips.map((clip) => clip.video.path)
    const orderedCombinedPaths = orderAndValidateGoProClipPaths([...existingPaths, ...newFilePaths])
    const existingOrderStillFirst = existingPaths.every((filePath, index) => orderedCombinedPaths[index] === filePath)
    if (!existingOrderStillFirst) {
      throw new Error(
        'The selected clip belongs before clips already in this timeline after ordering. Import all clips together in a new project.'
      )
    }
    const orderedNewPaths = orderedCombinedPaths.slice(existingPaths.length)

    const existingProbed = existing.clips.map((clip) => ({
      video: clip.video,
      telemetry: sliceClipTelemetry(clip, existing.telemetry)
    }))

    const totalClips = existing.clips.length + orderedNewPaths.length
    const newProbed: ProbedClip[] = []
    for (let i = 0; i < orderedNewPaths.length; i++) {
      const clipIndex = existing.clips.length + i
      newProbed.push(
        await probeAndParseClip(orderedNewPaths[i], clipIndex, totalClips, (progress) => {
          event.sender.send('video:import-progress', progress)
        })
      )
    }
    return buildImportResult([...existingProbed, ...newProbed])
  })

  ipcMain.handle('project:save', async (_event, payload: ProjectPayload): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { filters: PROJECT_FILTERS, defaultPath: 'project.gpo' })
      : await dialog.showSaveDialog({ filters: PROJECT_FILTERS, defaultPath: 'project.gpo' })

    if (result.canceled || !result.filePath) return null
    await saveProjectToFile(result.filePath, payload)
    await addRecentProject(defaultRecentProjectsFilePath(), result.filePath)
    return result.filePath
  })

  ipcMain.handle('project:load', async (): Promise<ProjectPayload | null> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: PROJECT_FILTERS })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters: PROJECT_FILTERS })

    if (result.canceled || result.filePaths.length === 0) return null
    const payload = await loadProjectFromFile(result.filePaths[0])
    await addRecentProject(defaultRecentProjectsFilePath(), result.filePaths[0])
    return payload
  })

  // Opens a specific, already-known project path directly (no file picker) -- used by the Recent
  // Projects list on the start screen.
  ipcMain.handle('project:load-path', async (_event, projectPath: string): Promise<ProjectPayload> => {
    try {
      const payload = await loadProjectFromFile(projectPath)
      await addRecentProject(defaultRecentProjectsFilePath(), projectPath)
      return payload
    } catch (err) {
      // The file was likely moved/deleted since it was listed -- drop it so it doesn't keep
      // failing every time it's clicked, then let the real error surface to the UI.
      await removeRecentProject(defaultRecentProjectsFilePath(), projectPath)
      throw err
    }
  })

  ipcMain.handle('recent:list', async (): Promise<RecentProject[]> => listRecentProjects(defaultRecentProjectsFilePath()))

  ipcMain.handle('app:getVersion', (): string => app.getVersion())
  ipcMain.handle('app:getChangelog', async (): Promise<string> => readChangelog(defaultChangelogPath()))
  ipcMain.handle('app:checkForUpdate', async (): Promise<UpdateCheckResult | null> => checkForUpdate(app.getVersion()))
  ipcMain.handle('fonts:listSystem', async (): Promise<string[]> => listSystemFonts())

  ipcMain.handle('updater:supported', (): boolean => SUPPORTS_IN_APP_UPDATE)
  ipcMain.handle('updater:start', (): void => startUpdate())
  ipcMain.handle('updater:quitAndInstall', (): void => quitAndInstallUpdate())

  ipcMain.handle('export:start', async (event, payload: ProjectPayload, deliveryPresetId?: string): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { filters: [{ name: 'MP4 Video', extensions: ['mp4'] }], defaultPath: 'export.mp4' })
      : await dialog.showSaveDialog({ filters: [{ name: 'MP4 Video', extensions: ['mp4'] }], defaultPath: 'export.mp4' })

    if (result.canceled || !result.filePath) return null

    const { clips } = payload.imported
    const referenceVideo = clips[0].video
    const sampler = createTelemetrySampler(payload.imported.telemetry)

    // No preset (or an unrecognized id) -- the default "source quality" export, byte-for-byte
    // the same settings this app has always used: native resolution, quality-based (CRF) encode.
    const preset = deliveryPresetId ? findDeliveryPreset(deliveryPresetId) : null
    const { width, height } = preset
      ? resolvePresetDimensions(preset, referenceVideo.width, referenceVideo.height)
      : { width: referenceVideo.width, height: referenceVideo.height }

    const controller = new AbortController()
    currentExportController = controller

    try {
      await runExport({
        clips,
        outputPath: result.filePath,
        widgets: payload.widgets,
        sampler,
        startFinish: payload.startFinish,
        crossingAdjustmentsMs: payload.crossingAdjustmentsMs,
        trimStartMs: payload.trimStartMs,
        trimEndMs: payload.trimEndMs,
        defaultFontFamily: payload.defaultFontFamily,
        settings: {
          width,
          height,
          fps: referenceVideo.fps || 30,
          crf: EXPORT_CRF,
          videoBitrateKbps: preset?.videoBitrateKbps,
          audioBitrateKbps: preset?.audioBitrateKbps
        },
        onProgress: (done, total) => {
          event.sender.send('export:progress', { done, total })
        },
        onEncoderSelected: (label) => {
          event.sender.send('export:encoder', { label })
        },
        signal: controller.signal
      })
    } catch (err) {
      if (err instanceof ExportCancelledError) {
        // ffmpeg was killed mid-write, so whatever it wrote to outputPath is a truncated/corrupt
        // file, not a usable partial export -- best-effort cleanup, same as ffmpeg's own -y
        // overwrite semantics never leaving a broken file behind on a genuine failure.
        try {
          await unlink(result.filePath)
        } catch {
          // nothing to clean up, or already gone -- either way, not worth failing on
        }
        event.sender.send('export:cancelled')
        return null
      }
      throw err
    } finally {
      currentExportController = null
    }

    return result.filePath
  })

  ipcMain.handle('export:cancel', async (): Promise<void> => {
    currentExportController?.abort()
  })

  ipcMain.handle('layouts:list', async (): Promise<WidgetLayoutPreset[]> => listLayoutPresets(defaultLayoutPresetsFilePath()))

  ipcMain.handle('layouts:save', async (_event, name: string, widgets: WidgetInstance[]): Promise<WidgetLayoutPreset[]> =>
    saveLayoutPreset(defaultLayoutPresetsFilePath(), name, widgets)
  )

  ipcMain.handle('layouts:delete', async (_event, id: string): Promise<WidgetLayoutPreset[]> =>
    deleteLayoutPreset(defaultLayoutPresetsFilePath(), id)
  )

  ipcMain.handle('autosave:has', async (): Promise<boolean> => hasAutosave(autosaveProjectPath()))

  ipcMain.handle('autosave:save', async (_event, payload: ProjectPayload): Promise<void> => {
    await saveProjectToFile(autosaveProjectPath(), payload)
  })

  ipcMain.handle('autosave:load', async (): Promise<ProjectPayload | null> => {
    const projectPath = autosaveProjectPath()
    return hasAutosave(projectPath) ? loadProjectFromFile(projectPath) : null
  })

  ipcMain.handle('autosave:clear', async (): Promise<void> => clearAutosave(autosaveProjectPath()))
}
