import type { CrossingAdjustments, CrossingIgnoreSet, LapExclusionSet, LatLon, SectorTimingSettings, TelemetryData, WidgetInstance } from '../../shared/types'

export interface FrameWorkerData {
  width: number
  height: number
  widgets: WidgetInstance[]
  telemetry: TelemetryData
  startFinish: LatLon | null
  startFinishRadiusM: number
  sectorTiming?: SectorTimingSettings
  excludedLaps?: LapExclusionSet
  crossingAdjustmentsMs: CrossingAdjustments
  ignoredCrossings: CrossingIgnoreSet
  trimStartMs: number
  trimEndMs: number
  defaultFontFamily: string
  assetDirectories: { fonts: string; icons: string }
}

export interface FrameRequest {
  kind: 'render'
  index: number
  sampleCts: number
  elapsedMs: number
}

export type FrameResponse =
  | { kind: 'ready' }
  | { kind: 'frame'; index: number; pixels: Uint8Array; renderMs: number }
  | { kind: 'error'; message: string; stack?: string }
