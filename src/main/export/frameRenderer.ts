import { createCanvas, type Image } from '@napi-rs/canvas'
import { drawWidget } from '../../shared/render/drawWidget'
import { ExportSpeedDistanceGraphCache, GraphCacheBudget } from './speedDistanceGraphCache'
import { buildColoredGpsTrackCache } from '../../shared/render/drawGpsWidget'
import { prepareGpsTrackView, type GpsTrackView } from '../../shared/render/gpsTrackView'
import { drawSpeedometerAnalogStaticLayer, drawSpeedometerDigitalStaticLayer } from '../../shared/render/drawSpeedometer'
import { drawGForceStaticLayer } from '../../shared/render/drawGForceDiagram'
import type { Canvas2DLike, CanvasImageLike, StaticWidgetLayer, Rect } from '../../shared/render/canvas2d'
import type { TelemetrySampler } from '../../shared/telemetry/sampleAt'
import { detectLapCrossings, getLapStateAt } from '../../shared/telemetry/laps'
import { computeLapSectors, getSectorStateAt } from '../../shared/telemetry/sectors'
import { computeLapDistanceCurves, getDeltaStateAt } from '../../shared/telemetry/deltaTime'
import { detectApexEvents, type ApexEvent } from '../../shared/telemetry/apex'
import { detectAccelRuns, getAccelRunStateAt, type AccelRun } from '../../shared/telemetry/accelRuns'
import { computeCurrentLapSpeedTrace, computeLapSpeedTraces } from '../../shared/telemetry/speedTrace'
import { buildManualCalibration, buildManualCalibrationForRoll } from '../../shared/telemetry/imuCalibration'
import type { CrossingAdjustments, CrossingIgnoreSet, LatLon, WidgetInstance } from '../../shared/types'
import { speedSmoothingMsFor } from '../../shared/widgets/helpers'
import { registerExportFonts } from './registerFonts'
import { loadHeaderImageFromDataUrl } from './loadHeaderImage'
import { loadFastestLapIcon } from './loadIcons'
import { computeOverlayRoi, type OverlayRoi } from './overlayRoi'

/** Renders overlay frames (transparent background) at a fixed pixel size, ready to pipe to ffmpeg as raw RGBA. */
export async function createFrameRenderer(
  width: number,
  height: number,
  widgets: WidgetInstance[],
  sampler: TelemetrySampler,
  startFinish: LatLon | null,
  /** Start/finish detection radius, meters -- see shared/types.ts's ProjectPayload.startFinishRadiusM. */
  startFinishRadiusM: number,
  /** Manual per-crossing time corrections for startFinish -- see shared/types.ts's CrossingAdjustments. */
  crossingAdjustmentsMs: CrossingAdjustments,
  /** Crossings manually deleted as a false lap detection -- see shared/types.ts's CrossingIgnoreSet. */
  ignoredCrossings: CrossingIgnoreSet,
  /** Absolute cts (same space as sampleCts) at which the trimmed session ends -- used for the
   *  Session Summary widget's showLastSeconds countdown AND (with trimStartMs) its final totals. */
  trimEndMs: number,
  /** Absolute cts at which the trimmed session starts -- only needed for the Session Summary
   *  widget's total-duration figure (trimEndMs - trimStartMs). */
  trimStartMs: number,
  /** Project-wide default font (FORMULA1_FONT_ID or a real system font family) -- any widget's own
   *  fontFamily overrides this. */
  defaultFontFamily: string,
  assetDirectories?: { fonts: string; icons: string }
): Promise<{ roi: OverlayRoi; renderFrame: (sampleCts: number, elapsedMs: number) => Buffer }> {
  registerExportFonts(assetDirectories?.fonts)

  const sortedWidgets = [...widgets].sort((a, b) => a.zIndex - b.zIndex)
  const overlayRoi = computeOverlayRoi(width, height, sortedWidgets)
  const canvas = createCanvas(overlayRoi.width, overlayRoi.height)
  const ctx = canvas.getContext('2d')
  const fullGpsTrack: GpsTrackView = {
    trackPoints: sampler.trackPoints,
    bounds: sampler.bounds,
    trackSpeeds: sampler.trackSpeeds,
    trackCts: sampler.trackCts
  }
  const trimmedGpsTrack = sortedWidgets.some((widget) => widget.type === 'gpsTrack' && widget.style.trimAware)
    ? prepareGpsTrackView(fullGpsTrack, trimStartMs, trimEndMs)
    : fullGpsTrack
  const gpsTrackByWidgetId = new Map<string, GpsTrackView>()

  // Precomputed once (O(n) over telemetry samples), not per-frame -- crossings/sectors/lap-distance
  // curves don't depend on cts. Every widget that needs lap detection shares the same global
  // start/finish line.
  const crossings = startFinish
    ? detectLapCrossings(sampler.samples, startFinish, startFinishRadiusM, undefined, crossingAdjustmentsMs, ignoredCrossings)
    : null
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
  // Dial/grid/panel layers for widgets whose values change every frame. These are rendered once
  // into widget-sized canvases and composited before the dynamic readout/trail/needle.
  const staticWidgetLayers = new Map<string, StaticWidgetLayer>()
  let staticLayerBytes = 0
  const graphCacheBudget = new GraphCacheBudget()
  const graphCacheByWidgetId = new Map<string, ExportSpeedDistanceGraphCache>()
  // Launch detection thresholds/target speeds are per-widget style, so precomputed once per widget
  // instance here rather than once globally -- same reasoning as apexEventsByWidgetId above.
  const accelRunsByWidgetId = new Map<string, AccelRun[]>()
  let usesFastestLapIcon = false

  for (const widget of sortedWidgets) {
    if (widget.type === 'speedDistanceGraph' && !widget.rotation) {
      graphCacheByWidgetId.set(widget.id, new ExportSpeedDistanceGraphCache(graphCacheBudget))
    }
    if (widget.type === 'gpsTrack') {
      gpsTrackByWidgetId.set(widget.id, widget.style.trimAware ? trimmedGpsTrack : fullGpsTrack)
    }
    if (!widget.rotation && (widget.type === 'speedometerAnalog' || widget.type === 'speedometerDigital' || widget.type === 'gForceDiagram')) {
      const rect: Rect = { x: widget.x * width, y: widget.y * height, w: widget.w * width, h: widget.h * height }
      // Integer cache origins preserve the original fractional geometry. Never resize the cached
      // image when compositing: that changes thin strokes and glyph positions. Rotated widgets
      // keep immediate vector drawing rather than rotating an already-rasterized text layer.
      const margin = Math.ceil(Math.max(32, rect.w * 0.18, rect.h * 0.18))
      const left = Math.floor(rect.x - margin)
      const top = Math.floor(rect.y - margin)
      const layerWidth = Math.ceil(rect.x + rect.w + margin) - left
      const layerHeight = Math.ceil(rect.y + rect.h + margin) - top
      const layerBytes = layerWidth * layerHeight * 4
      if (!Number.isSafeInteger(layerBytes) || layerBytes <= 0 || staticLayerBytes + layerBytes > 16 * 1024 * 1024) continue
      staticLayerBytes += layerBytes
      const layerCanvas = createCanvas(layerWidth, layerHeight)
      const layerCtx = layerCanvas.getContext('2d')
      const localRect: Rect = { ...rect, x: rect.x - left, y: rect.y - top }
      const fontFamily = widget.fontFamily || defaultFontFamily
      if (widget.type === 'speedometerAnalog') {
        drawSpeedometerAnalogStaticLayer(layerCtx as unknown as Canvas2DLike, localRect, widget.style, fontFamily)
      } else if (widget.type === 'speedometerDigital') {
        drawSpeedometerDigitalStaticLayer(layerCtx as unknown as Canvas2DLike, localRect, widget.style)
      } else {
        drawGForceStaticLayer(layerCtx as unknown as Canvas2DLike, localRect, widget.style, sampler.hasImuData, fontFamily)
      }
      staticWidgetLayers.set(widget.id, {
        image: layerCanvas as unknown as CanvasImageLike, offsetX: left - rect.x, offsetY: top - rect.y
      })
    }
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
      const track = gpsTrackByWidgetId.get(widget.id)!
      const rect: Rect = { x: widget.x * width, y: widget.y * height, w: widget.w * width, h: widget.h * height }
      const cacheCanvas = createCanvas(Math.max(1, Math.round(rect.w)), Math.max(1, Math.round(rect.h)))
      const cacheCtx = cacheCanvas.getContext('2d')
      buildColoredGpsTrackCache(
        cacheCtx as unknown as Canvas2DLike,
        track.trackPoints,
        track.bounds,
        { x: 0, y: 0, w: rect.w, h: rect.h },
        widget.style,
        track.trackSpeeds,
        track.trackCts,
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

  const fastestLapIcon = usesFastestLapIcon ? await loadFastestLapIcon(assetDirectories?.icons) : null

  // `sampleCts` (absolute, untrimmed global timeline position) drives GPS/speed/lap/sector state --
  // trimming is a final edit/crop decision, it doesn't mean "lap 1 now starts elsewhere". `elapsedMs`
  // (separate, trim-relative) is only for the plain elapsed-mode timer widget's displayed value, so
  // it reads 00:00 at the trimmed-in point rather than starting mid-count in the exported video.
  return {
    roi: overlayRoi,
    renderFrame(sampleCts: number, elapsedMs: number): Buffer {
      ctx.clearRect(0, 0, overlayRoi.width, overlayRoi.height)
      ctx.save()
      ctx.translate(-overlayRoi.x, -overlayRoi.y)
      try {
        const dotPosition = sampler.positionAt(sampleCts)
        // Shared by every widget (the same global start/finish line), so resolved once per frame rather than per widget.
        const lapState = crossings ? getLapStateAt(crossings, sampleCts) : null
        const sectorState = sectorBoundaries ? getSectorStateAt(sectorBoundaries, sampleCts) : null
        const deltaState =
          crossings && lapDistanceCurves ? getDeltaStateAt(lapDistanceCurves, crossings, sampler.samples, sampleCts) : null
        // GPS Track's optional "ghost" marker -- shared across every gpsTrack widget instance, same as
        // deltaState itself, resolved once per frame.
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
            trimStartMs,
            sessionEndMs: trimEndMs,
            apexEvents: apexEventsByWidgetId.get(widget.id) ?? [],
            headerImage: headerImageByWidgetId.get(widget.id) ?? null,
            fastestLapIcon,
            trackSpeeds: sampler.trackSpeeds,
            trackCts: sampler.trackCts,
            speedBounds: sampler.speedBounds,
            coloredTrackImage: coloredTrackImageByWidgetId.get(widget.id) ?? null,
            preparedGpsTrack: gpsTrackByWidgetId.get(widget.id),
            lapSpeedTraces,
            currentLapSpeedTrace,
            speedDistanceGraphCache: graphCacheByWidgetId.get(widget.id),
            staticWidgetLayers,
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

        // Canvas.data() exposes the canvas's premultiplied RGBA pixels. Its memory can change on
        // the next draw, so FFmpeg must receive an owned snapshot even when stdin is backpressured.
        // The matching overlay filter uses alpha=premultiplied; no per-pixel JS conversion is needed.
        return Buffer.from(canvas.data())
      } finally {
        ctx.restore()
      }
    }
  }
}
