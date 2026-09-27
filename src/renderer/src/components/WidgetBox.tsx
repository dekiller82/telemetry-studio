import { useMemo, useRef, useState } from 'react'
import { Rnd, type RndDragCallback, type RndResizeCallback } from 'react-rnd'
import type { WidgetInstance } from '@shared/types'
import type { TelemetrySampler } from '@shared/telemetry/sampleAt'
import type { LapState } from '@shared/telemetry/laps'
import type { SectorState } from '@shared/telemetry/sectors'
import type { DeltaState } from '@shared/telemetry/deltaTime'
import type { ProjectedPoint } from '@shared/telemetry/interpolate'
import type { LapSpeedTrace } from '@shared/telemetry/speedTrace'
import type { SessionSummaryData } from '@shared/render/drawSessionSummary'
import { computeSnap } from '@shared/widgets/alignment'
import WidgetCanvas from './WidgetCanvas'
import { useWidgetStore } from '../store/widgetStore'
import { useAlignmentStore } from '../store/alignmentStore'

export interface ActiveGuides {
  xPx: number | null
  yPx: number | null
}

interface Props {
  widget: WidgetInstance
  /** Every widget in the layout (including this one) -- used to derive extra snap targets from
   *  sibling widgets' own edges/centers, on top of the frame-based ones. */
  allWidgets: WidgetInstance[]
  frameWidth: number
  frameHeight: number
  sampler: TelemetrySampler
  currentTimeMs: number
  lapState: LapState | null
  sectorState: SectorState | null
  deltaState: DeltaState | null
  ghostPosition: ProjectedPoint | null
  sessionSummaryData: SessionSummaryData | null
  trimStartMs: number
  sessionEndMs: number
  lapSpeedTraces: LapSpeedTrace[]
  currentLapSpeedTrace: LapSpeedTrace | null
  defaultFontFamily: string
  /** Reports which guide lines (if any) should be drawn while this widget is being dragged -- lifted
   *  up to WidgetLayer since guide lines span the whole frame, not just this one widget's box. */
  onGuidesChange: (guides: ActiveGuides | null) => void
  /** The live delta (in pixels) of whichever widget is currently the "anchor" of a group drag, plus
   *  which widget that is -- lifted up to WidgetLayer since every OTHER selected widget needs to
   *  preview the same delta applied to its own position while the anchor is being dragged. */
  groupDrag: { anchorId: string; dxPx: number; dyPx: number } | null
  onGroupDragChange: (drag: { anchorId: string; dxPx: number; dyPx: number } | null) => void
}

function WidgetBox({
  widget,
  allWidgets,
  frameWidth,
  frameHeight,
  sampler,
  currentTimeMs,
  lapState,
  sectorState,
  deltaState,
  ghostPosition,
  sessionSummaryData,
  trimStartMs,
  sessionEndMs,
  lapSpeedTraces,
  currentLapSpeedTrace,
  defaultFontFamily,
  onGuidesChange,
  groupDrag,
  onGroupDragChange
}: Props): React.JSX.Element {
  const selectedId = useWidgetStore((s) => s.selectedId)
  const selectedIds = useWidgetStore((s) => s.selectedIds)
  const selectWidget = useWidgetStore((s) => s.selectWidget)
  const updateWidget = useWidgetStore((s) => s.updateWidget)
  const moveWidgetsBy = useWidgetStore((s) => s.moveWidgetsBy)
  const bringToFront = useWidgetStore((s) => s.bringToFront)
  const paddingFraction = useAlignmentStore((s) => s.paddingFraction)
  const snapEnabled = useAlignmentStore((s) => s.snapEnabled)

  const isPrimarySelection = selectedId === widget.id
  const isSelected = selectedIds.includes(widget.id)
  const isGroupMember = isSelected && selectedIds.length > 1
  const pixelW = widget.w * frameWidth
  const pixelH = widget.h * frameHeight
  const pixelX = widget.x * frameWidth
  const pixelY = widget.y * frameHeight

  // Snap targets are every widget NOT currently part of the active selection -- a group member
  // being dragged alongside the anchor moves too, so its own edges aren't a meaningful thing to
  // snap against (unlike a genuinely stationary sibling widget).
  const otherRects = useMemo(
    () =>
      allWidgets
        .filter((w) => !selectedIds.includes(w.id))
        .map((w) => ({ x: w.x * frameWidth, y: w.y * frameHeight, w: w.w * frameWidth, h: w.h * frameHeight })),
    [allWidgets, selectedIds, frameWidth, frameHeight]
  )

  // Local override during an active drag -- react-rnd is used as a controlled component (via
  // `position`) so snapping can visually override the pointer's raw position without writing to the
  // store on every mousemove. Cleared (falls back to the store's own pixelX/pixelY) once the drag ends.
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number } | null>(null)
  // Distinguishes a plain click (select just this widget, collapsing any existing multi-selection)
  // from a click-and-drag on an already-selected group member (which should move the whole group,
  // not collapse it first) -- the collapse decision is deferred to mouseup once we know which case
  // this was, rather than guessed eagerly on mousedown.
  const wasDraggedRef = useRef(false)

  const handleMouseDown = (e: React.MouseEvent): void => {
    wasDraggedRef.current = false
    bringToFront(widget.id)
    if (e.shiftKey) {
      selectWidget(widget.id, true)
    } else if (!isSelected) {
      selectWidget(widget.id, false)
    }
  }

  const handleMouseUp = (e: React.MouseEvent): void => {
    if (!e.shiftKey && !wasDraggedRef.current && isGroupMember) {
      selectWidget(widget.id, false)
    }
  }

  const handleDrag: RndDragCallback = (_e, d) => {
    wasDraggedRef.current = true
    let preview: { x: number; y: number }
    if (!snapEnabled) {
      preview = { x: d.x, y: d.y }
    } else {
      const snap = computeSnap(d.x, d.y, pixelW, pixelH, frameWidth, frameHeight, paddingFraction, undefined, otherRects)
      preview = { x: snap.x, y: snap.y }
      onGuidesChange({ xPx: snap.guideXPx, yPx: snap.guideYPx })
    }
    setDragPreview(preview)
    if (isGroupMember) {
      onGroupDragChange({ anchorId: widget.id, dxPx: preview.x - pixelX, dyPx: preview.y - pixelY })
    }
  }

  const handleDragStop: RndDragCallback = (_e, d) => {
    const snap = snapEnabled
      ? computeSnap(d.x, d.y, pixelW, pixelH, frameWidth, frameHeight, paddingFraction, undefined, otherRects)
      : { x: d.x, y: d.y }
    if (isGroupMember) {
      const dxFrac = (snap.x - pixelX) / frameWidth
      const dyFrac = (snap.y - pixelY) / frameHeight
      const otherIds = selectedIds.filter((id) => id !== widget.id)
      moveWidgetsBy(otherIds, dxFrac, dyFrac)
      onGroupDragChange(null)
    }
    updateWidget(widget.id, { x: snap.x / frameWidth, y: snap.y / frameHeight })
    setDragPreview(null)
    onGuidesChange(null)
  }

  const handleResizeStop: RndResizeCallback = (_e, _direction, ref, _delta, position) => {
    updateWidget(widget.id, {
      w: ref.offsetWidth / frameWidth,
      h: ref.offsetHeight / frameHeight,
      x: position.x / frameWidth,
      y: position.y / frameHeight
    })
  }

  // Resizing always targets just this one widget, even if it's part of a larger multi-selection --
  // collapses the selection down to it, same as a plain (non-shift) click would.
  const handleResizeStart = (): void => {
    selectWidget(widget.id, false)
    bringToFront(widget.id)
  }

  const position =
    dragPreview ??
    (!widget.locked && isGroupMember && groupDrag && groupDrag.anchorId !== widget.id
      ? { x: pixelX + groupDrag.dxPx, y: pixelY + groupDrag.dyPx }
      : { x: pixelX, y: pixelY })

  return (
    <Rnd
      size={{ width: pixelW, height: pixelH }}
      position={position}
      // No bounds constraint -- widgets (e.g. a GPS map made deliberately larger than the frame so
      // it reads more clearly, then tucked into a corner) need to be draggable/resizable partly or
      // mostly off-frame. The video-stage's own edges no longer apply here; .widget-layer clips the
      // actual visible rendering to the frame's exact bounds (see global.css), same as export
      // (Canvas2D naturally clips anything drawn outside the canvas's own pixel bounds).
      style={{ zIndex: widget.zIndex }}
      className={`widget-box${isSelected ? ' widget-box--selected' : ''}${isPrimarySelection ? ' widget-box--primary' : ''}${widget.locked ? ' widget-box--locked' : ''}`}
      disableDragging={widget.locked}
      enableResizing={!widget.locked}
      // NOT onDragStart -- react-draggable calls onStart from its own onMouseDown, i.e. on every
      // plain click (before any actual movement), not just real drags. wasDraggedRef is instead set
      // from handleDrag, which only fires once the pointer has actually moved.
      onDrag={handleDrag}
      onDragStop={handleDragStop}
      onResizeStart={handleResizeStart}
      onResizeStop={handleResizeStop}
    >
      <div className="widget-box__inner" onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
        <WidgetCanvas
          widget={widget}
          sampler={sampler}
          currentTimeMs={currentTimeMs}
          pixelWidth={pixelW}
          pixelHeight={pixelH}
          lapState={lapState}
          sectorState={sectorState}
          deltaState={deltaState}
          ghostPosition={ghostPosition}
          sessionSummaryData={sessionSummaryData}
          trimStartMs={trimStartMs}
          sessionEndMs={sessionEndMs}
          lapSpeedTraces={lapSpeedTraces}
          currentLapSpeedTrace={currentLapSpeedTrace}
          defaultFontFamily={defaultFontFamily}
        />
      </div>
    </Rnd>
  )
}

export default WidgetBox
