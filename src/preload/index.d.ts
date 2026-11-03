import { ElectronAPI } from '@electron-toolkit/preload'
import type { OverlayExportRequest } from '../shared/export/overlayExport'
import type { ImportResult, ProjectPayload, ImportProgress, VideoMeta, WidgetInstance, WidgetLayoutPreset, RecentProject, UpdateCheckResult } from '../shared/types'

interface ExportProgress {
  done: number
  total: number
}

interface Api {
  pickVideoFiles: () => Promise<string[]>
  importVideo: (filePaths: string[]) => Promise<ImportResult>
  addClips: (existing: ImportResult, filePaths: string[]) => Promise<ImportResult>
  ensurePreviewProxy: (video: VideoMeta, forceTranscode?: boolean) => Promise<string>
  saveProject: (payload: ProjectPayload) => Promise<string | null>
  loadProject: () => Promise<ProjectPayload | null>
  loadProjectFromPath: (projectPath: string) => Promise<ProjectPayload>
  listRecentProjects: () => Promise<RecentProject[]>
  /** deliveryPresetId: an id from shared/export/deliveryPresets.ts, or omitted/undefined for the
   *  default "source quality" export (unchanged, quality-based CRF encode at the source resolution). */
  exportVideo: (payload: ProjectPayload, deliveryPresetId?: string, request?: OverlayExportRequest) => Promise<string | null>
  cancelExport: () => Promise<void>
  listLayoutPresets: () => Promise<WidgetLayoutPreset[]>
  saveLayoutPreset: (name: string, widgets: WidgetInstance[]) => Promise<WidgetLayoutPreset[]>
  deleteLayoutPreset: (id: string) => Promise<WidgetLayoutPreset[]>
  hasAutosave: () => Promise<boolean>
  saveAutosave: (payload: ProjectPayload) => Promise<void>
  loadAutosave: () => Promise<ProjectPayload | null>
  clearAutosave: () => Promise<void>
  getAppVersion: () => Promise<string>
  getChangelog: () => Promise<string>
  checkForUpdate: () => Promise<UpdateCheckResult | null>
  listSystemFonts: () => Promise<string[]>
  /** False on macOS -- Squirrel.Mac (Electron's auto-updater mechanism there) requires the app be
   *  code-signed to replace itself, and this project has no Apple Developer ID. See main/app/updater.ts. */
  isInAppUpdateSupported: () => Promise<boolean>
  startUpdate: () => Promise<void>
  quitAndInstallUpdate: () => Promise<void>
  onExportProgress: (callback: (progress: ExportProgress) => void) => () => void
  onImportProgress: (callback: (progress: ImportProgress) => void) => () => void
  onPreviewProxyProgress: (callback: (progress: { fraction: number }) => void) => () => void
  onExportEncoder: (callback: (info: { label: string }) => void) => () => void
  onExportCancelled: (callback: () => void) => () => void
  onUpdateProgress: (callback: (percent: number) => void) => () => void
  onUpdateDownloaded: (callback: () => void) => () => void
  onUpdateError: (callback: (message: string) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
