import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { ProjectPayload } from '../../shared/types'
import type { OverlayExportRequest } from '../../shared/export/overlayExport'
import { createGpsTrackWidget, createSectorTimerWidget } from '../../shared/widgets/defaults'
import { ExportCancelledError } from '../export/exportCancellation'
import type { RunExportOptions } from '../export/runExport'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), save: vi.fn(), run: vi.fn(), send: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle }, dialog: { showSaveDialog: mocks.save },
  BrowserWindow: { getFocusedWindow: () => null }, app: {}
}))
vi.mock('../video/previewProxy', () => ({ ensurePreviewProxy: vi.fn() }))
vi.mock('../video/clipImport', () => ({ probeAndParseClip: vi.fn(), buildImportResult: vi.fn(), sliceClipTelemetry: vi.fn() }))
vi.mock('../video/goproClipOrder', () => ({ orderAndValidateGoProClipPaths: vi.fn() }))
vi.mock('../project/persistence', () => ({ loadProjectFromFile: vi.fn(), saveProjectToFile: vi.fn() }))
vi.mock('../project/layoutPresets', () => ({ listLayoutPresets: vi.fn(), saveLayoutPreset: vi.fn(), deleteLayoutPreset: vi.fn(), defaultLayoutPresetsFilePath: vi.fn() }))
vi.mock('../project/autosave', () => ({ autosaveProjectPath: vi.fn(), hasAutosave: vi.fn(), clearAutosave: vi.fn() }))
vi.mock('../project/recentProjects', () => ({ listRecentProjects: vi.fn(), addRecentProject: vi.fn(), removeRecentProject: vi.fn(), defaultRecentProjectsFilePath: vi.fn() }))
vi.mock('../app/changelog', () => ({ defaultChangelogPath: vi.fn(), readChangelog: vi.fn() }))
vi.mock('../app/updateCheck', () => ({ checkForUpdate: vi.fn() }))
vi.mock('../app/updater', () => ({ SUPPORTS_IN_APP_UPDATE: false, startUpdate: vi.fn(), quitAndInstallUpdate: vi.fn() }))
vi.mock('../app/systemFonts', () => ({ listSystemFonts: vi.fn() }))
vi.mock('../export/runExport', async () => ({
  runExport: mocks.run,
  ExportCancelledError: (await import('../export/exportCancellation')).ExportCancelledError,
  InsufficientDiskSpaceError: (await import('../export/exportDiskSpace')).InsufficientDiskSpaceError
}))

import { registerIpcHandlers } from './handlers'

function payload(): ProjectPayload {
  return {
    imported: {
      clips: [{ startOffsetMs: 0, video: {
        path: 'camera.mp4', fileName: 'camera.mp4', width: 2704, height: 1520,
        fps: 50, durationMs: 1000, codec: 'h264', pixFmt: 'yuv420p', hasAudio: true, lrvPath: null
      } }],
      telemetry: { deviceName: 'test', gpsStream: 'GPS5', videoDurationMs: 1000, samples: [], accel: [], gyro: [], gravity: [] }
    },
    widgets: [createGpsTrackWidget(), createSectorTimerWidget()],
    startFinish: null, startFinishRadiusM: 15, crossingAdjustmentsMs: {}, ignoredCrossings: {},
    trimStartMs: 200, trimEndMs: 800, defaultFontFamily: 'formula1'
  }
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  return mocks.handle.mock.calls.find(call => call[0] === channel)![1]
}
const event = { sender: { send: mocks.send } } as unknown as IpcMainInvokeEvent

beforeEach(() => {
  vi.resetAllMocks()
  mocks.save.mockResolvedValue({ canceled: false, filePath: 'overlay.mov' })
  mocks.run.mockResolvedValue(undefined)
  registerIpcHandlers()
})

describe('export request IPC boundary', () => {
  it.each(['qtrle', 'prores4444'].flatMap(format => [1, 2, 3, 4].map(renderWorkers => ({ format, renderWorkers }))))(
    'keeps source size and selected transforms for $format with $renderWorkers workers', async ({ format, renderWorkers }) => {
      const project = payload()
      const selected = project.widgets[1]
      Object.assign(selected, { x: 0.23, y: 0.31, w: 0.4, h: 0.2, rotation: 17 })
      const result = await handler('export:start')(event, project, 'youtube-1080p', { format, renderWorkers, widgetIds: [selected.id] })
      expect(result).toBe('overlay.mov')
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ filters: [{ name: 'Transparent MOV', extensions: ['mov'] }], defaultPath: 'overlay.mov' })
      const options = mocks.run.mock.calls[0][0] as RunExportOptions
      expect(options.widgets).toEqual([selected])
      expect(options.widgets[0]).toBe(selected)
      expect(options.settings).toMatchObject({ format, renderWorkers, width: 2704, height: 1520, fps: 50 })
      expect(options.settings.videoBitrateKbps).toBeUndefined()
      expect(options.settings.audioBitrateKbps).toBeUndefined()
      expect(options).toMatchObject({ trimStartMs: 200, trimEndMs: 800 })
      expect(options.clips).toBe(project.imported.clips)
    }
  )

  it('preserves legacy video callers and their delivery preset', async () => {
    const project = payload()
    await handler('export:start')(event, project, 'youtube-1080p')
    const options = mocks.run.mock.calls[0][0] as RunExportOptions
    expect(options.widgets).toBe(project.widgets)
    expect(options.settings).toMatchObject({ format: 'video', width: 1920, height: 1080 })
    expect(options.settings.videoBitrateKbps).toBeGreaterThan(0)
    expect(mocks.save.mock.calls[0][0].defaultPath).toBe('export.mp4')
  })

  it.each([
    { format: 'h264-alpha' }, { renderWorkers: 5 }, { renderWorkers: '4' },
    { format: 'qtrle', widgetIds: [] }, { format: 'prores4444', widgetIds: ['missing'] }
  ])('rejects invalid requests before opening a dialog or starting export: %j', async request => {
    await expect(handler('export:start')(event, payload(), undefined, request)).rejects.toThrow()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('returns from a cancelled save dialog without starting export', async () => {
    mocks.save.mockResolvedValueOnce({ canceled: true })
    await expect(handler('export:start')(event, payload(), undefined, { format: 'qtrle' })).resolves.toBeNull()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('passes cancel to an in-flight transparent request and releases the controller afterwards', async () => {
    const request: OverlayExportRequest = { format: 'qtrle', renderWorkers: 4 }
    mocks.run.mockImplementationOnce((options: RunExportOptions) => new Promise<void>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new ExportCancelledError()), { once: true })
    }))
    const result = handler('export:start')(event, payload(), undefined, request)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce(), { interval: 1 })
    const signal = (mocks.run.mock.calls[0][0] as RunExportOptions).signal!
    await handler('export:cancel')()
    expect(signal.aborted).toBe(true)
    await expect(result).resolves.toBeNull()
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('export:cancelled')
    await expect(handler('export:cancel')()).resolves.toBeUndefined()
  })
})
