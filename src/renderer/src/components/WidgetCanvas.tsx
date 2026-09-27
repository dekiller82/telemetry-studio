import { useEffect, useMemo, useRef } from 'react'
import type { WidgetInstance } from '@shared/types'
import type { TelemetrySampler } from '@shared/telemetry/sampleAt'
import type { LapState } from '@shared/telemetry/laps'
import type { SectorState } from '@shared/telemetry/sectors'
import type { DeltaState } from '@shared/telemetry/deltaTime'
import type { ProjectedPoint } from '@shared/telemetry/interpolate'
import type { LapSpeedTrace } from '@shared/telemetry/speedTrace'
import type { SessionSummaryData } from '@shared/render/drawSessionSummary'
import { detectApexEvents } from '@shared/telemetry/apex'
import { detectAccelRuns, getAccelRunStateAt } from '@shared/telemetry/accelRuns'
import { buildManualCalibration, buildManualCalibrationForRoll } from '@shared/telemetry/imuCalibration'
import { drawWidget } from '@shared/render/drawWidget'
import { buildColoredGpsTrackCache } from '@shared/render/drawGpsWidget'
import type { Canvas2DLike } from '@shared/render/canvas2d'
import { speedSmoothingMsFor } from '@shared/widgets/helpers'
import { useLoadedImage } from '../hooks/useLoadedImage'
import flIconUrl from '../icons/fl.png'

interface Props {
  widget: WidgetInstance
  sampler: TelemetrySampler
  currentTimeMs: number
  pixelWidth: number
  pixelHeight: number
  lapState: LapState | null
  sectorState: SectorState | null
  deltaState: DeltaState | null
  ghostPosition: ProjectedPoint | null
  sessionSummaryData: SessionSummaryData | null
  sessionEndMs: number
  lapSpeedTraces: LapSpeedTrace[]
  currentLapSpeedTrace: LapSpeedTrace | null
  defaultFontFamily: string
}

function WidgetCanvas({
  widget,
  sampler,
  currentTimeMs,
  pixelWidth,
  pixelHeight,
  lapState,
  sectorState,
  deltaState,
  ghostPosition,
  sessionSummaryData,
  sessionEndMs,
  lapSpeedTraces,
  currentLapSpeedTrace,
  defaultFontFamily
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const headerImageDataUrl =
    widget.type === 'timer' && widget.style.mode === 'laps'
      ? widget.style.headerImageDataUrl
      : widget.type === 'customText'
        ? widget.style.imageDataUrl
        : null
  const headerImage = useLoadedImage(headerImageDataUrl)
  const fastestLapIcon = useLoadedImage(flIconUrl)

  // Apex detection thresholds are per-widget style (unlike lap/sector/delta state, which share one
  // global start/finish line across every widget) -- memoized on the specific threshold values (not
  // the whole `widget` object) so dragging/resizing this widget doesn't re-run an O(n) detection
  // pass on every position update. Both Apex Speed Callout and the GPS Track's own apex markers
  // reuse this same detection, each with their own threshold fields.
  const gpsShowApexMarkers = widget.type === 'gpsTrack' && widget.style.showApexMarkers
  const minDropMps = widget.type === 'apexSpeedCallout' ? widget.style.minDropMps : gpsShowApexMarkers ? widget.style.apexMinDropMps : null
  const minGapMs = widget.type === 'apexSpeedCallout' ? widget.style.minGapMs : gpsShowApexMarkers ? widget.style.apexMinGapMs : null
  const apexEvents = useMemo(
    () => (minDropMps !== null && minGapMs !== null ? detectApexEvents(sampler.samples, minDropMps, minGapMs) : []),
    [sampler, minDropMps, minGapMs]
  )
  // Positions (not just times) for the GPS Track's own apex markers -- projected once here per
  // widget instance, same as ghostPosition is resolved once per frame in WidgetLayer.tsx, just
  // per-widget since apex thresholds are per-widget style rather than shared globally.
  const apexPositions = useMemo(
    () => (gpsShowApexMarkers ? apexEvents.map((e) => sampler.positionAt(e.cts)) : undefined),
    [gpsShowApexMarkers, apexEvents, sampler]
  )

  // Launch detection thresholds/target speeds are per-widget style (like Apex Speed Callout's own
  // thresholds), so precomputed once here per widget instance rather than shared globally like
  // lap/sector/delta state.
  const isAccelTimer = widget.type === 'accelTimer'
  const accelTargetSpeeds = isAccelTimer ? widget.style.targetSpeedsMps : null
  const accelStationaryThresholdMps = isAccelTimer ? widget.style.stationaryThresholdMps : null
  const accelMinStationaryMs = isAccelTimer ? widget.style.minStationaryMs : null
  const accelRuns = useMemo(
    () =>
      accelTargetSpeeds && accelStationaryThresholdMps !== null && accelMinStationaryMs !== null
        ? detectAccelRuns(sampler.samples, accelTargetSpeeds, accelStationaryThresholdMps, accelMinStationaryMs)
        : [],
    [sampler, accelTargetSpeeds, accelStationaryThresholdMps, accelMinStationaryMs]
  )

  // colorMode 'speed'/'braking' segments never change frame-to-frame (only the dot does), so this
  // is pre-rendered once into an offscreen canvas and reused every frame instead of re-stroking
  // potentially tens of thousands of individual segments 60 times a second during playback -- see
  // buildColoredGpsTrackCache's own doc comment. Recomputed only when style/size/track data actually
  // change (dragging/resizing a DIFFERENT widget, or scrubbing the timeline, doesn't touch this).
  // 'window' mode recenters/zooms every frame, incompatible with a cache pre-rendered once against
  // the full track's own static bounds -- drawGpsWidget always draws fresh in that mode, so building
  // this cache for it would just be wasted work.
  const gpsColorStyle =
    widget.type === 'gpsTrack' && widget.style.colorMode !== 'solid' && widget.style.viewMode !== 'window' ? widget.style : null
  const coloredTrackImage = useMemo(() => {
    if (!gpsColorStyle || pixelWidth <= 0 || pixelHeight <= 0) return null
    const cacheCanvas = document.createElement('canvas')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cacheCanvas.width = Math.max(1, Math.round(pixelWidth * dpr))
    cacheCanvas.height = Math.max(1, Math.round(pixelHeight * dpr))
    const cacheCtx = cacheCanvas.getContext('2d')
    if (!cacheCtx) return null
    cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    buildColoredGpsTrackCache(
      cacheCtx as unknown as Canvas2DLike,
      sampler.trackPoints,
      sampler.bounds,
      { x: 0, y: 0, w: pixelWidth, h: pixelHeight },
      gpsColorStyle,
      sampler.trackSpeeds,
      sampler.trackCts,
      sampler.speedBounds
    )
    return cacheCanvas
  }, [gpsColorStyle, pixelWidth, pixelHeight, sampler])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || pixelWidth <= 0 || pixelHeight <= 0) return

    // Capped at 2x: every widget gets its own canvas, redrawn on every animation frame during
    // playback, so backing-store pixel count (and the GPU/CPU fill cost that scales with it) adds
    // up fast across several widgets at once. Uncapped 3x display scaling (common on some Windows
    // laptops) would nearly double that again for no visible benefit at typical widget sizes.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const targetW = Math.max(1, Math.round(pixelWidth * dpr))
    const targetH = Math.max(1, Math.round(pixelHeight * dpr))
    if (canvas.width !== targetW) canvas.width = targetW
    if (canvas.height !== targetH) canvas.height = targetH

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, pixelWidth, pixelHeight)

    // Resolved fresh per draw call (cheap -- a single Gaussian window lookup), using each widget
    // instance's own smoothing/manual-axis-override style, same reasoning as speedMps/dotPosition
    // just above -- not shared globally like lapState/sectorState, since different gForceDiagram or
    // rollAngle instances can have different smoothing/calibration settings.
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
      gForceReading = sampler.gForceAt(currentTimeMs, widget.style.smoothingMs, cal)
      gForceHistory = sampler.gForceHistoryAt(currentTimeMs, widget.style.trailDurationMs, cal)
    } else if (widget.type === 'rollAngle') {
      const cal = widget.style.useManualAxes
        ? buildManualCalibrationForRoll(widget.style.verticalAxis, widget.style.lateralAxis, widget.style.verticalInverted, widget.style.lateralInverted)
        : undefined
      rollAngleReading = sampler.rollAngleAt(currentTimeMs, widget.style.smoothingMs, cal)
    } else if (widget.type === 'elevation') {
      elevationReading = sampler.elevationAt(currentTimeMs, widget.style.smoothingMs)
    } else if (widget.type === 'distance') {
      distanceReading = sampler.distanceAt(currentTimeMs)
    } else if (widget.type === 'compass') {
      headingReading = sampler.headingAt(currentTimeMs, widget.style.smoothingMs)
    } else if (widget.type === 'accelTimer') {
      accelRunState = getAccelRunStateAt(accelRuns, widget.style.targetSpeedsMps, currentTimeMs)
    }

    const rect = { x: 0, y: 0, w: pixelWidth, h: pixelHeight }
    drawWidget(ctx as unknown as Canvas2DLike, widget, rect, {
      trackPoints: sampler.trackPoints,
      bounds: sampler.bounds,
      dotPosition: sampler.positionAt(currentTimeMs),
      hasGpsPosition: sampler.hasPositionAt(currentTimeMs),
      speedMps: sampler.speedAt(currentTimeMs, speedSmoothingMsFor(widget)),
      elapsedMs: currentTimeMs,
      cts: currentTimeMs,
      lapState,
      sectorState,
      deltaState,
      ghostPosition,
      sessionSummaryData: sessionSummaryData ?? undefined,
      sessionEndMs,
      apexEvents,
      apexPositions,
      headerImage,
      fastestLapIcon,
      trackSpeeds: sampler.trackSpeeds,
      trackCts: sampler.trackCts,
      speedBounds: sampler.speedBounds,
      coloredTrackImage,
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
  }, [
    widget,
    sampler,
    currentTimeMs,
    pixelWidth,
    pixelHeight,
    lapState,
    sectorState,
    deltaState,
    ghostPosition,
    sessionSummaryData,
    sessionEndMs,
    apexEvents,
    apexPositions,
    headerImage,
    fastestLapIcon,
    coloredTrackImage,
    lapSpeedTraces,
    currentLapSpeedTrace,
    accelRuns,
    defaultFontFamily
  ])

  return (
    <canvas ref={canvasRef} className="widget-box__canvas" style={{ width: pixelWidth, height: pixelHeight }} />
  )
}

export default WidgetCanvas
