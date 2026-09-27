import { z } from 'zod'
import { FORMULA1_FONT_ID } from '../render/fonts'
import { DEFAULT_THRESHOLD_METERS } from '../telemetry/laps'

const transformFields = {
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  rotation: z.number(),
  zIndex: z.number(),
  /** When true, blocks drag/resize (and multi-select group-move) for this widget -- for pinning
   *  placement once it's dialed in without it accidentally moving while working on neighbors. */
  locked: z.boolean().default(false),
  /** null = inherit the project's defaultFontFamily -- default kept null (not the sentinel) so an
   *  old saved project's widgets don't suddenly all look "explicitly Formula1" instead of "inherit". */
  fontFamily: z.string().nullable().default(null)
}

const gpsStyleSchema = z.object({
  lineColor: z.string(),
  lineWidth: z.number(),
  lineOpacity: z.number(),
  dotColor: z.string(),
  dotRadius: z.number(),
  dotGlow: z.boolean(),
  // .default(...) on every field added here after v2 shipped -- an already-saved project file
  // missing these still parses (as 'solid', today's exact behavior) instead of failing outright.
  colorMode: z.enum(['solid', 'speed', 'braking']).default('solid'),
  slowColor: z.string().default('#2979ff'),
  fastColor: z.string().default('#ff3b30'),
  brakingColor: z.string().default('#ff3b30'),
  acceleratingColor: z.string().default('#3ddc71'),
  neutralColor: z.string().default('#ffffff'),
  brakingThresholdMps2: z.number().default(1.5),
  showGhost: z.boolean().default(false),
  ghostColor: z.string().default('#b026ff'),
  viewMode: z.enum(['full', 'window']).default('full'),
  windowRadiusM: z.number().default(25),
  showApexMarkers: z.boolean().default(false),
  apexMarkerColor: z.string().default('#ffd60a'),
  apexMinDropMps: z.number().default(8),
  apexMinGapMs: z.number().default(1500),
  trimAware: z.boolean().default(true)
})

const speedometerStyleSchema = z.object({
  unit: z.enum(['kmh', 'mph', 'kn']),
  smoothingMs: z.number(),
  min: z.number(),
  max: z.number(),
  color: z.string(),
  accentColor: z.string(),
  showUnit: z.boolean(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  // .default(...) -- background/cornerRadius added to the digital readout after this widget
  // shipped (analog ignores them), so an already-saved project's widget still parses.
  backgroundColor: z.string().default('#0a0a10'),
  backgroundOpacity: z.number().default(0.72),
  cornerRadius: z.number().default(12)
})

const latLonSchema = z.object({
  lat: z.number(),
  lon: z.number()
})

// .default({}) -- added after the project file format shipped, so an already-saved project (no
// manual crossing corrections at all) still parses.
const crossingAdjustmentsSchema = z.record(z.string(), z.number()).default({})

// .default({}) -- same reasoning as crossingAdjustmentsSchema above; an already-saved project has
// no manually-deleted crossings.
const ignoredCrossingsSchema = z.record(z.string(), z.boolean()).default({})

const timerStyleSchema = z.object({
  color: z.string(),
  showCentiseconds: z.boolean(),
  label: z.string(),
  labelColor: z.string(),
  mode: z.enum(['elapsed', 'laps']),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  headerImageDataUrl: z.string().nullable(),
  headerImageScale: z.number(),
  headerText: z.string(),
  headerTextColor: z.string(),
  rowOrder: z.enum(['ranked', 'chronological']),
  chronoDirection: z.enum(['newestOnTop', 'newestOnBottom']),
  maxVisibleRows: z.number(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  // .default(12) -- cornerRadius added to every background-having widget after these already
  // shipped, so an already-saved project's widget (missing it) still parses with the same rounded
  // look that's now the default for newly-created widgets, instead of failing outright.
  cornerRadius: z.number().default(12)
})

const sectorTimerStyleSchema = z.object({
  color: z.string(),
  labelColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number().default(12),
  showLastLapRow: z.boolean()
})

const deltaTimeStyleSchema = z.object({
  neutralColor: z.string(),
  fasterColor: z.string(),
  slowerColor: z.string(),
  label: z.string(),
  labelColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number().default(12)
})

const predictiveLapTimerStyleSchema = z.object({
  color: z.string(),
  label: z.string(),
  labelColor: z.string(),
  showDelta: z.boolean(),
  fasterColor: z.string(),
  slowerColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number().default(12)
})

const apexSpeedCalloutStyleSchema = z.object({
  unit: z.enum(['kmh', 'mph', 'kn']),
  color: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number().default(12),
  flashDurationMs: z.number(),
  minDropMps: z.number(),
  minGapMs: z.number(),
  label: z.string()
})

const speedDistanceGraphStyleSchema = z.object({
  unit: z.enum(['kmh', 'mph', 'kn']),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number().default(12),
  gridColor: z.string(),
  gridOpacity: z.number(),
  axisLabelColor: z.string(),
  lineWidth: z.number(),
  maxLapsShown: z.number(),
  showCurrentLap: z.boolean(),
  highlightCurrentLap: z.boolean(),
  colorSeed: z.number(),
  // .default(...) -- added after this widget type shipped, so an already-saved project's widget
  // (missing these) still parses instead of failing outright, same discipline as the GPS Track
  // widget's colorMode addition.
  viewMode: z.enum(['fullLap', 'window']).default('fullLap'),
  windowMeters: z.number().default(50),
  referenceLapColor: z.string().default('#9a9a9a'),
  referenceLapOpacity: z.number().default(0.55)
})

const gpsTrackWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('gpsTrack'),
  ...transformFields,
  style: gpsStyleSchema
})

const speedometerAnalogWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('speedometerAnalog'),
  ...transformFields,
  style: speedometerStyleSchema
})

const speedometerDigitalWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('speedometerDigital'),
  ...transformFields,
  style: speedometerStyleSchema
})

const timerWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('timer'),
  ...transformFields,
  style: timerStyleSchema
})

const sectorTimerWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('sectorTimer'),
  ...transformFields,
  style: sectorTimerStyleSchema
})

const deltaTimeWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('deltaTime'),
  ...transformFields,
  style: deltaTimeStyleSchema
})

const predictiveLapTimerWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('predictiveLapTimer'),
  ...transformFields,
  style: predictiveLapTimerStyleSchema
})

const apexSpeedCalloutWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('apexSpeedCallout'),
  ...transformFields,
  style: apexSpeedCalloutStyleSchema
})

const speedDistanceGraphWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('speedDistanceGraph'),
  ...transformFields,
  style: speedDistanceGraphStyleSchema
})

const gForceDiagramStyleSchema = z.object({
  maxG: z.number(),
  ringColor: z.string(),
  ringOpacity: z.number(),
  axisLabelColor: z.string(),
  // .default(true/'#ffffff') -- added after this widget shipped, so an already-saved project's
  // widget still parses; true/white keeps the pre-existing look (labels were always shown before).
  showAxisLabels: z.boolean().default(true),
  showValueReadout: z.boolean().default(true),
  valueColor: z.string().default('#ffffff'),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number().default(12),
  dotColor: z.string(),
  dotRadius: z.number(),
  trailColor: z.string(),
  trailDurationMs: z.number(),
  smoothingMs: z.number(),
  useManualAxes: z.boolean(),
  verticalAxis: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  longitudinalAxis: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  verticalInverted: z.boolean(),
  longitudinalInverted: z.boolean(),
  lateralInverted: z.boolean()
})

const rollAngleStyleSchema = z.object({
  color: z.string(),
  label: z.string(),
  labelColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number().default(12),
  smoothingMs: z.number(),
  maxAngleScale: z.number(),
  barColor: z.string(),
  showAccuracyCaveat: z.boolean(),
  useManualAxes: z.boolean(),
  verticalAxis: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  lateralAxis: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  verticalInverted: z.boolean(),
  lateralInverted: z.boolean()
})

const gForceDiagramWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('gForceDiagram'),
  ...transformFields,
  style: gForceDiagramStyleSchema
})

const rollAngleWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('rollAngle'),
  ...transformFields,
  style: rollAngleStyleSchema
})

const sessionSummaryStyleSchema = z.object({
  title: z.string(),
  showLastSeconds: z.number(),
  animationDurationMs: z.number(),
  unit: z.enum(['kmh', 'mph', 'kn']),
  color: z.string(),
  labelColor: z.string(),
  accentColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number()
})

const sessionSummaryWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('sessionSummary'),
  ...transformFields,
  style: sessionSummaryStyleSchema
})

const lapConsistencyStyleSchema = z.object({
  title: z.string(),
  maxLapsShown: z.number(),
  barColor: z.string(),
  bestLapColor: z.string(),
  labelColor: z.string(),
  showLapTimes: z.boolean(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number()
})

const lapConsistencyWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('lapConsistency'),
  ...transformFields,
  style: lapConsistencyStyleSchema
})

const customTextStyleSchema = z.object({
  text: z.string(),
  textColor: z.string(),
  textAlign: z.enum(['left', 'center', 'right']),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  imageDataUrl: z.string().nullable(),
  imageScale: z.number(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number()
})

const customTextWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('customText'),
  ...transformFields,
  style: customTextStyleSchema
})

const elevationStyleSchema = z.object({
  mode: z.enum(['readout', 'graph', 'both']),
  label: z.string(),
  unit: z.enum(['kmh', 'mph', 'kn']),
  color: z.string(),
  labelColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number(),
  smoothingMs: z.number(),
  graphLineColor: z.string(),
  graphFillOpacity: z.number(),
  gridColor: z.string(),
  gridOpacity: z.number()
})

const elevationWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('elevation'),
  ...transformFields,
  style: elevationStyleSchema
})

const distanceStyleSchema = z.object({
  label: z.string(),
  unit: z.enum(['kmh', 'mph', 'kn']),
  color: z.string(),
  labelColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number()
})

const distanceWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('distance'),
  ...transformFields,
  style: distanceStyleSchema
})

const compassStyleSchema = z.object({
  label: z.string(),
  color: z.string(),
  labelColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number(),
  smoothingMs: z.number()
})

const compassWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('compass'),
  ...transformFields,
  style: compassStyleSchema
})

const accelTimerStyleSchema = z.object({
  label: z.string(),
  unit: z.enum(['kmh', 'mph', 'kn']),
  targetSpeedsMps: z.array(z.number()),
  stationaryThresholdMps: z.number(),
  minStationaryMs: z.number(),
  showBest: z.boolean(),
  color: z.string(),
  labelColor: z.string(),
  bestColor: z.string(),
  textOutlineWidth: z.number(),
  textOutlineColor: z.string(),
  backgroundColor: z.string(),
  backgroundOpacity: z.number(),
  cornerRadius: z.number()
})

const accelTimerWidgetSchema = z.object({
  id: z.string(),
  type: z.literal('accelTimer'),
  ...transformFields,
  style: accelTimerStyleSchema
})

export const widgetSchema = z.discriminatedUnion('type', [
  gpsTrackWidgetSchema,
  speedometerAnalogWidgetSchema,
  speedometerDigitalWidgetSchema,
  timerWidgetSchema,
  sectorTimerWidgetSchema,
  deltaTimeWidgetSchema,
  predictiveLapTimerWidgetSchema,
  apexSpeedCalloutWidgetSchema,
  speedDistanceGraphWidgetSchema,
  gForceDiagramWidgetSchema,
  rollAngleWidgetSchema,
  sessionSummaryWidgetSchema,
  lapConsistencyWidgetSchema,
  customTextWidgetSchema,
  elevationWidgetSchema,
  distanceWidgetSchema,
  compassWidgetSchema,
  accelTimerWidgetSchema
])

export const videoMetaSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  durationMs: z.number(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  codec: z.string(),
  pixFmt: z.string(),
  hasAudio: z.boolean(),
  lrvPath: z.string().nullable().default(null)
})

export const clipInfoSchema = z.object({
  video: videoMetaSchema,
  startOffsetMs: z.number()
})

export const telemetrySampleSchema = z.object({
  cts: z.number(),
  lat: z.number(),
  lon: z.number(),
  altitude: z.number(),
  speed2D: z.number(),
  speed3D: z.number()
})

export const imuSampleSchema = z.object({
  cts: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number()
})

export const telemetryDataSchema = z.object({
  deviceName: z.string(),
  gpsStream: z.enum(['GPS5', 'GPS9']),
  samples: z.array(telemetrySampleSchema),
  videoDurationMs: z.number(),
  // .default([]) -- added after the telemetry cache format shipped, so an already-cached telemetry
  // JSON file (written before this change, with no IMU data at all) still parses.
  accel: z.array(imuSampleSchema).default([]),
  gyro: z.array(imuSampleSchema).default([]),
  gravity: z.array(imuSampleSchema).default([])
})

export const projectFileSchema = z.object({
  version: z.literal(2),
  id: z.string(),
  /** Ordered, contiguous clips making up the timeline (see shared/types.ts ClipInfo). */
  clips: z.array(clipInfoSchema),
  /** Filename of the sibling telemetry cache JSON, relative to the project file's own directory. */
  telemetryCacheFile: z.string(),
  widgets: z.array(widgetSchema),
  /** One start/finish line shared by every widget that needs lap/sector detection. */
  startFinish: latLonSchema.nullable(),
  // .default(...) -- added after the project file format shipped, so an already-saved project (which
  // always used the hardcoded default) still parses and keeps behaving exactly as it did before.
  startFinishRadiusM: z.number().default(DEFAULT_THRESHOLD_METERS),
  /** Manual per-crossing time corrections for the startFinish point above -- see
   *  shared/types.ts's CrossingAdjustments. */
  crossingAdjustmentsMs: crossingAdjustmentsSchema,
  /** Crossings manually deleted (a false lap detection) for the startFinish point above -- see
   *  shared/types.ts's CrossingIgnoreSet. */
  ignoredCrossings: ignoredCrossingsSchema,
  /** Whole-sequence trim, global ms spanning all clips. */
  trimStartMs: z.number(),
  trimEndMs: z.number(),
  /** Project-wide default font -- FORMULA1_FONT_ID or a real OS-installed font family name. Default
   *  keeps already-saved projects looking exactly as they did before this field existed. */
  defaultFontFamily: z.string().default(FORMULA1_FONT_ID)
})

export type ProjectFile = z.infer<typeof projectFileSchema>
export type TelemetryDataFile = z.infer<typeof telemetryDataSchema>

// --- v1 (single-clip) project files, kept only so old projects still open. ---
// v1 predates the `hasAudio` field on VideoMeta entirely, so its own video schema doesn't require it.
const videoMetaSchemaV1 = z.object({
  path: z.string(),
  fileName: z.string(),
  durationMs: z.number(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  codec: z.string(),
  pixFmt: z.string()
})

const projectFileSchemaV1 = z.object({
  version: z.literal(1),
  id: z.string(),
  sourceVideo: videoMetaSchemaV1,
  telemetryCacheFile: z.string(),
  widgets: z.array(widgetSchema),
  startFinish: latLonSchema.nullable()
})

/**
 * Parses a project file, migrating a v1 (single-clip) file into the current v2 (multi-clip) shape
 * on the fly rather than failing with a generic zod error -- an old project should keep opening,
 * just as a single-clip timeline with no trim. `hasAudio` isn't knowable from a v1 file without
 * re-probing the source (out of scope for a migration step); it's assumed `true` since that's the
 * overwhelmingly common case and the only consequence of a wrong guess is a slightly different
 * export audio-handling path, not a crash. `lrvPath` similarly isn't knowable without re-probing --
 * assumed absent (`null`), which just means the LRV-fallback preview tier is skipped for this clip,
 * same as any freshly-imported clip that genuinely has no sidecar proxy file.
 */
export function parseProjectFile(raw: unknown): ProjectFile {
  const v2 = projectFileSchema.safeParse(raw)
  if (v2.success) return v2.data

  const v1 = projectFileSchemaV1.safeParse(raw)
  if (v1.success) {
    const { sourceVideo, ...rest } = v1.data
    return {
      ...rest,
      version: 2,
      clips: [{ video: { ...sourceVideo, hasAudio: true, lrvPath: null }, startOffsetMs: 0 }],
      startFinishRadiusM: DEFAULT_THRESHOLD_METERS,
      crossingAdjustmentsMs: {},
      ignoredCrossings: {},
      trimStartMs: 0,
      trimEndMs: sourceVideo.durationMs,
      defaultFontFamily: FORMULA1_FONT_ID
    }
  }

  // Neither shape matched -- surface the v2 error (the current, primary schema) since that's the
  // most actionable message for a genuinely corrupted/unrecognized file.
  throw v2.error
}
