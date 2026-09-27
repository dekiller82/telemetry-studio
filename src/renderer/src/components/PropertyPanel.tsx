import { useEffect, useMemo, useState } from 'react'
import { convertSpeed, convertToMps, speedUnitLabel, type SpeedUnit } from '@shared/units'
import type { WidgetInstance, WidgetLayoutPreset } from '@shared/types'
import { GPS_STYLE_PRESETS, SPEEDOMETER_STYLE_PRESETS, TIMER_STYLE_PRESETS, type StylePreset } from '@shared/widgets/presets'
import { DEFAULT_GPS_STYLE, type GpsWidgetStyle } from '@shared/render/drawGpsWidget'
import { DEFAULT_SPEEDOMETER_STYLE } from '@shared/render/drawSpeedometer'
import { DEFAULT_TIMER_STYLE, type TimerStyle } from '@shared/render/drawTimer'
import { DEFAULT_SECTOR_TIMER_STYLE } from '@shared/render/drawSectorTimer'
import { DEFAULT_DELTA_TIME_STYLE } from '@shared/render/drawDeltaTime'
import { DEFAULT_PREDICTIVE_LAP_TIMER_STYLE } from '@shared/render/drawPredictiveLapTimer'
import { DEFAULT_APEX_SPEED_CALLOUT_STYLE } from '@shared/render/drawApexSpeedCallout'
import { DEFAULT_SPEED_DISTANCE_GRAPH_STYLE, type SpeedDistanceGraphStyle } from '@shared/render/drawSpeedDistanceGraph'
import { DEFAULT_GFORCE_DIAGRAM_STYLE } from '@shared/render/drawGForceDiagram'
import { DEFAULT_ROLL_ANGLE_STYLE } from '@shared/render/drawRollAngle'
import { DEFAULT_SESSION_SUMMARY_STYLE } from '@shared/render/drawSessionSummary'
import { DEFAULT_LAP_CONSISTENCY_STYLE } from '@shared/render/drawLapConsistency'
import { DEFAULT_CUSTOM_TEXT_STYLE } from '@shared/render/drawCustomText'
import { DEFAULT_ELEVATION_STYLE } from '@shared/render/drawElevation'
import { DEFAULT_DISTANCE_STYLE } from '@shared/render/drawDistance'
import { DEFAULT_COMPASS_STYLE } from '@shared/render/drawCompass'
import { DEFAULT_ACCEL_TIMER_STYLE } from '@shared/render/drawAccelTimer'
import { FORMULA1_BOLD, FORMULA1_FONT_ID, FORMULA1_REGULAR } from '@shared/render/fonts'
import { applyThemeToWidget, LAYOUT_THEMES, type LayoutTheme } from '@shared/widgets/themes'
import { detectLapCrossings, nearestLatLon } from '@shared/telemetry/laps'
import { alignedX, alignedY, type HorizontalAlign, type VerticalAlign } from '@shared/widgets/alignment'
import { useWidgetStore } from '../store/widgetStore'
import { useProjectStore } from '../store/projectStore'
import { useAlignmentStore } from '../store/alignmentStore'
import { useFontStore } from '../store/fontStore'

const MAX_TIMING_TOWER_ROWS = 20

/** Reads a user-picked image file entirely in the renderer (FileReader), no main-process IPC
 *  needed -- the resulting data URL is stored directly in the widget's style JSON so the project
 *  file stays fully self-contained (no external file path to keep valid across machines/moves). */
function readImageFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function widgetLabel(type: WidgetInstance['type']): string {
  switch (type) {
    case 'gpsTrack':
      return 'GPS Track'
    case 'speedometerAnalog':
      return 'Speedometer (analog)'
    case 'speedometerDigital':
      return 'Speedometer (digital)'
    case 'timer':
      return 'Timer'
    case 'sectorTimer':
      return 'Sector Timer'
    case 'deltaTime':
      return 'Delta Time'
    case 'predictiveLapTimer':
      return 'Predictive Lap Timer'
    case 'apexSpeedCallout':
      return 'Apex Speed Callout'
    case 'speedDistanceGraph':
      return 'Speed/Distance Graph'
    case 'gForceDiagram':
      return 'G-Force Diagram'
    case 'rollAngle':
      return 'Roll/Lean Angle'
    case 'sessionSummary':
      return 'Session Summary'
    case 'lapConsistency':
      return 'Lap Consistency'
    case 'customText':
      return 'Custom Text/Logo'
    case 'elevation':
      return 'Elevation'
    case 'distance':
      return 'Distance'
    case 'compass':
      return 'Compass/Heading'
    case 'accelTimer':
      return 'Acceleration Timer'
  }
}

const AXIS_LABELS = ['Axis 1', 'Axis 2', 'Axis 3'] as const

function AxisOverrideFields({
  vertical,
  lateralOrLongitudinal,
  lateralOrLongitudinalLabel,
  verticalInverted,
  lateralOrLongitudinalInverted,
  onChangeVertical,
  onChangeLateralOrLongitudinal,
  onChangeVerticalInverted,
  onChangeLateralOrLongitudinalInverted
}: {
  vertical: 0 | 1 | 2
  lateralOrLongitudinal: 0 | 1 | 2
  lateralOrLongitudinalLabel: string
  verticalInverted: boolean
  lateralOrLongitudinalInverted: boolean
  onChangeVertical: (axis: 0 | 1 | 2) => void
  onChangeLateralOrLongitudinal: (axis: 0 | 1 | 2) => void
  onChangeVerticalInverted: (inverted: boolean) => void
  onChangeLateralOrLongitudinalInverted: (inverted: boolean) => void
}): React.JSX.Element {
  return (
    <>
      <label className="field">
        <span>Vertical axis</span>
        <select value={vertical} onChange={(e) => onChangeVertical(Number(e.target.value) as 0 | 1 | 2)}>
          {AXIS_LABELS.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="field field--checkbox">
        <input type="checkbox" checked={verticalInverted} onChange={(e) => onChangeVerticalInverted(e.target.checked)} />
        <span>Invert vertical</span>
      </label>
      <label className="field">
        <span>{lateralOrLongitudinalLabel} axis</span>
        <select value={lateralOrLongitudinal} onChange={(e) => onChangeLateralOrLongitudinal(Number(e.target.value) as 0 | 1 | 2)}>
          {AXIS_LABELS.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={lateralOrLongitudinalInverted}
          onChange={(e) => onChangeLateralOrLongitudinalInverted(e.target.checked)}
        />
        <span>Invert {lateralOrLongitudinalLabel.toLowerCase()}</span>
      </label>
    </>
  )
}

function PresetRow<T>({ presets, onPick }: { presets: StylePreset<T>[]; onPick: (style: Partial<T>) => void }): React.JSX.Element {
  return (
    <div className="preset-row">
      {presets.map((preset) => (
        <button
          key={preset.name}
          className="preset-swatch"
          style={{ background: preset.swatch }}
          title={preset.name}
          onClick={() => onPick(preset.style)}
        />
      ))}
    </div>
  )
}

function PropertyPanel(): React.JSX.Element {
  const widgets = useWidgetStore((s) => s.widgets)
  const selectedId = useWidgetStore((s) => s.selectedId)
  const selectedIds = useWidgetStore((s) => s.selectedIds)
  const selectWidget = useWidgetStore((s) => s.selectWidget)
  const updateWidget = useWidgetStore((s) => s.updateWidget)
  const removeWidget = useWidgetStore((s) => s.removeWidget)
  const removeWidgets = useWidgetStore((s) => s.removeWidgets)
  const addWidget = useWidgetStore((s) => s.addWidget)
  const applyWidgets = useWidgetStore((s) => s.applyWidgets)
  const imported = useProjectStore((s) => s.imported)
  const currentTimeMs = useProjectStore((s) => s.currentTimeMs)
  const startFinish = useProjectStore((s) => s.startFinish)
  const setStartFinish = useProjectStore((s) => s.setStartFinish)
  const startFinishRadiusM = useProjectStore((s) => s.startFinishRadiusM)
  const setStartFinishRadiusM = useProjectStore((s) => s.setStartFinishRadiusM)
  const crossingAdjustmentsMs = useProjectStore((s) => s.crossingAdjustmentsMs)
  const ignoredCrossings = useProjectStore((s) => s.ignoredCrossings)
  const isExporting = useProjectStore((s) => s.isExporting)
  const paddingFraction = useAlignmentStore((s) => s.paddingFraction)
  const setPaddingFraction = useAlignmentStore((s) => s.setPaddingFraction)
  const snapEnabled = useAlignmentStore((s) => s.snapEnabled)
  const setSnapEnabled = useAlignmentStore((s) => s.setSnapEnabled)
  const systemFonts = useFontStore((s) => s.systemFonts)

  const selected = widgets.find((w) => w.id === selectedId) ?? null

  // "Widgets" holds whole-project/global tools (start/finish, add/arrange, layouts, color themes);
  // "Style" holds anything scoped to the current selection (alignment tools, the selected widget's
  // own style fields) -- previously all of this was one long flat scroll, so reaching a selected
  // widget's own controls meant scrolling past every global section first. Auto-switches to "Style"
  // the instant the SELECTED WIDGET CHANGES (including from none to one), but a manual click back to
  // "Widgets" (e.g. to add another widget) isn't overridden until the next actual selection change.
  const [activeTab, setActiveTab] = useState<'widgets' | 'style'>('widgets')
  useEffect(() => {
    if (selectedId) setActiveTab('style')
  }, [selectedId])

  // Live feedback for the GPS Track "ghost" marker -- it depends on two silent preconditions (a
  // start/finish line, and at least one lap actually completed by the current scrub position)
  // that have no visual effect of their own when unmet, which reads as "the feature doesn't work"
  // rather than "not available yet." Recomputes lap crossings the same way WidgetLayer.tsx does for
  // the real ghost/deltaTime logic, just for this one status line.
  const ghostStatus = useMemo((): 'no-start-finish' | 'no-completed-lap' | 'active' | null => {
    if (!selected || selected.type !== 'gpsTrack' || !selected.style.showGhost) return null
    if (!startFinish) return 'no-start-finish'
    if (!imported) return 'no-completed-lap'
    const crossings = detectLapCrossings(imported.telemetry.samples, startFinish, startFinishRadiusM, undefined, crossingAdjustmentsMs, ignoredCrossings)
    const hasCompletedLap = crossings.some((c, i) => i > 0 && c <= currentTimeMs)
    return hasCompletedLap ? 'active' : 'no-completed-lap'
  }, [selected, startFinish, startFinishRadiusM, imported, currentTimeMs, crossingAdjustmentsMs, ignoredCrossings])

  const [layoutPresets, setLayoutPresets] = useState<WidgetLayoutPreset[]>([])
  useEffect(() => {
    window.api.listLayoutPresets().then(setLayoutPresets)
  }, [])

  // Electron's renderer does not support window.prompt() (it throws "prompt() is not supported."),
  // so naming a new layout uses an inline text field instead of a native prompt dialog.
  const [isSavingLayout, setIsSavingLayout] = useState(false)
  const [newLayoutName, setNewLayoutName] = useState('')

  function startSaveLayout(): void {
    setNewLayoutName('')
    setIsSavingLayout(true)
  }

  function confirmSaveLayout(): void {
    const name = newLayoutName.trim()
    if (!name) return
    window.api.saveLayoutPreset(name, widgets).then(setLayoutPresets)
    setIsSavingLayout(false)
  }

  function cancelSaveLayout(): void {
    setIsSavingLayout(false)
  }

  function applyLayout(preset: WidgetLayoutPreset): void {
    applyWidgets(preset.widgets)
  }

  // Recolors every currently-placed widget in one undoable step -- unlike a layout preset (which
  // only saves position/size), this only touches color fields, leaving placement untouched.
  function applyTheme(theme: LayoutTheme): void {
    applyWidgets(widgets.map((w) => applyThemeToWidget(w, theme)))
  }

  function deleteLayout(id: string): void {
    window.api.deleteLayoutPreset(id).then(setLayoutPresets)
  }

  // Align/center apply to the WHOLE current selection when more than one widget is selected, each
  // widget aligned independently against the frame (not against each other) -- selectedIds always
  // includes selected.id when non-empty, so this covers both the single- and multi-select case.
  const targetWidgets = selectedIds.length > 0 ? widgets.filter((w) => selectedIds.includes(w.id)) : selected ? [selected] : []

  function alignHorizontal(align: HorizontalAlign): void {
    for (const w of targetWidgets) updateWidget(w.id, { x: alignedX(w.w, align, paddingFraction) })
  }

  function alignVertical(align: VerticalAlign): void {
    for (const w of targetWidgets) updateWidget(w.id, { y: alignedY(w.h, align, paddingFraction) })
  }

  function centerBoth(): void {
    for (const w of targetWidgets) {
      updateWidget(w.id, {
        x: alignedX(w.w, 'centerH', paddingFraction),
        y: alignedY(w.h, 'centerV', paddingFraction)
      })
    }
  }

  const allTargetsLocked = targetWidgets.length > 0 && targetWidgets.every((w) => w.locked)

  function toggleLocked(): void {
    const nextLocked = !allTargetsLocked
    for (const w of targetWidgets) updateWidget(w.id, { locked: nextLocked })
  }

  function setGlobalStartFinishHere(): void {
    const latLon = imported ? nearestLatLon(imported.telemetry.samples, currentTimeMs) : null
    if (latLon) setStartFinish(latLon)
  }

  return (
    <aside className="property-panel">
      <div className="property-panel__tabs">
        <button
          className={`property-panel__tab${activeTab === 'widgets' ? ' property-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('widgets')}
        >
          Widgets
        </button>
        <button
          className={`property-panel__tab${activeTab === 'style' ? ' property-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('style')}
        >
          Style
        </button>
      </div>

      {isExporting && <div className="property-panel__export-lock">Locked during export</div>}

      <div className={`property-panel__content${isExporting ? ' property-panel__content--locked' : ''}`} inert={isExporting}>

      {activeTab === 'widgets' && (
        <>
      <div className="property-panel__section">
        <div className="property-panel__header">
          <span>Start/finish line</span>
        </div>
        <div className="property-panel__add-row">
          <button
            className="property-panel__add"
            onClick={setGlobalStartFinishHere}
            disabled={!imported}
            title="Scrub the video to the exact frame where you cross the line, then click this"
          >
            Set at current position
          </button>
          {startFinish && (
            <button className="property-panel__delete" onClick={() => setStartFinish(null)}>
              Clear
            </button>
          )}
        </div>
        <span className="field__hint">
          {startFinish
            ? `Set at ${startFinish.lat.toFixed(5)}, ${startFinish.lon.toFixed(5)}`
            : 'Not set — used by any Timer (lap mode) or Sector Timer widget. Scrub to the lap line, then click "Set at current position".'}
        </span>
        {startFinish && (
          <>
            <label className="field">
              <span>Detection radius ({startFinishRadiusM}m)</span>
              <input
                type="range"
                min={3}
                max={40}
                step={1}
                value={startFinishRadiusM}
                onChange={(e) => setStartFinishRadiusM(Number(e.target.value))}
              />
            </label>
            <span className="field__hint">
              How close the car/kart must pass to count as crossing the line. Lower this if a lap is
              detected somewhere the track loops back near the line, but isn't the actual line -- use
              the timeline's lap markers to spot and delete a false one if it still slips through.
            </span>
          </>
        )}
      </div>

      <div className="property-panel__section">
        <div className="property-panel__header">
          <span>Widgets</span>
        </div>
        <div className="property-panel__add-row">
          <button className="property-panel__add" onClick={() => addWidget('gpsTrack')}>
            + GPS Track
          </button>
          <button className="property-panel__add" onClick={() => addWidget('speedometerAnalog')}>
            + Speedo (analog)
          </button>
          <button className="property-panel__add" onClick={() => addWidget('speedometerDigital')}>
            + Speedo (digital)
          </button>
          <button className="property-panel__add" onClick={() => addWidget('timer')}>
            + Timer
          </button>
          <button className="property-panel__add" onClick={() => addWidget('sectorTimer')}>
            + Sector Timer
          </button>
          <button className="property-panel__add" onClick={() => addWidget('deltaTime')}>
            + Delta Time
          </button>
          <button className="property-panel__add" onClick={() => addWidget('predictiveLapTimer')}>
            + Predictive Lap Timer
          </button>
          <button className="property-panel__add" onClick={() => addWidget('apexSpeedCallout')}>
            + Apex Speed Callout
          </button>
          <button className="property-panel__add" onClick={() => addWidget('speedDistanceGraph')}>
            + Speed/Distance Graph
          </button>
          <button className="property-panel__add" onClick={() => addWidget('gForceDiagram')}>
            + G-Force Diagram
          </button>
          <button className="property-panel__add" onClick={() => addWidget('rollAngle')}>
            + Roll/Lean Angle
          </button>
          <button className="property-panel__add" onClick={() => addWidget('sessionSummary')}>
            + Session Summary
          </button>
          <button className="property-panel__add" onClick={() => addWidget('lapConsistency')}>
            + Lap Consistency
          </button>
          <button className="property-panel__add" onClick={() => addWidget('customText')}>
            + Custom Text/Logo
          </button>
          <button className="property-panel__add" onClick={() => addWidget('elevation')}>
            + Elevation
          </button>
          <button className="property-panel__add" onClick={() => addWidget('distance')}>
            + Distance
          </button>
          <button className="property-panel__add" onClick={() => addWidget('compass')}>
            + Compass/Heading
          </button>
          <button className="property-panel__add" onClick={() => addWidget('accelTimer')}>
            + Acceleration Timer
          </button>
        </div>
        <ul className="widget-list">
          {widgets.length === 0 && <li className="widget-list__empty">No widgets yet</li>}
          {widgets.map((w) => (
            <li
              key={w.id}
              className={`widget-list__item${selectedIds.includes(w.id) ? ' widget-list__item--active' : ''}`}
              title="Click to select, shift-click to add/remove from selection"
              onClick={(e) => selectWidget(w.id, e.shiftKey)}
            >
              {w.locked && (
                <span className="widget-list__lock-icon" title="Locked">
                  🔒
                </span>
              )}
              {widgetLabel(w.type)}
            </li>
          ))}
        </ul>
      </div>

      <div className="property-panel__section">
        <div className="property-panel__header">
          <span>Layouts</span>
        </div>
        <div className="property-panel__add-row">
          {isSavingLayout ? (
            <>
              <input
                type="text"
                className="layout-save-input"
                autoFocus
                placeholder="Layout name"
                value={newLayoutName}
                onChange={(e) => setNewLayoutName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmSaveLayout()
                  else if (e.key === 'Escape') cancelSaveLayout()
                }}
              />
              <button className="property-panel__add" onClick={confirmSaveLayout} disabled={!newLayoutName.trim()}>
                Save
              </button>
              <button className="property-panel__delete" onClick={cancelSaveLayout}>
                Cancel
              </button>
            </>
          ) : (
            <button className="property-panel__add" onClick={startSaveLayout} disabled={widgets.length === 0}>
              Save current layout…
            </button>
          )}
        </div>
        <ul className="widget-list">
          {layoutPresets.length === 0 && <li className="widget-list__empty">No saved layouts yet</li>}
          {layoutPresets.map((preset) => (
            <li key={preset.id} className="widget-list__item layout-preset-row">
              <span className="layout-preset-row__name" title={preset.name}>
                {preset.name}
              </span>
              <div className="layout-preset-row__actions">
                <button className="property-panel__add" onClick={() => applyLayout(preset)} title="Load this saved layout">
                  Load
                </button>
                <button
                  className="property-panel__delete"
                  onClick={() => deleteLayout(preset.id)}
                  title="Delete this saved layout"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="property-panel__section">
        <div className="property-panel__header">
          <span>Color themes</span>
        </div>
        <span className="field__hint">Recolor every widget in one click -- position/size untouched.</span>
        <div className="preset-row">
          {LAYOUT_THEMES.map((theme) => (
            <button
              key={theme.name}
              className="preset-swatch theme-swatch"
              style={{ background: theme.backgroundColor, border: `2px solid ${theme.accent}` }}
              onClick={() => applyTheme(theme)}
              disabled={widgets.length === 0}
              title={`Apply the ${theme.name} theme to every widget`}
            >
              <span className="theme-swatch__dot" style={{ background: theme.accent }} />
            </button>
          ))}
        </div>
      </div>
        </>
      )}

      {activeTab === 'style' && (
        <>
      {!selected && (
        <div className="property-panel__section">
          <span className="field__hint">Select a widget (on the canvas, or from the Widgets tab's list) to edit its style.</span>
        </div>
      )}

      {selected && (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Alignment{selectedIds.length > 1 ? ` (${selectedIds.length} selected)` : ''}</span>
            {selectedIds.length > 1 && (
              <button
                className="property-panel__delete"
                title="Delete all selected widgets"
                onClick={() => removeWidgets(selectedIds)}
              >
                Delete all
              </button>
            )}
          </div>
          {selectedIds.length > 1 && (
            <span className="field__hint">
              Shift-click widgets (in the list above or on the video) to add/remove them. Dragging, aligning, deleting, or
              nudging with the arrow keys applies to the whole selection.
            </span>
          )}

          <div className="property-panel__add-row">
            <button className="property-panel__add" title="Align left" onClick={() => alignHorizontal('left')}>
              Left
            </button>
            <button className="property-panel__add" title="Center horizontally" onClick={() => alignHorizontal('centerH')}>
              Center
            </button>
            <button className="property-panel__add" title="Align right" onClick={() => alignHorizontal('right')}>
              Right
            </button>
          </div>
          <div className="property-panel__add-row">
            <button className="property-panel__add" title="Align top" onClick={() => alignVertical('top')}>
              Top
            </button>
            <button className="property-panel__add" title="Center vertically" onClick={() => alignVertical('centerV')}>
              Middle
            </button>
            <button className="property-panel__add" title="Align bottom" onClick={() => alignVertical('bottom')}>
              Bottom
            </button>
          </div>
          <div className="property-panel__add-row">
            <button className="property-panel__add" title="Center both horizontally and vertically" onClick={centerBoth}>
              Center both
            </button>
          </div>

          <label className="field">
            <span>Padding ({(paddingFraction * 100).toFixed(1)}%)</span>
            <input
              type="range"
              min={0}
              max={0.1}
              step={0.005}
              value={paddingFraction}
              onChange={(e) => setPaddingFraction(Number(e.target.value))}
            />
          </label>
          <span className="field__hint">Used by the buttons above and by live snapping while dragging, so both match exactly.</span>

          <label className="field field--checkbox">
            <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
            <span>Snap to center/edges while dragging</span>
          </label>

          <label className="field field--checkbox">
            <input type="checkbox" checked={allTargetsLocked} onChange={toggleLocked} />
            <span>Lock position/size{selectedIds.length > 1 ? ' (all selected)' : ''}</span>
          </label>
          <span className="field__hint">
            A locked widget can't be dragged or resized on the canvas (and is skipped by group drag/nudge) --
            still editable here in the property panel.
          </span>
        </div>
      )}

      {selected && (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Font</span>
          </div>
          <label className="field">
            <span>Font family{selectedIds.length > 1 ? ' (all selected)' : ''}</span>
            <select
              value={selected.fontFamily ?? ''}
              onChange={(e) => {
                const value = e.target.value || null
                for (const w of targetWidgets) updateWidget(w.id, { fontFamily: value })
              }}
            >
              <option value="">Inherit from global</option>
              <option value={FORMULA1_FONT_ID}>Formula1 — Auto</option>
              <option value={FORMULA1_BOLD}>Formula1 Bold</option>
              <option value={FORMULA1_REGULAR}>Formula1 Regular</option>
              {systemFonts.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>
          <span className="field__hint">
            Overrides the project-wide default font (Project Settings, in the File menu) for just this widget
            {selectedIds.length > 1 ? ' selection' : ''}. "Formula1 — Auto" mixes Bold/Regular the way this widget
            always has; "Formula1 Bold"/"Formula1 Regular" use that one weight for everything in it.
          </span>
        </div>
      )}

      {selected && selected.type === 'gpsTrack' && (() => {
        // Defensive merge: guards against incomplete style data (e.g. an older/foreign project
        // file) crashing this panel instead of just rendering with sane fallbacks.
        const style = { ...DEFAULT_GPS_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>GPS Track style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <PresetRow
            presets={GPS_STYLE_PRESETS}
            onPick={(patch) => updateWidget(selected.id, { style: { ...style, ...patch } })}
          />

          <label className="field">
            <span>Line color</span>
            <input
              type="color"
              value={style.lineColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, lineColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Line width ({style.lineWidth}px)</span>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={style.lineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, lineWidth: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Line opacity ({style.lineOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={style.lineOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, lineOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Dot color</span>
            <input
              type="color"
              value={style.dotColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, dotColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Dot radius ({style.dotRadius}px)</span>
            <input
              type="range"
              min={2}
              max={20}
              step={1}
              value={style.dotRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, dotRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.dotGlow}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, dotGlow: e.target.checked } })}
            />
            <span>Dot glow</span>
          </label>

          <label className="field">
            <span>Track coloring</span>
            <select
              value={style.colorMode}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, colorMode: e.target.value as GpsWidgetStyle['colorMode'] } })}
            >
              <option value="solid">Solid color</option>
              <option value="speed">By speed</option>
              <option value="braking">By braking/accelerating</option>
            </select>
          </label>

          {style.colorMode === 'speed' && (
            <>
              <label className="field">
                <span>Slow color</span>
                <input
                  type="color"
                  value={style.slowColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, slowColor: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Fast color</span>
                <input
                  type="color"
                  value={style.fastColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, fastColor: e.target.value } })}
                />
              </label>
              <span className="field__hint">Scaled to this session's own min/max speed.</span>
            </>
          )}

          {style.colorMode === 'braking' && (
            <>
              <label className="field">
                <span>Braking color</span>
                <input
                  type="color"
                  value={style.brakingColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, brakingColor: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Accelerating color</span>
                <input
                  type="color"
                  value={style.acceleratingColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, acceleratingColor: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Neutral color</span>
                <input
                  type="color"
                  value={style.neutralColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, neutralColor: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Sensitivity ({style.brakingThresholdMps2.toFixed(1)} m/s²)</span>
                <input
                  type="range"
                  min={0.2}
                  max={5}
                  step={0.1}
                  value={style.brakingThresholdMps2}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, brakingThresholdMps2: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showGhost}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showGhost: e.target.checked } })}
            />
            <span>Show ghost (best lap's position)</span>
          </label>
          {style.showGhost && (
            <>
              <label className="field">
                <span>Ghost color</span>
                <input
                  type="color"
                  value={style.ghostColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, ghostColor: e.target.value } })}
                />
              </label>
              <span className="field__hint">
                A second marker at your fastest completed lap's own position at this same elapsed time into its
                lap -- shows ahead/behind spatially on the track, not just as a number.
              </span>
              {ghostStatus === 'no-start-finish' && (
                <span className="field__hint field__hint--warning">
                  ⚠ Not shown yet -- set a start/finish line first (see the Start/finish line section at the top).
                </span>
              )}
              {ghostStatus === 'no-completed-lap' && (
                <span className="field__hint field__hint--warning">
                  ⚠ Not shown yet at the current scrub position -- it appears once your fastest completed lap
                  exists to compare against, i.e. partway through lap 2 or later.
                </span>
              )}
              {ghostStatus === 'active' && (
                <span className="field__hint field__hint--ok">✓ Showing, comparing against your fastest completed lap so far.</span>
              )}
            </>
          )}

          <label className="field">
            <span>View mode</span>
            <select
              value={style.viewMode}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, viewMode: e.target.value as GpsWidgetStyle['viewMode'] } })}
            >
              <option value="full">Full track</option>
              <option value="window">Zoomed window (follows current position)</option>
            </select>
          </label>
          {style.viewMode === 'window' && (
            <>
              <label className="field">
                <span>Window radius ({style.windowRadiusM}m)</span>
                <input
                  type="range"
                  min={5}
                  max={200}
                  step={5}
                  value={style.windowRadiusM}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, windowRadiusM: Number(e.target.value) } })}
                />
              </label>
              <span className="field__hint">
                Keeps the current position centered and zoomed in, so a close gap to the ghost marker is
                actually visible instead of a fraction of a pixel on the full track.
              </span>
            </>
          )}

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.trimAware}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, trimAware: e.target.checked } })}
            />
            <span>Crop map to trimmed range</span>
          </label>
          {style.trimAware && (
            <span className="field__hint">
              Only draws the track shape between your trim start/end points, instead of the whole recording --
              use this to exclude a bad-GPS stretch (e.g. parked under cover, sitting on the grid) by trimming
              it out of the video first.
            </span>
          )}

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showApexMarkers}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showApexMarkers: e.target.checked } })}
            />
            <span>Show apex markers</span>
          </label>
          {style.showApexMarkers && (
            <>
              <label className="field">
                <span>Marker color</span>
                <input
                  type="color"
                  value={style.apexMarkerColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, apexMarkerColor: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Sensitivity (min speed drop {style.apexMinDropMps.toFixed(1)} m/s)</span>
                <input
                  type="range"
                  min={2}
                  max={20}
                  step={0.5}
                  value={style.apexMinDropMps}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, apexMinDropMps: Number(e.target.value) } })}
                />
              </label>
              <label className="field">
                <span>Minimum gap between apexes ({(style.apexMinGapMs / 1000).toFixed(1)}s)</span>
                <input
                  type="range"
                  min={500}
                  max={5000}
                  step={100}
                  value={style.apexMinGapMs}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, apexMinGapMs: Number(e.target.value) } })}
                />
              </label>
              <span className="field__hint">
                Plots a marker at each detected corner apex directly on the track -- independent of the Apex
                Speed Callout widget's own detection settings, if you're also using that.
              </span>
            </>
          )}

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && (selected.type === 'speedometerAnalog' || selected.type === 'speedometerDigital') && (() => {
        const style = { ...DEFAULT_SPEEDOMETER_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>{widgetLabel(selected.type)} style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <PresetRow
            presets={SPEEDOMETER_STYLE_PRESETS}
            onPick={(patch) => updateWidget(selected.id, { style: { ...style, ...patch } })}
          />

          <label className="field">
            <span>Unit</span>
            <select
              value={style.unit}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, unit: e.target.value as SpeedUnit } })}
            >
              <option value="kmh">km/h</option>
              <option value="mph">mph</option>
              <option value="kn">knots</option>
            </select>
          </label>

          <label className="field">
            <span>Smoothing ({style.smoothingMs}ms)</span>
            <input
              type="range"
              min={60}
              max={1500}
              step={20}
              value={style.smoothingMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, smoothingMs: Number(e.target.value) } })}
            />
          </label>

          {selected.type === 'speedometerAnalog' && (
            <>
              <label className="field">
                <span>Gauge min</span>
                <input
                  type="number"
                  value={style.min}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, min: Number(e.target.value) } })}
                />
              </label>
              <label className="field">
                <span>Gauge max</span>
                <input
                  type="number"
                  value={style.max}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, max: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          <label className="field">
            <span>Text color</span>
            <input
              type="color"
              value={style.color}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Accent color</span>
            <input
              type="color"
              value={style.accentColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, accentColor: e.target.value } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showUnit}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showUnit: e.target.checked } })}
            />
            <span>Show unit label</span>
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {selected.type === 'speedometerDigital' && (
            <>
              <label className="field">
                <span>Background color</span>
                <input
                  type="color"
                  value={style.backgroundColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={style.backgroundOpacity}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
                />
              </label>
              <label className="field">
                <span>Corner radius ({style.cornerRadius}px)</span>
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={style.cornerRadius}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'timer' && (() => {
        const style = { ...DEFAULT_TIMER_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Timer style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <PresetRow
            presets={TIMER_STYLE_PRESETS}
            onPick={(patch) => updateWidget(selected.id, { style: { ...style, ...patch } })}
          />

          <label className="field">
            <span>Mode</span>
            <select
              value={style.mode}
              onChange={(e) => {
                const mode = e.target.value as TimerStyle['mode']
                // Laps mode shows a history list and needs much more vertical room than the
                // default elapsed-mode size -- bump it up automatically the first time, but only
                // if the user hasn't already resized it themselves.
                const needsMoreRoom = mode === 'laps' && selected.h <= 0.12
                updateWidget(selected.id, {
                  style: { ...style, mode },
                  ...(needsMoreRoom ? { h: 0.4, w: 0.24 } : {})
                })
              }}
            >
              <option value="elapsed">Elapsed (from video start)</option>
              <option value="laps">Lap timer</option>
            </select>
          </label>

          {style.mode === 'elapsed' && (
            <>
              <label className="field">
                <span>Label</span>
                <input
                  type="text"
                  value={style.label}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })}
                />
              </label>

              <label className="field">
                <span>Label color</span>
                <input
                  type="color"
                  value={style.labelColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })}
                />
              </label>
            </>
          )}

          {style.mode === 'laps' && (
            <>
              <label className="field">
                <span>Header logo</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const dataUrl = await readImageFileAsDataUrl(file)
                    updateWidget(selected.id, { style: { ...style, headerImageDataUrl: dataUrl } })
                    e.target.value = ''
                  }}
                />
              </label>
              {style.headerImageDataUrl && (
                <>
                  <button
                    className="property-panel__delete"
                    onClick={() => updateWidget(selected.id, { style: { ...style, headerImageDataUrl: null } })}
                  >
                    Remove logo
                  </button>

                  <label className="field">
                    <span>Logo scale ({style.headerImageScale.toFixed(2)}x)</span>
                    <input
                      type="range"
                      min={0.3}
                      max={5}
                      step={0.05}
                      value={style.headerImageScale}
                      onChange={(e) => updateWidget(selected.id, { style: { ...style, headerImageScale: Number(e.target.value) } })}
                    />
                  </label>
                </>
              )}

              <label className="field">
                <span>Header text</span>
                <input
                  type="text"
                  value={style.headerText}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, headerText: e.target.value } })}
                />
              </label>

              <label className="field">
                <span>Header text color</span>
                <input
                  type="color"
                  value={style.headerTextColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, headerTextColor: e.target.value } })}
                />
              </label>

              <label className="field">
                <span>Row order</span>
                <select
                  value={style.rowOrder}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, rowOrder: e.target.value as TimerStyle['rowOrder'] } })}
                >
                  <option value="ranked">Ranked (fastest first)</option>
                  <option value="chronological">Chronological (lap order)</option>
                </select>
              </label>

              {style.rowOrder === 'chronological' && (
                <label className="field">
                  <span>New laps added to</span>
                  <select
                    value={style.chronoDirection}
                    onChange={(e) =>
                      updateWidget(selected.id, { style: { ...style, chronoDirection: e.target.value as TimerStyle['chronoDirection'] } })
                    }
                  >
                    <option value="newestOnTop">Top</option>
                    <option value="newestOnBottom">Bottom</option>
                  </select>
                </label>
              )}

              <label className="field">
                <span>Visible rows ({style.maxVisibleRows})</span>
                <input
                  type="range"
                  min={1}
                  max={MAX_TIMING_TOWER_ROWS}
                  step={1}
                  value={style.maxVisibleRows}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, maxVisibleRows: Number(e.target.value) } })}
                />
              </label>

              <label className="field">
                <span>Background color</span>
                <input
                  type="color"
                  value={style.backgroundColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
                />
              </label>

              <label className="field">
                <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={style.backgroundOpacity}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
                />
              </label>

              <label className="field">
                <span>Corner radius ({style.cornerRadius}px)</span>
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={style.cornerRadius}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          <label className="field">
            <span>Time color</span>
            <input
              type="color"
              value={style.color}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showCentiseconds}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showCentiseconds: e.target.checked } })}
            />
            <span>Show centiseconds</span>
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'sectorTimer' && (() => {
        const style = { ...DEFAULT_SECTOR_TIMER_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Sector Timer style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Uses the global start/finish line above. The lap is auto-split into 3 equal-distance sectors from GPS.
          </span>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showLastLapRow}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showLastLapRow: e.target.checked } })}
            />
            <span>Show last lap's sectors</span>
          </label>

          <label className="field">
            <span>Time color</span>
            <input
              type="color"
              value={style.color}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Label color</span>
            <input
              type="color"
              value={style.labelColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'deltaTime' && (() => {
        const style = { ...DEFAULT_DELTA_TIME_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Delta Time style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Uses the global start/finish line above. Compares the live lap against your best completed lap so far.
          </span>

          <label className="field">
            <span>Label</span>
            <input
              type="text"
              value={style.label}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Label color</span>
            <input
              type="color"
              value={style.labelColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Faster (ahead) color</span>
            <input
              type="color"
              value={style.fasterColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, fasterColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Slower (behind) color</span>
            <input
              type="color"
              value={style.slowerColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, slowerColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Neutral color (no baseline yet)</span>
            <input
              type="color"
              value={style.neutralColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, neutralColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'predictiveLapTimer' && (() => {
        const style = { ...DEFAULT_PREDICTIVE_LAP_TIMER_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Predictive Lap Timer style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Uses the global start/finish line above. Projects the final lap time from the current pace vs. your best completed lap.
          </span>

          <label className="field">
            <span>Label</span>
            <input
              type="text"
              value={style.label}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Label color</span>
            <input
              type="color"
              value={style.labelColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Time color</span>
            <input
              type="color"
              value={style.color}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showDelta}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showDelta: e.target.checked } })}
            />
            <span>Show delta sub-readout</span>
          </label>

          {style.showDelta && (
            <>
              <label className="field">
                <span>Faster (ahead) color</span>
                <input
                  type="color"
                  value={style.fasterColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, fasterColor: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Slower (behind) color</span>
                <input
                  type="color"
                  value={style.slowerColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, slowerColor: e.target.value } })}
                />
              </label>
            </>
          )}

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'apexSpeedCallout' && (() => {
        const style = { ...DEFAULT_APEX_SPEED_CALLOUT_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Apex Speed Callout style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Independent of the start/finish line. Flashes the minimum speed reached each time heavy braking is immediately followed by acceleration.
          </span>

          <label className="field">
            <span>Unit</span>
            <select
              value={style.unit}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, unit: e.target.value as SpeedUnit } })}
            >
              <option value="kmh">km/h</option>
              <option value="mph">mph</option>
              <option value="kn">knots</option>
            </select>
          </label>

          <label className="field">
            <span>Label</span>
            <input
              type="text"
              value={style.label}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Text color</span>
            <input
              type="color"
              value={style.color}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Flash duration ({(style.flashDurationMs / 1000).toFixed(1)}s)</span>
            <input
              type="range"
              min={1000}
              max={6000}
              step={250}
              value={style.flashDurationMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, flashDurationMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Sensitivity ({style.minDropMps.toFixed(1)} m/s drop)</span>
            <input
              type="range"
              min={2}
              max={20}
              step={0.5}
              value={style.minDropMps}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, minDropMps: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Minimum gap between apexes ({(style.minGapMs / 1000).toFixed(1)}s)</span>
            <input
              type="range"
              min={500}
              max={5000}
              step={250}
              value={style.minGapMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, minGapMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'speedDistanceGraph' && (() => {
        const style = { ...DEFAULT_SPEED_DISTANCE_GRAPH_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Speed/Distance Graph style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Uses the global start/finish line above. Speed vs. distance-into-the-lap, resetting at the start of every lap.
          </span>

          <label className="field">
            <span>View mode</span>
            <select
              value={style.viewMode}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, viewMode: e.target.value as SpeedDistanceGraphStyle['viewMode'] } })}
            >
              <option value="fullLap">Full lap (each lap its own color)</option>
              <option value="window">Local window (only current lap colored)</option>
            </select>
          </label>

          {style.viewMode === 'window' && (
            <>
              <span className="field__hint">
                Centers on your current position and shows a band of track around it -- only the current lap is colored, so you can see at a glance whether you're faster or slower than previous laps right here.
              </span>

              <label className="field">
                <span>Window size (±{style.windowMeters}m)</span>
                <input
                  type="range"
                  min={10}
                  max={300}
                  step={10}
                  value={style.windowMeters}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, windowMeters: Number(e.target.value) } })}
                />
              </label>

              <label className="field">
                <span>Reference lap color</span>
                <input
                  type="color"
                  value={style.referenceLapColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, referenceLapColor: e.target.value } })}
                />
              </label>

              <label className="field">
                <span>Reference lap opacity ({style.referenceLapOpacity.toFixed(2)})</span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={style.referenceLapOpacity}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, referenceLapOpacity: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          <label className="field">
            <span>Unit</span>
            <select
              value={style.unit}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, unit: e.target.value as SpeedUnit } })}
            >
              <option value="kmh">km/h</option>
              <option value="mph">mph</option>
              <option value="kn">knots</option>
            </select>
          </label>

          <label className="field">
            <span>Laps shown ({style.maxLapsShown})</span>
            <input
              type="range"
              min={1}
              max={15}
              step={1}
              value={style.maxLapsShown}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, maxLapsShown: Number(e.target.value) } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showCurrentLap}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showCurrentLap: e.target.checked } })}
            />
            <span>Show current (in-progress) lap live</span>
          </label>

          {style.showCurrentLap && (
            <label className="field field--checkbox">
              <input
                type="checkbox"
                checked={style.highlightCurrentLap}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, highlightCurrentLap: e.target.checked } })}
              />
              <span>Highlight current lap (thicker line)</span>
            </label>
          )}

          <label className="field">
            <span>Line width ({style.lineWidth.toFixed(1)}px)</span>
            <input
              type="range"
              min={1}
              max={6}
              step={0.5}
              value={style.lineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, lineWidth: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Color palette ({style.colorSeed}°)</span>
            <input
              type="range"
              min={0}
              max={359}
              step={1}
              value={style.colorSeed}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, colorSeed: Number(e.target.value) } })}
            />
          </label>
          <span className="field__hint">Each lap gets its own stable color automatically -- this shifts the whole palette if the defaults clash with your footage.</span>

          <label className="field">
            <span>Grid color</span>
            <input
              type="color"
              value={style.gridColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, gridColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Axis label color</span>
            <input
              type="color"
              value={style.axisLabelColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, axisLabelColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'gForceDiagram' && (() => {
        const style = { ...DEFAULT_GFORCE_DIAGRAM_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>G-Force Diagram style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Lateral G (cornering) vs. longitudinal G (braking/accelerating), from the GoPro's own accelerometer. Axis mapping
            is auto-calibrated per session -- turn on manual mapping below if it looks wrong (e.g. too little braking in the
            footage to calibrate against).
          </span>

          <label className="field">
            <span>Max G (grid radius)</span>
            <input
              type="range"
              min={0.5}
              max={4}
              step={0.1}
              value={style.maxG}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, maxG: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Trail duration ({(style.trailDurationMs / 1000).toFixed(1)}s)</span>
            <input
              type="range"
              min={0}
              max={8000}
              step={250}
              value={style.trailDurationMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, trailDurationMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Smoothing ({style.smoothingMs}ms)</span>
            <input
              type="range"
              min={0}
              max={500}
              step={10}
              value={style.smoothingMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, smoothingMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Dot color</span>
            <input type="color" value={style.dotColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, dotColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Dot radius ({style.dotRadius}px)</span>
            <input
              type="range"
              min={2}
              max={16}
              step={1}
              value={style.dotRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, dotRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Trail color</span>
            <input type="color" value={style.trailColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, trailColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Ring color</span>
            <input type="color" value={style.ringColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, ringColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Ring opacity ({style.ringOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.ringOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, ringOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Axis label color</span>
            <input
              type="color"
              value={style.axisLabelColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, axisLabelColor: e.target.value } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showAxisLabels}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showAxisLabels: e.target.checked } })}
            />
            <span>Show ACCEL/BRAKE/LEFT/RIGHT labels</span>
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showValueReadout}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showValueReadout: e.target.checked } })}
            />
            <span>Show numeric G readout</span>
          </label>

          <label className="field">
            <span>Readout color</span>
            <input
              type="color"
              value={style.valueColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, valueColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.useManualAxes}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, useManualAxes: e.target.checked } })}
            />
            <span>Use manual axis mapping</span>
          </label>

          {style.useManualAxes && (
            <AxisOverrideFields
              vertical={style.verticalAxis}
              lateralOrLongitudinal={style.longitudinalAxis}
              lateralOrLongitudinalLabel="Longitudinal"
              verticalInverted={style.verticalInverted}
              lateralOrLongitudinalInverted={style.longitudinalInverted}
              onChangeVertical={(axis) => updateWidget(selected.id, { style: { ...style, verticalAxis: axis } })}
              onChangeLateralOrLongitudinal={(axis) => updateWidget(selected.id, { style: { ...style, longitudinalAxis: axis } })}
              onChangeVerticalInverted={(inverted) => updateWidget(selected.id, { style: { ...style, verticalInverted: inverted } })}
              onChangeLateralOrLongitudinalInverted={(inverted) => updateWidget(selected.id, { style: { ...style, longitudinalInverted: inverted } })}
            />
          )}

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'rollAngle' && (() => {
        const style = { ...DEFAULT_ROLL_ANGLE_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Roll/Lean Angle style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Body roll (car) / lean angle (motorcycle) from the gravity-vector sensor when your camera/firmware records one,
            otherwise estimated from the raw accelerometer's own tilt (reads exaggerated during hard cornering -- a real
            limitation of accelerometer-only tilt sensing, not a bug).
          </span>

          <label className="field">
            <span>Label</span>
            <input type="text" value={style.label} onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })} />
          </label>

          <label className="field">
            <span>Label color</span>
            <input type="color" value={style.labelColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Text color</span>
            <input type="color" value={style.color} onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })} />
          </label>

          <label className="field">
            <span>Bar color</span>
            <input type="color" value={style.barColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, barColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Bar scale (±{style.maxAngleScale}°)</span>
            <input
              type="range"
              min={10}
              max={90}
              step={5}
              value={style.maxAngleScale}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, maxAngleScale: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Smoothing ({style.smoothingMs}ms)</span>
            <input
              type="range"
              min={0}
              max={500}
              step={10}
              value={style.smoothingMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, smoothingMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showAccuracyCaveat}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showAccuracyCaveat: e.target.checked } })}
            />
            <span>Show accuracy note when estimated (no gravity sensor)</span>
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.useManualAxes}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, useManualAxes: e.target.checked } })}
            />
            <span>Use manual axis mapping</span>
          </label>

          {style.useManualAxes && (
            <AxisOverrideFields
              vertical={style.verticalAxis}
              lateralOrLongitudinal={style.lateralAxis}
              lateralOrLongitudinalLabel="Lateral"
              verticalInverted={style.verticalInverted}
              lateralOrLongitudinalInverted={style.lateralInverted}
              onChangeVertical={(axis) => updateWidget(selected.id, { style: { ...style, verticalAxis: axis } })}
              onChangeLateralOrLongitudinal={(axis) => updateWidget(selected.id, { style: { ...style, lateralAxis: axis } })}
              onChangeVerticalInverted={(inverted) => updateWidget(selected.id, { style: { ...style, verticalInverted: inverted } })}
              onChangeLateralOrLongitudinalInverted={(inverted) => updateWidget(selected.id, { style: { ...style, lateralInverted: inverted } })}
            />
          )}

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'sessionSummary' && (() => {
        const style = { ...DEFAULT_SESSION_SUMMARY_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Session Summary style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            An end-of-session recap card -- only visible in the final stretch of the (trimmed) video, fading + sliding
            into place. Best lap, best sectors, total laps, top/average speed, distance, and duration, all resolved as
            of wherever it's showing.
          </span>

          <label className="field">
            <span>Title</span>
            <input type="text" value={style.title} onChange={(e) => updateWidget(selected.id, { style: { ...style, title: e.target.value } })} />
          </label>

          <label className="field">
            <span>Show in last ({style.showLastSeconds}s)</span>
            <input
              type="range"
              min={2}
              max={30}
              step={1}
              value={style.showLastSeconds}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showLastSeconds: Number(e.target.value) } })}
            />
          </label>
          <span className="field__hint">Counts back from the end of your trim, not the source file's own end.</span>

          <label className="field">
            <span>Opening animation ({style.animationDurationMs}ms)</span>
            <input
              type="range"
              min={0}
              max={2000}
              step={50}
              value={style.animationDurationMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, animationDurationMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Speed unit</span>
            <select value={style.unit} onChange={(e) => updateWidget(selected.id, { style: { ...style, unit: e.target.value as SpeedUnit } })}>
              <option value="kmh">km/h</option>
              <option value="mph">mph</option>
              <option value="kn">knots</option>
            </select>
          </label>

          <label className="field">
            <span>Text color</span>
            <input type="color" value={style.color} onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })} />
          </label>

          <label className="field">
            <span>Label color</span>
            <input type="color" value={style.labelColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Accent color (title)</span>
            <input type="color" value={style.accentColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, accentColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'lapConsistency' && (() => {
        const style = { ...DEFAULT_LAP_CONSISTENCY_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Lap Consistency style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            A bar per recently-completed lap -- taller bar means a relatively faster lap (scaled between
            the shown laps' own fastest/slowest, not from zero), fastest lap highlighted in its own color.
          </span>

          <label className="field">
            <span>Title</span>
            <input type="text" value={style.title} onChange={(e) => updateWidget(selected.id, { style: { ...style, title: e.target.value } })} />
          </label>

          <label className="field">
            <span>Laps shown ({style.maxLapsShown})</span>
            <input
              type="range"
              min={3}
              max={20}
              step={1}
              value={style.maxLapsShown}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, maxLapsShown: Number(e.target.value) } })}
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showLapTimes}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showLapTimes: e.target.checked } })}
            />
            <span>Show lap times above bars</span>
          </label>

          <label className="field">
            <span>Bar color</span>
            <input type="color" value={style.barColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, barColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Fastest lap color</span>
            <input
              type="color"
              value={style.bestLapColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, bestLapColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Label color</span>
            <input type="color" value={style.labelColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'customText' && (() => {
        const style = { ...DEFAULT_CUSTOM_TEXT_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Custom Text/Logo style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Freeform text and/or an uploaded image -- a driver name, event title, or sponsor watermark,
            not derived from telemetry. Image sits above the text when both are set.
          </span>

          <label className="field">
            <span>Text (multiple lines supported)</span>
            <textarea
              rows={3}
              value={style.text}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, text: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Text align</span>
            <select
              value={style.textAlign}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textAlign: e.target.value as 'left' | 'center' | 'right' } })}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>

          <label className="field">
            <span>Text color</span>
            <input type="color" value={style.textColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, textColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Image</span>
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const dataUrl = await readImageFileAsDataUrl(file)
                updateWidget(selected.id, { style: { ...style, imageDataUrl: dataUrl } })
                e.target.value = ''
              }}
            />
          </label>
          {style.imageDataUrl && (
            <>
              <button className="property-panel__delete" onClick={() => updateWidget(selected.id, { style: { ...style, imageDataUrl: null } })}>
                Remove image
              </button>

              <label className="field">
                <span>Image scale ({style.imageScale.toFixed(2)}x)</span>
                <input
                  type="range"
                  min={0.3}
                  max={5}
                  step={0.05}
                  value={style.imageScale}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, imageScale: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'elevation' && (() => {
        const style = { ...DEFAULT_ELEVATION_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Elevation style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Current altitude and/or a distance-based elevation profile for the whole session, from the GoPro's own GPS
            altitude reading. Most useful for hillclimbs/rally -- a flat closed circuit will understandably look close
            to a flat line.
          </span>

          <label className="field">
            <span>Mode</span>
            <select
              value={style.mode}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, mode: e.target.value as 'readout' | 'graph' | 'both' } })}
            >
              <option value="both">Readout + graph</option>
              <option value="readout">Readout only</option>
              <option value="graph">Graph only</option>
            </select>
          </label>

          <label className="field">
            <span>Unit</span>
            <select value={style.unit} onChange={(e) => updateWidget(selected.id, { style: { ...style, unit: e.target.value as 'kmh' | 'mph' | 'kn' } })}>
              <option value="kmh">Meters</option>
              <option value="mph">Feet</option>
            </select>
          </label>

          {style.mode !== 'graph' && (
            <>
              <label className="field">
                <span>Label</span>
                <input type="text" value={style.label} onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })} />
              </label>

              <label className="field">
                <span>Label color</span>
                <input type="color" value={style.labelColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })} />
              </label>

              <label className="field">
                <span>Value color</span>
                <input type="color" value={style.color} onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })} />
              </label>

              <label className="field">
                <span>Smoothing ({style.smoothingMs}ms)</span>
                <input
                  type="range"
                  min={0}
                  max={2000}
                  step={50}
                  value={style.smoothingMs}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, smoothingMs: Number(e.target.value) } })}
                />
              </label>

              <label className="field">
                <span>Text outline ({style.textOutlineWidth}px)</span>
                <input
                  type="range"
                  min={0}
                  max={6}
                  step={1}
                  value={style.textOutlineWidth}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
                />
              </label>

              {style.textOutlineWidth > 0 && (
                <label className="field">
                  <span>Outline color</span>
                  <input
                    type="color"
                    value={style.textOutlineColor}
                    onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
                  />
                </label>
              )}
            </>
          )}

          {style.mode !== 'readout' && (
            <>
              <label className="field">
                <span>Graph line color</span>
                <input
                  type="color"
                  value={style.graphLineColor}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, graphLineColor: e.target.value } })}
                />
              </label>

              <label className="field">
                <span>Graph fill opacity ({style.graphFillOpacity.toFixed(2)})</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={style.graphFillOpacity}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, graphFillOpacity: Number(e.target.value) } })}
                />
              </label>

              <label className="field">
                <span>Grid color</span>
                <input type="color" value={style.gridColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, gridColor: e.target.value } })} />
              </label>

              <label className="field">
                <span>Grid opacity ({style.gridOpacity.toFixed(2)})</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={style.gridOpacity}
                  onChange={(e) => updateWidget(selected.id, { style: { ...style, gridOpacity: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'distance' && (() => {
        const style = { ...DEFAULT_DISTANCE_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Distance style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">Live total distance covered since the start of the recording.</span>

          <label className="field">
            <span>Unit</span>
            <select value={style.unit} onChange={(e) => updateWidget(selected.id, { style: { ...style, unit: e.target.value as SpeedUnit } })}>
              <option value="kmh">Kilometers</option>
              <option value="mph">Miles</option>
            </select>
          </label>

          <label className="field">
            <span>Label</span>
            <input type="text" value={style.label} onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })} />
          </label>

          <label className="field">
            <span>Label color</span>
            <input type="color" value={style.labelColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Value color</span>
            <input type="color" value={style.color} onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })} />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'compass' && (() => {
        const style = { ...DEFAULT_COMPASS_STYLE, ...selected.style }
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Compass/Heading style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Direction of travel from GPS course-over-ground -- GoPro cameras have no magnetometer, so this reads the
            way you're moving, not which way the camera physically faces, and is meaningless while stationary.
          </span>

          <label className="field">
            <span>Label</span>
            <input type="text" value={style.label} onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })} />
          </label>

          <label className="field">
            <span>Label color</span>
            <input type="color" value={style.labelColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Value color</span>
            <input type="color" value={style.color} onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })} />
          </label>

          <label className="field">
            <span>Smoothing ({style.smoothingMs}ms)</span>
            <input
              type="range"
              min={0}
              max={2000}
              step={50}
              value={style.smoothingMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, smoothingMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}

      {selected && selected.type === 'accelTimer' && (() => {
        const style = { ...DEFAULT_ACCEL_TIMER_STYLE, ...selected.style }
        const unitLabel = speedUnitLabel(style.unit)
        return (
        <div className="property-panel__section">
          <div className="property-panel__header">
            <span>Acceleration Timer style</span>
            <button className="property-panel__delete" onClick={() => removeWidget(selected.id)}>
              Delete
            </button>
          </div>

          <span className="field__hint">
            Dragy-style launch timer: auto-detects a genuine stop followed by acceleration, then times how long it
            takes to reach each target speed below, plus keeps a session-best per target.
          </span>

          <label className="field">
            <span>Unit</span>
            <select value={style.unit} onChange={(e) => updateWidget(selected.id, { style: { ...style, unit: e.target.value as SpeedUnit } })}>
              <option value="kmh">km/h</option>
              <option value="mph">mph</option>
              <option value="kn">knots</option>
            </select>
          </label>

          <div className="field">
            <span>Target speeds ({unitLabel})</span>
            {style.targetSpeedsMps.map((targetMps, i) => (
              <div key={i} className="field__row">
                <input
                  type="number"
                  min={1}
                  value={Math.round(convertSpeed(targetMps, style.unit))}
                  onChange={(e) => {
                    const next = [...style.targetSpeedsMps]
                    next[i] = convertToMps(Number(e.target.value), style.unit)
                    updateWidget(selected.id, { style: { ...style, targetSpeedsMps: next } })
                  }}
                />
                <button
                  className="property-panel__delete"
                  onClick={() => {
                    const next = style.targetSpeedsMps.filter((_, idx) => idx !== i)
                    updateWidget(selected.id, { style: { ...style, targetSpeedsMps: next } })
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className="property-panel__add"
              onClick={() => {
                const last = style.targetSpeedsMps[style.targetSpeedsMps.length - 1] ?? convertToMps(40, style.unit)
                updateWidget(selected.id, { style: { ...style, targetSpeedsMps: [...style.targetSpeedsMps, last + convertToMps(20, style.unit)] } })
              }}
            >
              + Add target speed
            </button>
          </div>

          <label className="field">
            <span>Stationary threshold ({Math.round(convertSpeed(style.stationaryThresholdMps, style.unit))} {unitLabel})</span>
            <input
              type="range"
              min={1}
              max={Math.round(convertSpeed(5, style.unit))}
              step={1}
              value={Math.round(convertSpeed(style.stationaryThresholdMps, style.unit))}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, stationaryThresholdMps: convertToMps(Number(e.target.value), style.unit) } })}
            />
            <span className="field__hint">
              At or under this speed counts as "stopped" -- raise it if a slow corner on your track is close enough
              to a stop to falsely trigger a launch, lower it if GPS noise at a real standstill reads above it.
            </span>
          </label>

          <label className="field">
            <span>Min stop duration ({style.minStationaryMs}ms)</span>
            <input
              type="range"
              min={100}
              max={3000}
              step={100}
              value={style.minStationaryMs}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, minStationaryMs: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Label</span>
            <input type="text" value={style.label} onChange={(e) => updateWidget(selected.id, { style: { ...style, label: e.target.value } })} />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={style.showBest}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, showBest: e.target.checked } })}
            />
            <span>Show session-best (PB) alongside current run</span>
          </label>

          <label className="field">
            <span>Label color</span>
            <input type="color" value={style.labelColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, labelColor: e.target.value } })} />
          </label>

          <label className="field">
            <span>Value color</span>
            <input type="color" value={style.color} onChange={(e) => updateWidget(selected.id, { style: { ...style, color: e.target.value } })} />
          </label>

          {style.showBest && (
            <label className="field">
              <span>Best (PB) color</span>
              <input type="color" value={style.bestColor} onChange={(e) => updateWidget(selected.id, { style: { ...style, bestColor: e.target.value } })} />
            </label>
          )}

          <label className="field">
            <span>Text outline ({style.textOutlineWidth}px)</span>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={style.textOutlineWidth}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineWidth: Number(e.target.value) } })}
            />
          </label>

          {style.textOutlineWidth > 0 && (
            <label className="field">
              <span>Outline color</span>
              <input
                type="color"
                value={style.textOutlineColor}
                onChange={(e) => updateWidget(selected.id, { style: { ...style, textOutlineColor: e.target.value } })}
              />
            </label>
          )}

          <label className="field">
            <span>Background color</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundColor: e.target.value } })}
            />
          </label>

          <label className="field">
            <span>Background opacity ({style.backgroundOpacity.toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, backgroundOpacity: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Corner radius ({style.cornerRadius}px)</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={style.cornerRadius}
              onChange={(e) => updateWidget(selected.id, { style: { ...style, cornerRadius: Number(e.target.value) } })}
            />
          </label>

          <label className="field">
            <span>Rotation ({selected.rotation}°)</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={selected.rotation}
              onChange={(e) => updateWidget(selected.id, { rotation: Number(e.target.value) })}
            />
          </label>
        </div>
        )
      })()}
        </>
      )}
      </div>
    </aside>
  )
}

export default PropertyPanel
