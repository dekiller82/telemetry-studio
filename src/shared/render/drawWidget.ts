import type { ProjectedPoint } from '../telemetry/interpolate'
import type { TrackBounds } from '../telemetry/sampleAt'
import type { LapState } from '../telemetry/laps'
import type { SectorState } from '../telemetry/sectors'
import type { DeltaState } from '../telemetry/deltaTime'
import type { ApexEvent } from '../telemetry/apex'
import type { LapSpeedTrace } from '../telemetry/speedTrace'
import type { ElevationProfilePoint, GForceHistoryPoint, GForceReading, RollAngleReading } from '../telemetry/sampleAt'
import type { AccelRunState } from '../telemetry/accelRuns'
import { FORMULA1_FONT_ID } from './fonts'
import type { WidgetInstance } from '../types'
import type { Canvas2DLike, CanvasImageLike, Rect } from './canvas2d'
import { drawGpsWidget } from './drawGpsWidget'
import { drawSpeedometerAnalog, drawSpeedometerDigital } from './drawSpeedometer'
import { drawTimer } from './drawTimer'
import { drawSectorTimer } from './drawSectorTimer'
import { drawDeltaTime } from './drawDeltaTime'
import { drawPredictiveLapTimer } from './drawPredictiveLapTimer'
import { drawApexSpeedCallout } from './drawApexSpeedCallout'
import { drawSpeedDistanceGraph } from './drawSpeedDistanceGraph'
import { drawGForceDiagram } from './drawGForceDiagram'
import { drawRollAngle } from './drawRollAngle'
import { drawSessionSummary, type SessionSummaryData } from './drawSessionSummary'
import { drawLapConsistency } from './drawLapConsistency'
import { drawCustomText } from './drawCustomText'
import { drawElevation } from './drawElevation'
import { drawDistance } from './drawDistance'
import { drawCompass } from './drawCompass'
import { drawAccelTimer } from './drawAccelTimer'

export interface WidgetDrawContext {
  trackPoints: ProjectedPoint[]
  bounds: TrackBounds
  dotPosition: ProjectedPoint
  /** Whether the current frame has a trustworthy GPS position for live GPS-derived widgets. */
  hasGpsPosition?: boolean
  speedMps: number
  elapsedMs: number
  /** cts at which this frame is being drawn -- used by 'apexSpeedCallout' to resolve its flash window. */
  cts: number
  /** Only relevant for a 'timer' widget in mode 'laps'. */
  lapState?: LapState | null
  /** Only relevant for a 'sectorTimer' widget. */
  sectorState?: SectorState | null
  /** Only relevant for 'deltaTime'/'predictiveLapTimer' widgets. */
  deltaState?: DeltaState | null
  /** Only relevant for an 'apexSpeedCallout' widget -- precomputed once per widget instance (its
   *  detection thresholds are per-widget style, not shared like lap/sector/delta state). */
  apexEvents?: ApexEvent[]
  /** Only relevant for a 'timer' widget in mode 'laps' with a custom header logo set, or a
   *  'customText' widget with an image set -- both are user-uploaded, data-URL-backed images keyed
   *  by widget id, so this one field/map serves either. Loaded ahead of time by the caller. */
  headerImage?: CanvasImageLike | null
  /** Bundled fl.png, loaded once by the caller and shared across every timing-tower widget/frame. */
  fastestLapIcon?: CanvasImageLike | null
  /** Only relevant for a 'gpsTrack' widget with colorMode 'speed'/'braking'. 1:1 index-aligned with trackPoints. */
  trackSpeeds?: number[]
  trackCts?: number[]
  speedBounds?: { min: number; max: number }
  /** Only relevant for a 'gpsTrack' widget with colorMode 'speed'/'braking' -- see
   *  buildColoredGpsTrackCache. Pre-rendered by the caller once and reused across frames instead of
   *  re-stroking every track segment on every single frame. */
  coloredTrackImage?: CanvasImageLike | null
  /** Only relevant for a 'gpsTrack' widget with style.showGhost -- see DeltaState.ghostCts /
   *  drawGpsWidget's own doc comment for why this is resolved at the baseline lap's matching
   *  elapsed time, not distance. Resolved by the caller via sampler.positionAt(deltaState.ghostCts). */
  ghostPosition?: ProjectedPoint | null
  /** Only relevant for a 'gpsTrack' widget with style.showApexMarkers -- one projected position per
   *  detected apex (see apexEvents), resolved by the caller via sampler.positionAt(event.cts). */
  apexPositions?: ProjectedPoint[]
  /** Only relevant for a 'speedDistanceGraph' widget -- completed-lap traces are shared/precomputed
   *  once (don't depend on cts); the current-lap trace is resolved fresh every frame. */
  lapSpeedTraces?: LapSpeedTrace[]
  currentLapSpeedTrace?: LapSpeedTrace | null
  /** Only relevant for 'gForceDiagram'/'rollAngle' widgets -- resolved per widget instance (each has
   *  its own smoothing/manual-axis-override style), not shared globally. */
  gForceReading?: GForceReading
  gForceHistory?: GForceHistoryPoint[]
  rollAngleReading?: RollAngleReading
  hasImuData?: boolean
  /** Only relevant for a 'sessionSummary' widget. */
  sessionSummaryData?: SessionSummaryData
  /** Only relevant for a 'sessionSummary' widget -- absolute cts (same space as `cts`) at which the
   *  trimmed session ends; style.showLastSeconds counts back from here. */
  sessionEndMs?: number
  /** Only relevant for an 'elevation' widget -- current reading resolved per widget instance (its
   *  own smoothing style), the profile is the whole-session static shape shared globally (doesn't
   *  depend on cts or per-widget style). */
  elevationReading?: number
  elevationProfile?: ElevationProfilePoint[]
  /** Only relevant for a 'distance' widget -- resolved per widget instance via sampler.distanceAt
   *  (a cheap prefix-sum lookup, no per-widget state to precompute). */
  distanceReading?: number
  /** Only relevant for a 'compass' widget -- resolved per widget instance via sampler.headingAt
   *  (its own smoothing is per-widget style, like elevation/gForce/roll). */
  headingReading?: number
  /** Only relevant for an 'accelTimer' widget -- detectAccelRuns is precomputed once per widget
   *  instance (its target speeds/thresholds are per-widget style, same as Apex Speed Callout's own
   *  detection thresholds), getAccelRunStateAt resolved fresh per frame from that. */
  accelRunState?: AccelRunState
  /** Project-wide default font (FORMULA1_FONT_ID or a real system font family), supplied by the
   *  caller from ProjectPayload.defaultFontFamily/projectStore -- resolveEffectiveFontFamily below
   *  is the one place a widget's own fontFamily overrides this. */
  projectFontFamily?: string
}

/** widget.fontFamily (per-widget override) wins when set; otherwise falls back to the project-wide
 *  default, then the bundled Formula1 sentinel -- the single resolution point every draw*.ts call
 *  below reads from, so no draw file needs to know about this fallback chain itself. */
function resolveEffectiveFontFamily(widget: WidgetInstance, data: WidgetDrawContext): string {
  return widget.fontFamily || data.projectFontFamily || FORMULA1_FONT_ID
}

function renderWidgetContent(ctx: Canvas2DLike, widget: WidgetInstance, rect: Rect, data: WidgetDrawContext): void {
  const fontFamily = resolveEffectiveFontFamily(widget, data)
  const hasGpsPosition = data.hasGpsPosition !== false
  switch (widget.type) {
    case 'gpsTrack':
      drawGpsWidget(ctx, {
        rect,
        style: widget.style,
        trackPoints: data.trackPoints,
        bounds: data.bounds,
        dotPosition: data.dotPosition,
        showDot: hasGpsPosition,
        trackSpeeds: data.trackSpeeds,
        trackCts: data.trackCts,
        speedBounds: data.speedBounds,
        coloredTrackImage: data.coloredTrackImage,
        ghostPosition: data.ghostPosition,
        apexPositions: data.apexPositions
      })
      return
    case 'speedometerAnalog':
      if (!hasGpsPosition) return
      drawSpeedometerAnalog(ctx, { rect, style: widget.style, speedMps: data.speedMps, fontFamily })
      return
    case 'speedometerDigital':
      if (!hasGpsPosition) return
      drawSpeedometerDigital(ctx, { rect, style: widget.style, speedMps: data.speedMps, fontFamily })
      return
    case 'timer':
      drawTimer(ctx, {
        rect,
        style: widget.style,
        elapsedMs: data.elapsedMs,
        lapState: data.lapState,
        headerImage: data.headerImage,
        fastestLapIcon: data.fastestLapIcon,
        fontFamily
      })
      return
    case 'sectorTimer':
      drawSectorTimer(ctx, { rect, style: widget.style, sectorState: data.sectorState ?? null, fontFamily })
      return
    case 'deltaTime':
      drawDeltaTime(ctx, { rect, style: widget.style, deltaState: data.deltaState ?? null, fontFamily })
      return
    case 'predictiveLapTimer':
      drawPredictiveLapTimer(ctx, { rect, style: widget.style, deltaState: data.deltaState ?? null, fontFamily })
      return
    case 'apexSpeedCallout':
      drawApexSpeedCallout(ctx, { rect, style: widget.style, events: data.apexEvents ?? [], cts: data.cts, fontFamily })
      return
    case 'speedDistanceGraph':
      drawSpeedDistanceGraph(ctx, {
        rect,
        style: widget.style,
        lapTraces: data.lapSpeedTraces ?? [],
        currentLapTrace: data.currentLapSpeedTrace ?? null,
        fontFamily
      })
      return
    case 'gForceDiagram':
      drawGForceDiagram(ctx, {
        rect,
        style: widget.style,
        reading: data.gForceReading ?? { lateralG: 0, longitudinalG: 0 },
        history: data.gForceHistory ?? [],
        cts: data.cts,
        hasImuData: data.hasImuData ?? false,
        fontFamily
      })
      return
    case 'rollAngle':
      drawRollAngle(ctx, {
        rect,
        style: widget.style,
        reading: data.rollAngleReading ?? { degrees: 0, source: 'accelFallback' },
        hasImuData: data.hasImuData ?? false,
        fontFamily
      })
      return
    case 'sessionSummary':
      if (!data.sessionSummaryData || data.sessionEndMs == null) return
      drawSessionSummary(ctx, {
        rect,
        style: widget.style,
        data: data.sessionSummaryData,
        cts: data.cts,
        sessionEndMs: data.sessionEndMs,
        fontFamily
      })
      return
    case 'lapConsistency':
      drawLapConsistency(ctx, { rect, style: widget.style, lapState: data.lapState ?? null, fontFamily })
      return
    case 'customText':
      drawCustomText(ctx, { rect, style: widget.style, image: data.headerImage, fontFamily })
      return
    case 'elevation':
      if (!hasGpsPosition) return
      drawElevation(ctx, {
        rect,
        style: widget.style,
        currentAltitudeM: data.elevationReading ?? 0,
        profile: data.elevationProfile ?? [],
        cts: data.cts,
        fontFamily
      })
      return
    case 'distance':
      if (!hasGpsPosition) return
      drawDistance(ctx, { rect, style: widget.style, distanceM: data.distanceReading ?? 0, fontFamily })
      return
    case 'compass':
      if (!hasGpsPosition) return
      drawCompass(ctx, { rect, style: widget.style, headingDeg: data.headingReading ?? 0, fontFamily })
      return
    case 'accelTimer':
      drawAccelTimer(ctx, {
        rect,
        style: widget.style,
        state: data.accelRunState ?? { isActive: false, elapsedMs: null, currentSplits: [], bestSplits: [] },
        fontFamily
      })
      return
  }
}

/**
 * Dispatches a widget instance to its type-specific render function at the given pixel `rect`,
 * rotated around the rect's own center. This runs identically in the live-preview canvas and
 * the headless export renderer, so rotation (and everything else) stays WYSIWYG between them.
 */
export function drawWidget(ctx: Canvas2DLike, widget: WidgetInstance, rect: Rect, data: WidgetDrawContext): void {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((widget.rotation * Math.PI) / 180)
  ctx.translate(-cx, -cy)
  renderWidgetContent(ctx, widget, rect, data)
  ctx.restore()
}
