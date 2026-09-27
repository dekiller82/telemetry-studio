import { createCanvas, type Image } from '@napi-rs/canvas'
import { drawWidget } from '../../shared/render/drawWidget'
import { buildColoredGpsTrackCache } from '../../shared/render/drawGpsWidget'
import type { Canvas2DLike, CanvasImageLike, Rect } from '../../shared/render/canvas2d'
import type { TelemetrySampler } from '../../shared/telemetry/sampleAt'
import { detectLapCrossings, getLapStateAt } from '../../shared/telemetry/laps'
import { computeLapSectors, getSectorStateAt } from '../../shared/telemetry/sectors'
import { computeLapDistanceCurves, getDeltaStateAt } from '../../shared/telemetry/deltaTime'
import { detectApexEvents, type ApexEvent } from '../../shared/telemetry/apex'
import { detectAccelRuns, getAccelRunStateAt, type AccelRun } from '../../shared/telemetry/accelRuns'
import { computeCurrentLapSpeedTrace, computeLapSpeedTraces } from '../../shared/telemetry/speedTrace'
import { buildManualCalibration, buildManualCalibrationForRoll } from '../../shared/telemetry/imuCalibration'
import type { CrossingAdjustments, LatLon, WidgetInstance } from '../../shared/types'
import { speedSmoothingMsFor } from '../../shared/widgets/helpers'
import { unpremultiplyRgbaInPlace } from './unpremultiply'
import { registerExportFonts } from './registerFonts'
import { loadHeaderImageFromDataUrl } from './loadHeaderImage'
import { loadFastestLapIcon } from './loadIcons'

/** Renders overlay frames (transparent background) at a fixed pixel size, ready to pipe to ffmpeg as raw RGBA. */
export async function createFrameRenderer(
  width: number,
  height: number,
  widgets: WidgetInstance[],
  sampler: TelemetrySampler,
  startFinish: LatLon | null,
  /** Manual per-crossing time corrections for startFinish -- see shared/types.ts's CrossingAdjustments. */
  crossingAdjustmentsMs: CrossingAdjustments,
  /** Absolute cts (same space as sampleCts) at which the trimmed session ends -- used for the
   *  Session Summary widget's showLastSeconds countdown AND (with trimStartMs) its final totals. */
  trimEndMs: number,
  /** Absolute cts at which the trimmed session starts -- only needed for the Session Summary
   *  widget's total-duration figure (trimEndMs - trimStartMs). */
  trimStartMs: number,
  /** Project-wide default font (FORMULA1_FONT_ID or a real system font family) -- any widget's own
   *  fontFamily overrides this. */
  defaultFontFamily: string
): Promise<(sampleCts: number, elapsedMs: number) => Buffer> {
  registerExportFonts()

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const sortedWidgets = [...widgets].sort((a, b) => a.zIndex - b.zIndex)

  // Precomputed once (O(n) over telemetry samples), not per-frame -- crossings/sectors/lap-distance
  // curves don't depend on cts. Every widget that needs lap detection shares the same global
  // start/finish line.
  const crossings = startFinish ? detectLapCrossings(sampler.samples, startFinish, undefined, undefined, crossingAdjustmentsMs) : null
  const sectorBoundaries = crossings ? computeLapSectors(sampler.samples, crossings) : null
  const lapDistanceCurves = crossings ? computeLapDistanceCurves(sampler.samples, crossings) : null
  // Full per-lap trace list, precomputed once -- must still be filtered to laps completed BY each
  // frame's own sampleCts before drawing (below), or every frame (even ones during lap 1) would show
  // every lap in the whole session at once, same discipline as lapState/sectorState/deltaState.
  const allLapSpeedTraces = crossings ? computeLapSpeedTraces(sampler.samples, crossings) : []
  // Session Summary is an outro RECAP, not a live readout -- unlike lapState/sectorState per frame
  // below (which DO need to reflect that frame's own sampleCts), its data is the session's true
  // final totals, resolved once here rather than recomputed (and drifting) on every frame.
  const finalLapState = crossings ? getLapStateAt(crossings, trimEndMs) : null
  const finalSectorState = sectorBoundaries ? getSectorStateAt(sectorBoundaries, trimEndMs) : null
  const finalSessionStats = sampler.sessionStatsAt(trimStartMs, trimEndMs)
  const sessionSummaryData = {
    totalLaps: finalLapState?.history.length ?? 0,
    bestLapMs: finalLapState?.bestLapMs ?? null,
    bestS1Ms: finalSectorState?.bestS1Ms ?? null,
    bestS2Ms: finalSectorState?.bestS2Ms ?? null,
    bestS3Ms: finalSectorState?.bestS3Ms ?? null,
    topSpeedMps: finalSessionStats.maxSpeedMps,
    totalDistanceM: finalSessionStats.totalDistanceM,
    elapsedMs: Math.max(0, trimEndMs - trimStartMs)
  }
  const headerImageByWidgetId = new Map<string, Image>()
  // Apex detection thresholds are per-widget style (not shared like lap/sector/delta state), so
  // precomputed once per widget instance here rather than once globally.
  const apexEventsByWidgetId = new Map<string, ApexEvent[]>()
  // GPS Track's own apex markers -- projected positions (not just times), independent of any
  // frame's sampleCts, so resolved once here rather than per frame.
  const apexPositionsByWidgetId = new Map<string, { x: number; y: number }[]>()
  // colorMode 'speed'/'braking' segments are static for the whole export (only the dot moves), so
  // built once here rather than re-stroked from scratch on every one of potentially thousands of
  // exported frames -- same reasoning as WidgetCanvas.tsx's live-preview cache.
  const coloredTrackImageByWidgetId = new Map<string, CanvasImageLike>()
  // Launch detection thresholds/target speeds are per-widget style, so precomputed once per widget
  // instance here rather than once globally -- same reasoning as apexEventsByWidgetId above.
  const accelRunsByWidgetId = new Map<string, AccelRun[]>()
  let usesFastestLapIcon = false

  for (const widget of sortedWidgets) {
    if (widget.type === 'timer' && widget.style.mode === 'laps') {
      usesFastestLapIcon = true
      if (widget.style.headerImageDataUrl) {
        headerImageByWidgetId.set(widget.id, await loadHeaderImageFromDataUrl(widget.style.headerImageDataUrl))
      }
    }
    if (widget.type === 'customText' && widget.style.imageDataUrl) {
      headerImageByWidgetId.set(widget.id, await loadHeaderImageFromDataUrl(widget.style.imageDataUrl))
    }
    if (widget.type === 'apexSpeedCallout') {
      apexEventsByWidgetId.set(widget.id, detectApexEvents(sampler.samples, widget.style.minDropMps, widget.style.minGapMs))
    }
    if (widget.type === 'gpsTrack' && widget.style.showApexMarkers) {
      const events = detectApexEvents(sampler.samples, widget.style.apexMinDropMps, widget.style.apexMinGapMs)
      apexPositionsByWidgetId.set(widget.id, events.map((e) => sampler.positionAt(e.cts)))
    }
    if (widget.type === 'gpsTrack' && widget.style.colorMode !== 'solid' && widget.style.viewMode !== 'window') {
      const rect: Rect = { x: widget.x * width, y: widget.y * height, w: widget.w * width, h: widget.h * height }
      const cacheCanvas = createCanvas(Math.max(1, Math.round(rect.w)), Math.max(1, Math.round(rect.h)))
      const cacheCtx = cacheCanvas.getContext('2d')
      buildColoredGpsTrackCache(
        cacheCtx as unknown as Canvas2DLike,
        sampler.trackPoints,
        sampler.bounds,
        { x: 0, y: 0, w: rect.w, h: rect.h },
        widget.style,
        sampler.trackSpeeds,
        sampler.trackCts,
        sampler.speedBounds
      )
      coloredTrackImageByWidgetId.set(widget.id, cacheCanvas as unknown as CanvasImageLike)
    }
    if (widget.type === 'accelTimer') {
      accelRunsByWidgetId.set(
        widget.id,
        detectAccelRuns(sampler.samples, widget.style.targetSpeedsMps, widget.style.stationaryThresholdMps, widget.style.minStationaryMs)
      )
    }
  }

  const fastestLapIcon = usesFastestLapIcon ? await loadFastestLapIcon() : null

  // `sampleCts` (absolute, untrimmed global timeline position) drives GPS/speed/lap/sector state --
  // trimming is a final edit/crop decision, it doesn't mean "lap 1 now starts elsewhere". `elapsedMs`
  // (separate, trim-relative) is only for the plain elapsed-mode timer widget's displayed value, so
  // it reads 00:00 at the trimmed-in point rather than starting mid-count in the exported video.
  return function renderFrame(sampleCts: number, elapsedMs: number): Buffer {
    ctx.clearRect(0, 0, width, height)
    const dotPosition = sampler.positionAt(sampleCts)
    // Shared by every widget (the same global start/finish line), so resolved once per frame rather than per widget.
    const lapState = crossings ? getLapStateAt(crossings, sampleCts) : null
    const sectorState = sectorBoundaries ? getSectorStateAt(sectorBoundaries, sampleCts) : null
    const deltaState =
      crossings && lapDistanceCurves ? getDeltaStateAt(lapDistanceCurves, crossings, sampler.samples, sampleCts) : null
    // GPS Track's optional "ghost" marker -- shared across every gpsTrack widget instance, same as
    // deltaState itself, resolved once per frame rather than per widget.
    const ghostPosition = deltaState?.ghostCts != null ? sampler.positionAt(deltaState.ghostCts) : null
    const currentLapSpeedTrace = crossings ? computeCurrentLapSpeedTrace(sampler.samples, crossings, sampleCts) : null
    const lapSpeedTraces = crossings ? allLapSpeedTraces.filter((t) => crossings[t.lapNumber] <= sampleCts) : []

    for (const widget of sortedWidgets) {
      const rect: Rect = {
        x: widget.x * width,
        y: widget.y * height,
        w: widget.w * width,
        h: widget.h * height
      }

      // Resolved per widget instance (each can have its own smoothing/manual-axis-override style),
      // not shared globally like lapState/sectorState -- mirrors WidgetCanvas.tsx's live-preview path.
      let gForceReading
      let gForceHistory
      let rollAngleReading
      let elevationReading
      let distanceReading
      let headingReading
      let accelRunState
      if (widget.type === 'gForceDiagram') {
        const cal = widget.style.useManualAxes
          ? buildManualCalibration(widget.style.verticalAxis, widget.style.longitudinalAxis, widget.style.verticalInverted, widget.style.longitudinalInverted, widget.style.lateralInverted)
          : undefined
        gForceReading = sampler.gForceAt(sampleCts, widget.style.smoothingMs, cal)
        gForceHistory = sampler.gForceHistoryAt(sampleCts, widget.style.trailDurationMs, cal)
      } else if (widget.type === 'rollAngle') {
        const cal = widget.style.useManualAxes
          ? buildManualCalibrationForRoll(widget.style.verticalAxis, widget.style.lateralAxis, widget.style.verticalInverted, widget.style.lateralInverted)
          : undefined
        rollAngleReading = sampler.rollAngleAt(sampleCts, widget.style.smoothingMs, cal)
      } else if (widget.type === 'elevation') {
        elevationReading = sampler.elevationAt(sampleCts, widget.style.smoothingMs)
      } else if (widget.type === 'distance') {
        distanceReading = sampler.distanceAt(sampleCts)
      } else if (widget.type === 'compass') {
        headingReading = sampler.headingAt(sampleCts, widget.style.smoothingMs)
      } else if (widget.type === 'accelTimer') {
        accelRunState = getAccelRunStateAt(accelRunsByWidgetId.get(widget.id) ?? [], widget.style.targetSpeedsMps, sampleCts)
      }

      drawWidget(ctx as unknown as Canvas2DLike, widget, rect, {
        trackPoints: sampler.trackPoints,
        bounds: sampler.bounds,
        dotPosition,
        hasGpsPosition: sampler.hasPositionAt(sampleCts),
        speedMps: sampler.speedAt(sampleCts, speedSmoothingMsFor(widget)),
        elapsedMs,
        cts: sampleCts,
        lapState,
        sectorState,
        deltaState,
        ghostPosition,
        apexPositions: apexPositionsByWidgetId.get(widget.id),
        sessionSummaryData,
        sessionEndMs: trimEndMs,
        apexEvents: apexEventsByWidgetId.get(widget.id) ?? [],
        headerImage: headerImageByWidgetId.get(widget.id) ?? null,
        fastestLapIcon,
        trackSpeeds: sampler.trackSpeeds,
        trackCts: sampler.trackCts,
        speedBounds: sampler.speedBounds,
        coloredTrackImage: coloredTrackImageByWidgetId.get(widget.id) ?? null,
        lapSpeedTraces,
        currentLapSpeedTrace,
        gForceReading,
        gForceHistory,
        rollAngleReading,
        hasImuData: sampler.hasImuData,
        elevationReading,
        elevationProfile: sampler.elevationProfile,
        distanceReading,
        headingReading,
        accelRunState,
        projectFontFamily: defaultFontFamily
      })
    }

    const pixels = Buffer.from(canvas.data())
    unpremultiplyRgbaInPlace(pixels)
    return pixels
  }
}
