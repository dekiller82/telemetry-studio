import { CSSProperties, useMemo, useState } from 'react'
import type { TelemetrySampler } from '@shared/telemetry/sampleAt'
import { detectLapCrossings, getLapStateAt } from '@shared/telemetry/laps'
import { computeLapSectors, getSectorStateAt } from '@shared/telemetry/sectors'
import { computeLapDistanceCurves, getDeltaStateAt } from '@shared/telemetry/deltaTime'
import { computeCurrentLapSpeedTrace, computeLapSpeedTraces } from '@shared/telemetry/speedTrace'
import type { SessionSummaryData } from '@shared/render/drawSessionSummary'
import WidgetBox, { type ActiveGuides } from './WidgetBox'
import { useWidgetStore } from '../store/widgetStore'
import { useProjectStore } from '../store/projectStore'

interface Props {
  style: CSSProperties
  frameWidth: number
  frameHeight: number
  sampler: TelemetrySampler | null
  currentTimeMs: number
}

function WidgetLayer({ style, frameWidth, frameHeight, sampler, currentTimeMs }: Props): React.JSX.Element | null {
  const widgets = useWidgetStore((s) => s.widgets)
  const selectWidget = useWidgetStore((s) => s.selectWidget)
  const startFinish = useProjectStore((s) => s.startFinish)
  const startFinishRadiusM = useProjectStore((s) => s.startFinishRadiusM)
  const crossingAdjustmentsMs = useProjectStore((s) => s.crossingAdjustmentsMs)
  const ignoredCrossings = useProjectStore((s) => s.ignoredCrossings)
  const trimStartMs = useProjectStore((s) => s.trimStartMs)
  const trimEndMs = useProjectStore((s) => s.trimEndMs)
  const defaultFontFamily = useProjectStore((s) => s.defaultFontFamily)
  const isExporting = useProjectStore((s) => s.isExporting)
  // Only one widget can be dragged at a time, so a single shared slot (rather than per-widget state)
  // is enough -- whichever WidgetBox is actively being dragged reports into it. Guide lines span the
  // whole frame, so they're rendered here rather than inside the dragging widget's own box.
  const [activeGuides, setActiveGuides] = useState<ActiveGuides | null>(null)
  // Live delta of a group drag in progress -- the anchor WidgetBox (the one actually under the
  // pointer) reports its own delta here so every other selected WidgetBox can preview the same
  // delta applied to its own position while dragging, without each of them needing to know about
  // each other directly.
  const [groupDrag, setGroupDrag] = useState<{ anchorId: string; dxPx: number; dyPx: number } | null>(null)

  // One shared start/finish line for every widget that needs lap/sector detection -- computed
  // once here rather than duplicated per widget instance. Crossings/boundaries only depend on the
  // telemetry + chosen point, not on currentTimeMs, so this doesn't redo the O(n) scan every frame.
  const crossings = useMemo(
    () =>
      sampler && startFinish
        ? detectLapCrossings(sampler.samples, startFinish, startFinishRadiusM, undefined, crossingAdjustmentsMs, ignoredCrossings)
        : null,
    [sampler, startFinish, startFinishRadiusM, crossingAdjustmentsMs, ignoredCrossings]
  )
  const sectorBoundaries = useMemo(
    () => (sampler && crossings ? computeLapSectors(sampler.samples, crossings) : null),
    [sampler, crossings]
  )
  const lapState = useMemo(() => (crossings ? getLapStateAt(crossings, currentTimeMs) : null), [crossings, currentTimeMs])
  const sectorState = useMemo(
    () => (sectorBoundaries ? getSectorStateAt(sectorBoundaries, currentTimeMs) : null),
    [sectorBoundaries, currentTimeMs]
  )
  const lapDistanceCurves = useMemo(
    () => (sampler && crossings ? computeLapDistanceCurves(sampler.samples, crossings) : null),
    [sampler, crossings]
  )
  const deltaState = useMemo(
    () => (sampler && crossings && lapDistanceCurves ? getDeltaStateAt(lapDistanceCurves, crossings, sampler.samples, currentTimeMs) : null),
    [sampler, crossings, lapDistanceCurves, currentTimeMs]
  )
  // GPS Track's optional "ghost" marker (style.showGhost) -- shared across every gpsTrack widget
  // instance same as deltaState itself, computed once here rather than per-widget.
  const ghostPosition = useMemo(
    () => (sampler && deltaState?.ghostCts != null ? sampler.positionAt(deltaState.ghostCts) : null),
    [sampler, deltaState]
  )
  // The full per-lap trace list only depends on telemetry + crossings, not on currentTimeMs, so it's
  // precomputed once here (same reasoning as sectorBoundaries/lapDistanceCurves above). But it must
  // still be filtered down to laps actually completed BY currentTimeMs before it reaches the widget
  // -- otherwise scrubbing early in the video would show every lap in the whole session at once,
  // same "never leak a future lap in while scrubbing" discipline as getLapStateAt/getSectorStateAt.
  const allLapSpeedTraces = useMemo(
    () => (sampler && crossings ? computeLapSpeedTraces(sampler.samples, crossings) : []),
    [sampler, crossings]
  )
  const lapSpeedTraces = useMemo(
    () => (crossings ? allLapSpeedTraces.filter((t) => crossings[t.lapNumber] <= currentTimeMs) : []),
    [allLapSpeedTraces, crossings, currentTimeMs]
  )
  const currentLapSpeedTrace = useMemo(
    () => (sampler && crossings ? computeCurrentLapSpeedTrace(sampler.samples, crossings, currentTimeMs) : null),
    [sampler, crossings, currentTimeMs]
  )
  // Session Summary is an outro RECAP, not a live readout -- unlike lapState/sectorState above (used
  // by Timer/SectorTimer/etc, which do need to reflect wherever the video is currently scrubbed to),
  // its data is resolved against the (trimmed) session's true final totals so the numbers hold still
  // through the whole reveal window instead of visibly climbing as the video plays through its own
  // last few seconds. Only depends on trimStartMs/trimEndMs/crossings/sectorBoundaries, so this is
  // effectively a session-level constant, not something recomputed on every playback frame.
  const finalLapState = useMemo(() => (crossings ? getLapStateAt(crossings, trimEndMs) : null), [crossings, trimEndMs])
  const finalSectorState = useMemo(
    () => (sectorBoundaries ? getSectorStateAt(sectorBoundaries, trimEndMs) : null),
    [sectorBoundaries, trimEndMs]
  )
  const sessionSummaryData: SessionSummaryData | null = useMemo(() => {
    if (!sampler) return null
    const stats = sampler.sessionStatsAt(trimStartMs, trimEndMs)
    return {
      totalLaps: finalLapState?.history.length ?? 0,
      bestLapMs: finalLapState?.bestLapMs ?? null,
      bestS1Ms: finalSectorState?.bestS1Ms ?? null,
      bestS2Ms: finalSectorState?.bestS2Ms ?? null,
      bestS3Ms: finalSectorState?.bestS3Ms ?? null,
      topSpeedMps: stats.maxSpeedMps,
      totalDistanceM: stats.totalDistanceM,
      elapsedMs: Math.max(0, trimEndMs - trimStartMs)
    }
  }, [sampler, finalLapState, finalSectorState, trimEndMs, trimStartMs])

  if (!sampler || frameWidth <= 0 || frameHeight <= 0) return null

  return (
    <div
      className={`widget-layer${isExporting ? ' widget-layer--locked' : ''}`}
      style={style}
      // `inert` fully blocks pointer AND keyboard interaction with every widget underneath -- the
      // export pipeline already works from a one-time snapshot of `widgets` copied over IPC when
      // Export was clicked, so this doesn't change what gets exported, it just avoids the "did that
      // just affect my export?" ambiguity of being able to freely drag widgets around while one runs.
      inert={isExporting}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) selectWidget(null)
      }}
    >
      {widgets.map((widget) => (
        <WidgetBox
          key={widget.id}
          widget={widget}
          allWidgets={widgets}
          frameWidth={frameWidth}
          frameHeight={frameHeight}
          sampler={sampler}
          currentTimeMs={currentTimeMs}
          lapState={lapState}
          sectorState={sectorState}
          deltaState={deltaState}
          ghostPosition={ghostPosition}
          sessionSummaryData={sessionSummaryData}
          trimStartMs={trimStartMs}
          sessionEndMs={trimEndMs}
          lapSpeedTraces={lapSpeedTraces}
          currentLapSpeedTrace={currentLapSpeedTrace}
          defaultFontFamily={defaultFontFamily}
          onGuidesChange={setActiveGuides}
          groupDrag={groupDrag}
          onGroupDragChange={setGroupDrag}
        />
      ))}
      {activeGuides?.xPx != null && <div className="alignment-guide alignment-guide--vertical" style={{ left: activeGuides.xPx }} />}
      {activeGuides?.yPx != null && <div className="alignment-guide alignment-guide--horizontal" style={{ top: activeGuides.yPx }} />}
    </div>
  )
}

export default WidgetLayer
