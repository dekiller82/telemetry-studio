import { useEffect, useMemo, useRef, useState } from 'react'
import Editor from './components/Editor'
import WhatsNewModal from './components/WhatsNewModal'
import ProjectSettingsModal from './components/ProjectSettingsModal'
import ShortcutsHelpModal from './components/ShortcutsHelpModal'
import ToolbarMenu from './components/ToolbarMenu'
import { useProjectStore } from './store/projectStore'
import { useWidgetStore } from './store/widgetStore'
import { useFontStore } from './store/fontStore'
import { detectLapCrossings, fastestLapRange } from '@shared/telemetry/laps'
import { formatTime } from '@shared/format'
import { DELIVERY_PRESETS, SOURCE_QUALITY_PRESET_ID, findDeliveryPreset } from '@shared/export/deliveryPresets'
import type { ImportProgress, ProjectPayload, RecentProject, UpdateCheckResult } from '@shared/types'

const LAST_SEEN_VERSION_KEY = 'gpo-last-seen-version'
const DISMISSED_UPDATE_VERSION_KEY = 'gpo-dismissed-update-version'
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

const IMPORT_PHASE_LABELS: Record<ImportProgress['phase'], string> = {
  extracting: 'Reading video file',
  parsing: 'Parsing GPS telemetry'
}

/** Fires a real OS notification when an export finishes, so a long export can run in the
 *  background (minimized/unfocused window) without needing to babysit the progress bar. Only
 *  notifies when the window doesn't already have focus -- if the user's watching the progress bar
 *  complete in front of them, a notification on top of that would just be redundant noise. Electron
 *  grants desktop notification permission to the app's own window without a browser-style prompt, so
 *  this is safe to call directly. */
function notifyExportComplete(success: boolean, detail?: string): void {
  if (typeof Notification === 'undefined' || document.hasFocus()) return
  const title = success ? 'Export complete' : 'Export failed'
  const body = success ? 'Your Telemetry Studio export finished.' : (detail ?? 'The export did not complete.')
  if (Notification.permission === 'granted') {
    new Notification(title, { body })
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') new Notification(title, { body })
    })
  }
}

function ImportProgressBanner({ progress }: { progress: ImportProgress }): React.JSX.Element {
  const label = IMPORT_PHASE_LABELS[progress.phase]
  const pct = Math.round(progress.fraction * 100)
  const clipLabel = progress.totalClips > 1 ? `Clip ${progress.clipIndex + 1} of ${progress.totalClips} — ` : ''
  return (
    <div className="export-banner">
      <div className="export-banner__bar">
        <div className="export-banner__fill" style={{ width: `${pct}%` }} />
      </div>
      <span>
        {clipLabel}
        {label}… {pct}%
      </span>
    </div>
  )
}

type UpdatePhase = { phase: 'idle' } | { phase: 'downloading'; percent: number } | { phase: 'downloaded' } | { phase: 'error'; message: string }

function UpdateBanner({
  info,
  canUpdateInApp,
  updatePhase,
  onDismiss,
  onStartUpdate,
  onRestartAndInstall
}: {
  info: UpdateCheckResult
  canUpdateInApp: boolean
  updatePhase: UpdatePhase
  onDismiss: () => void
  onStartUpdate: () => void
  onRestartAndInstall: () => void
}): React.JSX.Element {
  return (
    <div className="export-banner export-banner--update">
      <span>
        A new version ({info.latestVersion}) is available — you're on {info.currentVersion}.
        {updatePhase.phase === 'error' && <span className="export-banner--error"> {updatePhase.message}</span>}
      </span>
      {updatePhase.phase === 'downloading' && (
        <div className="export-banner__bar">
          <div className="export-banner__fill" style={{ width: `${updatePhase.percent}%` }} />
        </div>
      )}
      <a className="import-button import-button--ghost" href={info.releaseUrl} target="_blank" rel="noreferrer">
        View release
      </a>
      {canUpdateInApp && (updatePhase.phase === 'idle' || updatePhase.phase === 'error') && (
        <button className="import-button" onClick={onStartUpdate}>
          Update
        </button>
      )}
      {canUpdateInApp && updatePhase.phase === 'downloading' && (
        <button className="import-button" disabled>
          Downloading… {updatePhase.percent}%
        </button>
      )}
      {canUpdateInApp && updatePhase.phase === 'downloaded' && (
        <button className="import-button" onClick={onRestartAndInstall}>
          Restart &amp; Install
        </button>
      )}
      <button className="export-banner__dismiss" onClick={onDismiss} title="Dismiss until the next release">
        ×
      </button>
    </div>
  )
}

function App(): React.JSX.Element {
  const imported = useProjectStore((s) => s.imported)
  const setImported = useProjectStore((s) => s.setImported)
  const updateImportedClips = useProjectStore((s) => s.updateImportedClips)
  const startFinish = useProjectStore((s) => s.startFinish)
  const setStartFinish = useProjectStore((s) => s.setStartFinish)
  const startFinishRadiusM = useProjectStore((s) => s.startFinishRadiusM)
  const setStartFinishRadiusM = useProjectStore((s) => s.setStartFinishRadiusM)
  const crossingAdjustmentsMs = useProjectStore((s) => s.crossingAdjustmentsMs)
  const setCrossingAdjustmentsMs = useProjectStore((s) => s.setCrossingAdjustmentsMs)
  const ignoredCrossings = useProjectStore((s) => s.ignoredCrossings)
  const setIgnoredCrossings = useProjectStore((s) => s.setIgnoredCrossings)
  const trimStartMs = useProjectStore((s) => s.trimStartMs)
  const trimEndMs = useProjectStore((s) => s.trimEndMs)
  const setTrim = useProjectStore((s) => s.setTrim)
  const defaultFontFamily = useProjectStore((s) => s.defaultFontFamily)
  const setDefaultFontFamily = useProjectStore((s) => s.setDefaultFontFamily)
  const setIsExporting = useProjectStore((s) => s.setIsExporting)
  const widgets = useWidgetStore((s) => s.widgets)
  const loadWidgets = useWidgetStore((s) => s.loadWidgets)
  const resetWidgets = useWidgetStore((s) => s.reset)
  const undo = useWidgetStore((s) => s.undo)
  const redo = useWidgetStore((s) => s.redo)
  const canUndo = useWidgetStore((s) => s.canUndo)
  const canRedo = useWidgetStore((s) => s.canRedo)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [exportState, setExportState] = useState<
    | { phase: 'idle' }
    | { phase: 'exporting'; done: number; total: number }
    | { phase: 'done'; path: string }
    | { phase: 'cancelled' }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' })
  // Set by the onExportCancelled listener the instant the main process confirms ffmpeg was killed --
  // read right after handleExport/handleExportBestLap's own await resolves, so their normal
  // `path ? done : idle` outcome doesn't clobber the 'cancelled' state a beat later, and so a
  // cancelled export doesn't fire the "export complete" OS notification.
  const wasCancelledRef = useRef(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [exportEncoderLabel, setExportEncoderLabel] = useState<string | null>(null)
  // SOURCE_QUALITY_PRESET_ID is a UI-only sentinel, not a real preset id -- selecting it means
  // "no delivery preset," so window.api.exportVideo gets undefined and behaves exactly as before
  // this control existed (native resolution, quality-based CRF encode).
  const [exportPresetId, setExportPresetId] = useState<string>(SOURCE_QUALITY_PRESET_ID)
  // Shown in the Export Best Lap panel so which preset it'll use isn't a silent, easy-to-miss
  // dependency on the toolbar dropdown -- especially now that dropdown lives one File-menu click
  // away rather than always visible.
  const activePresetLabel = exportPresetId === SOURCE_QUALITY_PRESET_ID ? 'Source quality' : (findDeliveryPreset(exportPresetId)?.label ?? 'Source quality')
  // A real user's GoPro 5.3K (5312x2988) source crashed "Source quality" export outright (Electron's
  // "reply was never sent" -- the main process itself dying mid-export, not a hang); switching to a
  // preset that downscales below 4K fixed it for them. Root cause not pinned down (no way to
  // reproduce/profile a native-canvas crash without the actual failing hardware) -- warn rather than
  // block, since plenty of machines may export a very high native resolution just fine.
  const referenceVideo = imported?.clips[0]?.video ?? null
  const isVeryHighResSource = !!referenceVideo && (referenceVideo.width > 3840 || referenceVideo.height > 2160)
  const [autosaveAvailable, setAutosaveAvailable] = useState(false)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [changelog, setChangelog] = useState('')
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [showProjectSettings, setShowProjectSettings] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const systemFonts = useFontStore((s) => s.systemFonts)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [canUpdateInApp, setCanUpdateInApp] = useState(false)
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>({ phase: 'idle' })

  const refreshRecentProjects = (): void => {
    window.api.listRecentProjects().then(setRecentProjects)
  }

  useEffect(() => {
    refreshRecentProjects()
  }, [])

  // Auto-shows once per new version (tracked in localStorage, not anything server-side -- this is
  // a purely local, offline app) -- the changelog itself is only fetched once here and reused by
  // the manually-triggered "What's New" button too, rather than every open re-reading the file.
  useEffect(() => {
    Promise.all([window.api.getAppVersion(), window.api.getChangelog()]).then(([version, text]) => {
      setChangelog(text)
      const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY)
      if (lastSeen !== version) {
        setShowWhatsNew(true)
        localStorage.setItem(LAST_SEEN_VERSION_KEY, version)
      }
    })
  }, [])

  // The one deliberate network call in an otherwise fully offline/local app -- checked once per
  // launch against GitHub's latest-release API, never blocking anything and never surfacing an
  // error if it fails (no internet, GitHub unreachable, rate-limited); see checkForUpdate's own
  // "never throw" contract. Suppressed per-version (not just per-session) once dismissed, the same
  // way the What's New modal tracks LAST_SEEN_VERSION_KEY, so closing it doesn't nag again on every
  // relaunch until an actually newer release ships.
  useEffect(() => {
    window.api.checkForUpdate().then((result) => {
      if (!result || !result.updateAvailable) return
      if (localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) === result.latestVersion) return
      setUpdateInfo(result)
    })
  }, [])

  // False on macOS -- Squirrel.Mac (Electron's own auto-updater mechanism there) requires the app be
  // code-signed to replace itself, and this project has no Apple Developer ID. See main/app/updater.ts.
  useEffect(() => {
    window.api.isInAppUpdateSupported().then(setCanUpdateInApp)
  }, [])

  function handleStartUpdate(): void {
    setUpdatePhase({ phase: 'downloading', percent: 0 })
    window.api.startUpdate()
  }

  function handleRestartAndInstall(): void {
    window.api.quitAndInstallUpdate()
  }

  useEffect(() => {
    return window.api.onUpdateProgress((percent) => {
      setUpdatePhase({ phase: 'downloading', percent })
    })
  }, [])

  useEffect(() => {
    return window.api.onUpdateDownloaded(() => {
      setUpdatePhase({ phase: 'downloaded' })
    })
  }, [])

  useEffect(() => {
    return window.api.onUpdateError((message) => {
      setUpdatePhase({ phase: 'error', message })
    })
  }, [])

  // Loaded once at startup so the global font picker (Project Settings modal) and every widget's own
  // per-widget font dropdown share the same list without each triggering its own IPC round trip.
  const loadSystemFonts = useFontStore((s) => s.loadSystemFonts)
  useEffect(() => {
    loadSystemFonts()
  }, [loadSystemFonts])

  function dismissUpdateNotice(): void {
    if (updateInfo) localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, updateInfo.latestVersion)
    setUpdateInfo(null)
    setUpdatePhase({ phase: 'idle' })
  }

  useEffect(() => {
    return window.api.onExportProgress(({ done, total }) => {
      setExportState({ phase: 'exporting', done, total })
    })
  }, [])

  useEffect(() => {
    return window.api.onExportCancelled(() => {
      wasCancelledRef.current = true
      setExportState({ phase: 'cancelled' })
    })
  }, [])

  // "?" opens the shortcuts/getting-started panel, matching the convention plenty of other apps
  // (Slack, Gmail, Figma...) already use -- skipped while a text/select input has focus so it
  // doesn't fire while actually typing a literal "?" into e.g. the layout-name field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== '?') return
      const target = e.target as HTMLElement | null
      if (target && EDITABLE_TAGS.has(target.tagName)) return
      e.preventDefault()
      setShowShortcutsHelp((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Checked once at launch, not continuously -- an autosave only matters for recovering from a
  // crash/force-quit on the PREVIOUS run; once this session has its own imported project (or the
  // user dismisses it), it's no longer relevant until the next relaunch.
  useEffect(() => {
    window.api.hasAutosave().then(setAutosaveAvailable)
  }, [])

  // Paired with the crash-diagnostics logging in main/index.ts: a renderer/GPU crash mid-session
  // shouldn't also silently lose whatever hasn't been manually saved to a real .gpo file. Runs on a
  // fixed wall-clock timer, not debounced off every edit -- the telemetry cache can be several MB
  // for a long session, so writing it on every widget tweak would be wasteful I/O for a
  // just-in-case safety net, not a feature the user is actively watching. Latest state is read via
  // a ref (updated every render) rather than closed over directly, so the interval itself is set up
  // ONCE and actually fires every 60s of wall-clock time -- putting these fast-changing values in
  // this effect's own deps would tear down and restart the timer on every single edit, and a user
  // who never pauses editing for a full 60s would never get an autosave at all.
  const latestAutosaveInputRef = useRef({
    imported,
    widgets,
    startFinish,
    startFinishRadiusM,
    crossingAdjustmentsMs,
    ignoredCrossings,
    trimStartMs,
    trimEndMs,
    defaultFontFamily
  })
  latestAutosaveInputRef.current = {
    imported,
    widgets,
    startFinish,
    startFinishRadiusM,
    crossingAdjustmentsMs,
    ignoredCrossings,
    trimStartMs,
    trimEndMs,
    defaultFontFamily
  }
  useEffect(() => {
    const AUTOSAVE_INTERVAL_MS = 60_000
    const interval = setInterval(() => {
      const current = latestAutosaveInputRef.current
      if (!current.imported) return
      const payload: ProjectPayload = { ...current, imported: current.imported }
      window.api.saveAutosave(payload).catch((err) => {
        console.error('[autosave] failed:', err)
      })
    }, AUTOSAVE_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    return window.api.onExportEncoder(({ label }) => setExportEncoderLabel(label))
  }, [])

  useEffect(() => {
    return window.api.onImportProgress((progress) => {
      setImportProgress(progress)
    })
  }, [])

  async function handleImport(): Promise<void> {
    setError(null)
    setSavedPath(null)
    const filePaths = await window.api.pickVideoFiles()
    if (filePaths.length === 0) return

    setStatus('loading')
    setImportProgress({ phase: 'extracting', fraction: 0, clipIndex: 0, totalClips: filePaths.length })
    try {
      const result = await window.api.importVideo(filePaths)
      console.log('[telemetry] parsed import result:', result)
      setImported(result)
      resetWidgets()
      setStatus('idle')
    } catch (err) {
      console.error('[telemetry] import failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    } finally {
      setImportProgress(null)
    }
  }

  async function handleAddClips(): Promise<void> {
    if (!imported) return
    setError(null)
    const filePaths = await window.api.pickVideoFiles()
    if (filePaths.length === 0) return

    setStatus('loading')
    setImportProgress({ phase: 'extracting', fraction: 0, clipIndex: imported.clips.length, totalClips: imported.clips.length + filePaths.length })
    try {
      const result = await window.api.addClips(imported, filePaths)
      updateImportedClips(result)
      setStatus('idle')
    } catch (err) {
      console.error('[telemetry] add clips failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    } finally {
      setImportProgress(null)
    }
  }

  async function handleOpenProject(): Promise<void> {
    setError(null)
    setSavedPath(null)
    setStatus('loading')
    try {
      const project = await window.api.loadProject()
      if (!project) {
        setStatus('idle')
        return
      }
      setImported(project.imported)
      loadWidgets(project.widgets)
      setStartFinish(project.startFinish)
      setStartFinishRadiusM(project.startFinishRadiusM)
      setCrossingAdjustmentsMs(project.crossingAdjustmentsMs)
      setIgnoredCrossings(project.ignoredCrossings)
      setTrim(project.trimStartMs, project.trimEndMs)
      setDefaultFontFamily(project.defaultFontFamily)
      setStatus('idle')
      refreshRecentProjects()
    } catch (err) {
      console.error('[project] load failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  async function handleOpenRecentProject(projectPath: string): Promise<void> {
    setError(null)
    setSavedPath(null)
    setStatus('loading')
    try {
      const project = await window.api.loadProjectFromPath(projectPath)
      setImported(project.imported)
      loadWidgets(project.widgets)
      setStartFinish(project.startFinish)
      setStartFinishRadiusM(project.startFinishRadiusM)
      setCrossingAdjustmentsMs(project.crossingAdjustmentsMs)
      setIgnoredCrossings(project.ignoredCrossings)
      setTrim(project.trimStartMs, project.trimEndMs)
      setDefaultFontFamily(project.defaultFontFamily)
      setStatus('idle')
    } catch (err) {
      console.error('[project] recent-project load failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
      refreshRecentProjects() // the stale entry was dropped on the main side -- reflect that here too
    }
  }

  async function handleRecoverAutosave(): Promise<void> {
    setError(null)
    setStatus('loading')
    try {
      const project = await window.api.loadAutosave()
      if (!project) {
        setAutosaveAvailable(false)
        setStatus('idle')
        return
      }
      setImported(project.imported)
      loadWidgets(project.widgets)
      setStartFinish(project.startFinish)
      setStartFinishRadiusM(project.startFinishRadiusM)
      setCrossingAdjustmentsMs(project.crossingAdjustmentsMs)
      setIgnoredCrossings(project.ignoredCrossings)
      setTrim(project.trimStartMs, project.trimEndMs)
      setDefaultFontFamily(project.defaultFontFamily)
      setAutosaveAvailable(false)
      setStatus('idle')
    } catch (err) {
      console.error('[autosave] recovery failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  function handleDismissAutosave(): void {
    setAutosaveAvailable(false)
    window.api.clearAutosave().catch((err) => console.error('[autosave] failed to clear:', err))
  }

  async function handleSaveProject(): Promise<void> {
    if (!imported) return
    setError(null)
    try {
      const path = await window.api.saveProject({
        imported,
        widgets,
        startFinish,
        startFinishRadiusM,
        crossingAdjustmentsMs,
        ignoredCrossings,
        trimStartMs,
        trimEndMs,
        defaultFontFamily
      })
      if (path) {
        setSavedPath(path)
        refreshRecentProjects()
      }
    } catch (err) {
      console.error('[project] save failed:', err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleExport(): Promise<void> {
    if (!imported || widgets.length === 0) return
    setExportEncoderLabel(null)
    setExportState({ phase: 'exporting', done: 0, total: 1 })
    setIsExporting(true)
    wasCancelledRef.current = false
    setCancelRequested(false)
    try {
      const path = await window.api.exportVideo(
        { imported, widgets, startFinish, startFinishRadiusM, crossingAdjustmentsMs, ignoredCrossings, trimStartMs, trimEndMs, defaultFontFamily },
        exportPresetId === SOURCE_QUALITY_PRESET_ID ? undefined : exportPresetId
      )
      if (wasCancelledRef.current) return
      setExportState(path ? { phase: 'done', path } : { phase: 'idle' })
      notifyExportComplete(true)
    } catch (err) {
      if (wasCancelledRef.current) return
      console.error('[export] failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      setExportState({ phase: 'error', message })
      notifyExportComplete(false, message)
    } finally {
      setIsExporting(false)
    }
  }

  // The session's single fastest completed lap -- only needs the crossings array (not a full
  // TelemetrySampler), recomputed only when the telemetry/start-finish point actually change.
  const fastestLap = useMemo(() => {
    if (!imported || !startFinish) return null
    return fastestLapRange(
      detectLapCrossings(imported.telemetry.samples, startFinish, startFinishRadiusM, undefined, crossingAdjustmentsMs, ignoredCrossings)
    )
  }, [imported, startFinish, startFinishRadiusM, crossingAdjustmentsMs, ignoredCrossings])

  const [showBestLapExportForm, setShowBestLapExportForm] = useState(false)
  const [bestLapPaddingBeforeSec, setBestLapPaddingBeforeSec] = useState(5)
  const [bestLapPaddingAfterSec, setBestLapPaddingAfterSec] = useState(5)

  // Exports just the fastest lap (plus configurable padding) as its own clip -- builds a ProjectPayload
  // with an OVERRIDDEN trim range for this one export only, never touching the user's actual saved
  // trim, same "one-shot payload, no mutation" approach as any other export.
  async function handleExportBestLap(): Promise<void> {
    if (!imported || widgets.length === 0 || !fastestLap) return
    const totalDurationMs = imported.telemetry.videoDurationMs
    const clipTrimStartMs = Math.max(0, fastestLap.startCts - bestLapPaddingBeforeSec * 1000)
    const clipTrimEndMs = Math.min(totalDurationMs, fastestLap.endCts + bestLapPaddingAfterSec * 1000)
    setShowBestLapExportForm(false)
    setExportEncoderLabel(null)
    setExportState({ phase: 'exporting', done: 0, total: 1 })
    setIsExporting(true)
    wasCancelledRef.current = false
    setCancelRequested(false)
    try {
      const path = await window.api.exportVideo(
        {
          imported,
          widgets,
          startFinish,
          startFinishRadiusM,
          crossingAdjustmentsMs,
          ignoredCrossings,
          trimStartMs: clipTrimStartMs,
          trimEndMs: clipTrimEndMs,
          defaultFontFamily
        },
        exportPresetId === SOURCE_QUALITY_PRESET_ID ? undefined : exportPresetId
      )
      if (wasCancelledRef.current) return
      setExportState(path ? { phase: 'done', path } : { phase: 'idle' })
      notifyExportComplete(true)
    } catch (err) {
      if (wasCancelledRef.current) return
      console.error('[export best lap] failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      setExportState({ phase: 'error', message })
      notifyExportComplete(false, message)
    } finally {
      setIsExporting(false)
    }
  }

  function handleCancelExport(): void {
    setCancelRequested(true)
    window.api.cancelExport().catch((err) => {
      console.error('[export] cancel request failed:', err)
    })
  }

  const isExporting = exportState.phase === 'exporting'

  if (imported) {
    return (
      <div className="app-root">
        <header className="toolbar">
          <div className="app-shell__brand app-shell__brand--compact">
            <span className="app-shell__dot" />
            Telemetry Studio
          </div>
          <div className="toolbar__actions">
            {savedPath && <span className="toolbar__saved-hint">Saved</span>}
            <button
              className="import-button import-button--ghost"
              onClick={() => setShowShortcutsHelp(true)}
              title="Keyboard shortcuts & getting started (?)"
              aria-label="Keyboard shortcuts and getting started"
            >
              ?
            </button>
            <button
              className="import-button import-button--ghost"
              onClick={undo}
              disabled={!canUndo || isExporting}
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              className="import-button import-button--ghost"
              onClick={redo}
              disabled={!canRedo || isExporting}
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
            <ToolbarMenu label="File" disabled={isExporting}>
              {(closeMenu) => (
                <>
                  <button
                    className="toolbar-menu__item"
                    onClick={() => {
                      handleSaveProject()
                      closeMenu()
                    }}
                  >
                    Save Project
                  </button>
                  <button
                    className="toolbar-menu__item"
                    onClick={() => {
                      handleOpenProject()
                      closeMenu()
                    }}
                    disabled={status === 'loading'}
                  >
                    Open Project
                  </button>
                  <button
                    className="toolbar-menu__item"
                    onClick={() => {
                      handleAddClips()
                      closeMenu()
                    }}
                    disabled={status === 'loading'}
                    title="Append more clips to the end of this timeline"
                  >
                    + Add Clip
                  </button>
                  <button
                    className="toolbar-menu__item"
                    onClick={() => {
                      handleImport()
                      closeMenu()
                    }}
                    disabled={status === 'loading'}
                  >
                    {status === 'loading' ? 'Importing…' : 'Import different clip(s)'}
                  </button>
                  <button
                    className="toolbar-menu__item"
                    onClick={() => {
                      setShowBestLapExportForm((v) => !v)
                      closeMenu()
                    }}
                    disabled={widgets.length === 0 || !fastestLap}
                    title={
                      !fastestLap
                        ? 'No completed lap yet -- set a start/finish line and complete at least one lap'
                        : `Export just your fastest lap (Lap ${fastestLap.lapNumber})`
                    }
                  >
                    🏁 Export Best Lap…
                  </button>
                  <button
                    className="toolbar-menu__item"
                    onClick={() => {
                      setShowProjectSettings(true)
                      closeMenu()
                    }}
                  >
                    Project Settings…
                  </button>
                  <button
                    className="toolbar-menu__item"
                    onClick={() => {
                      setShowWhatsNew(true)
                      closeMenu()
                    }}
                  >
                    What's New
                  </button>
                </>
              )}
            </ToolbarMenu>
            <select
              className="export-preset-select"
              value={exportPresetId}
              onChange={(e) => setExportPresetId(e.target.value)}
              disabled={isExporting}
              title="Delivery preset -- resolution/bitrate bundled for a specific platform. Source quality keeps the video at its native resolution."
            >
              <option value={SOURCE_QUALITY_PRESET_ID}>Source quality</option>
              {DELIVERY_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id} title={preset.description}>
                  {preset.label}
                </option>
              ))}
            </select>
            <button
              className="import-button"
              onClick={handleExport}
              disabled={isExporting || widgets.length === 0}
              title={widgets.length === 0 ? 'Add at least one widget before exporting' : undefined}
            >
              {isExporting ? 'Exporting…' : 'Export Video'}
            </button>
          </div>
        </header>
        {isVeryHighResSource && exportPresetId === SOURCE_QUALITY_PRESET_ID && referenceVideo && (
          <div className="export-banner export-banner--warning">
            This clip's native resolution ({referenceVideo.width}x{referenceVideo.height}) is unusually high and
            has caused Export to crash on some systems. If Export fails, try a delivery preset instead of Source
            quality.
            <button className="export-banner__cancel" onClick={() => setExportPresetId('youtube-4k')}>
              Switch to YouTube (4K)
            </button>
          </div>
        )}
        {showBestLapExportForm && fastestLap && (
          <div className="best-lap-export-form">
            <span>
              Export Lap {fastestLap.lapNumber} ({formatTime(fastestLap.timeMs, true)}) using{' '}
              <strong>{activePresetLabel}</strong>, with
            </span>
            <label className="best-lap-export-form__field">
              <input
                type="number"
                min={0}
                max={60}
                step={1}
                value={bestLapPaddingBeforeSec}
                onChange={(e) => setBestLapPaddingBeforeSec(Math.max(0, Number(e.target.value)))}
              />
              <span>s before</span>
            </label>
            <label className="best-lap-export-form__field">
              <input
                type="number"
                min={0}
                max={60}
                step={1}
                value={bestLapPaddingAfterSec}
                onChange={(e) => setBestLapPaddingAfterSec(Math.max(0, Number(e.target.value)))}
              />
              <span>s after</span>
            </label>
            <button className="import-button" onClick={handleExportBestLap}>
              Export
            </button>
            <button className="import-button import-button--ghost" onClick={() => setShowBestLapExportForm(false)}>
              Cancel
            </button>
          </div>
        )}
        {updateInfo && (
        <UpdateBanner
          info={updateInfo}
          canUpdateInApp={canUpdateInApp}
          updatePhase={updatePhase}
          onDismiss={dismissUpdateNotice}
          onStartUpdate={handleStartUpdate}
          onRestartAndInstall={handleRestartAndInstall}
        />
      )}
        {status === 'error' && <p className="app-shell__error toolbar__error">{error}</p>}
        {status === 'loading' && importProgress && <ImportProgressBanner progress={importProgress} />}
        {exportState.phase === 'exporting' && (
          <div className="export-banner">
            <div className="export-banner__bar">
              <div
                className="export-banner__fill"
                style={{ width: `${Math.round((exportState.done / Math.max(1, exportState.total)) * 100)}%` }}
              />
            </div>
            <span>
              Exporting frame {exportState.done} / {exportState.total}
              {exportEncoderLabel ? ` · ${exportEncoderLabel}` : ''}
            </span>
            <button className="export-banner__cancel" onClick={handleCancelExport} disabled={cancelRequested}>
              {cancelRequested ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
        )}
        {exportState.phase === 'cancelled' && (
          <div className="export-banner export-banner--cancelled">
            Export cancelled
            <button className="export-banner__dismiss" onClick={() => setExportState({ phase: 'idle' })}>
              ×
            </button>
          </div>
        )}
        {exportState.phase === 'done' && (
          <div className="export-banner export-banner--done">
            Exported to {exportState.path}
            <button className="export-banner__dismiss" onClick={() => setExportState({ phase: 'idle' })}>
              ×
            </button>
          </div>
        )}
        {exportState.phase === 'error' && (
          <div className="export-banner export-banner--error">
            Export failed: {exportState.message}
            <button className="export-banner__dismiss" onClick={() => setExportState({ phase: 'idle' })}>
              ×
            </button>
          </div>
        )}
        <Editor />
        <WhatsNewModal isOpen={showWhatsNew} changelog={changelog} onClose={() => setShowWhatsNew(false)} />
        <ProjectSettingsModal
          isOpen={showProjectSettings}
          defaultFontFamily={defaultFontFamily}
          systemFonts={systemFonts}
          onChangeDefaultFontFamily={setDefaultFontFamily}
          onClose={() => setShowProjectSettings(false)}
        />
        <ShortcutsHelpModal isOpen={showShortcutsHelp} onClose={() => setShowShortcutsHelp(false)} />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className="app-shell__brand">
        <span className="app-shell__dot" />
        Telemetry Studio
      </div>

      <div className="app-shell__actions">
        <button className="import-button" onClick={handleImport} disabled={status === 'loading'}>
          {status === 'loading' ? 'Importing…' : 'Import GoPro Clip(s)'}
        </button>
        <button className="import-button import-button--ghost" onClick={handleOpenProject} disabled={status === 'loading'}>
          Open Project
        </button>
        <button className="import-button import-button--ghost" onClick={() => setShowWhatsNew(true)}>
          What's New
        </button>
        <button className="import-button import-button--ghost" onClick={() => setShowShortcutsHelp(true)}>
          Shortcuts &amp; Getting Started
        </button>
      </div>

      {updateInfo && (
        <UpdateBanner
          info={updateInfo}
          canUpdateInApp={canUpdateInApp}
          updatePhase={updatePhase}
          onDismiss={dismissUpdateNotice}
          onStartUpdate={handleStartUpdate}
          onRestartAndInstall={handleRestartAndInstall}
        />
      )}

      {autosaveAvailable && status !== 'loading' && (
        <div className="export-banner export-banner--done">
          An autosaved session was found (likely from a crash or force-quit) — recover it?
          <button className="import-button import-button--ghost" onClick={handleRecoverAutosave}>
            Recover
          </button>
          <button className="export-banner__dismiss" onClick={handleDismissAutosave} title="Discard the autosave">
            ×
          </button>
        </div>
      )}

      {status === 'loading' && importProgress && <ImportProgressBanner progress={importProgress} />}
      {status === 'error' && <p className="app-shell__error">{error}</p>}
      {status !== 'loading' && status !== 'error' && (
        <p className="app-shell__hint">Import one or more GoPro clips (select all parts of a split recording at once) or open a saved project to get started.</p>
      )}

      {recentProjects.length > 0 && (
        <div className="recent-projects">
          <div className="recent-projects__header">Recent Projects</div>
          <ul className="recent-projects__list">
            {recentProjects.map((p) => (
              <li key={p.path} className="recent-projects__item">
                <button
                  className="recent-projects__open"
                  onClick={() => handleOpenRecentProject(p.path)}
                  disabled={status === 'loading'}
                  title={p.path}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <WhatsNewModal isOpen={showWhatsNew} changelog={changelog} onClose={() => setShowWhatsNew(false)} />
      <ShortcutsHelpModal isOpen={showShortcutsHelp} onClose={() => setShowShortcutsHelp(false)} />
    </div>
  )
}

export default App
