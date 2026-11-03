import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { OverlayExportRequest } from '../shared/export/overlayExport'
import type { ImportResult, ProjectPayload, ImportProgress, VideoMeta, WidgetInstance, WidgetLayoutPreset, RecentProject, UpdateCheckResult } from '../shared/types'

export interface ExportProgress {
  done: number
  total: number
}

const api = {
  pickVideoFiles: (): Promise<string[]> => ipcRenderer.invoke('video:pick'),
  importVideo: (filePaths: string[]): Promise<ImportResult> => ipcRenderer.invoke('video:import', filePaths),
  addClips: (existing: ImportResult, filePaths: string[]): Promise<ImportResult> =>
    ipcRenderer.invoke('video:add-clips', existing, filePaths),
  ensurePreviewProxy: (video: VideoMeta, forceTranscode?: boolean): Promise<string> =>
    ipcRenderer.invoke('video:ensure-preview-proxy', video, forceTranscode),
  saveProject: (payload: ProjectPayload): Promise<string | null> => ipcRenderer.invoke('project:save', payload),
  loadProject: (): Promise<ProjectPayload | null> => ipcRenderer.invoke('project:load'),
  loadProjectFromPath: (projectPath: string): Promise<ProjectPayload> => ipcRenderer.invoke('project:load-path', projectPath),
  listRecentProjects: (): Promise<RecentProject[]> => ipcRenderer.invoke('recent:list'),
  exportVideo: (payload: ProjectPayload, deliveryPresetId?: string, request?: OverlayExportRequest): Promise<string | null> =>
    ipcRenderer.invoke('export:start', payload, deliveryPresetId, request),
  cancelExport: (): Promise<void> => ipcRenderer.invoke('export:cancel'),
  listLayoutPresets: (): Promise<WidgetLayoutPreset[]> => ipcRenderer.invoke('layouts:list'),
  saveLayoutPreset: (name: string, widgets: WidgetInstance[]): Promise<WidgetLayoutPreset[]> =>
    ipcRenderer.invoke('layouts:save', name, widgets),
  deleteLayoutPreset: (id: string): Promise<WidgetLayoutPreset[]> => ipcRenderer.invoke('layouts:delete', id),
  hasAutosave: (): Promise<boolean> => ipcRenderer.invoke('autosave:has'),
  saveAutosave: (payload: ProjectPayload): Promise<void> => ipcRenderer.invoke('autosave:save', payload),
  loadAutosave: (): Promise<ProjectPayload | null> => ipcRenderer.invoke('autosave:load'),
  clearAutosave: (): Promise<void> => ipcRenderer.invoke('autosave:clear'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  getChangelog: (): Promise<string> => ipcRenderer.invoke('app:getChangelog'),
  checkForUpdate: (): Promise<UpdateCheckResult | null> => ipcRenderer.invoke('app:checkForUpdate'),
  listSystemFonts: (): Promise<string[]> => ipcRenderer.invoke('fonts:listSystem'),
  isInAppUpdateSupported: (): Promise<boolean> => ipcRenderer.invoke('updater:supported'),
  startUpdate: (): Promise<void> => ipcRenderer.invoke('updater:start'),
  quitAndInstallUpdate: (): Promise<void> => ipcRenderer.invoke('updater:quitAndInstall'),
  onExportProgress: (callback: (progress: ExportProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: ExportProgress): void => callback(progress)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },
  onImportProgress: (callback: (progress: ImportProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: ImportProgress): void => callback(progress)
    ipcRenderer.on('video:import-progress', listener)
    return () => ipcRenderer.removeListener('video:import-progress', listener)
  },
  onPreviewProxyProgress: (callback: (progress: { fraction: number }) => void): (() => void) => {
    const listener = (_event: unknown, progress: { fraction: number }): void => callback(progress)
    ipcRenderer.on('video:preview-proxy-progress', listener)
    return () => ipcRenderer.removeListener('video:preview-proxy-progress', listener)
  },
  onExportEncoder: (callback: (info: { label: string }) => void): (() => void) => {
    const listener = (_event: unknown, info: { label: string }): void => callback(info)
    ipcRenderer.on('export:encoder', listener)
    return () => ipcRenderer.removeListener('export:encoder', listener)
  },
  onExportCancelled: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('export:cancelled', listener)
    return () => ipcRenderer.removeListener('export:cancelled', listener)
  },
  onUpdateProgress: (callback: (percent: number) => void): (() => void) => {
    const listener = (_event: unknown, percent: number): void => callback(percent)
    ipcRenderer.on('updater:progress', listener)
    return () => ipcRenderer.removeListener('updater:progress', listener)
  },
  onUpdateDownloaded: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('updater:downloaded', listener)
    return () => ipcRenderer.removeListener('updater:downloaded', listener)
  },
  onUpdateError: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: unknown, message: string): void => callback(message)
    ipcRenderer.on('updater:error', listener)
    return () => ipcRenderer.removeListener('updater:error', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
