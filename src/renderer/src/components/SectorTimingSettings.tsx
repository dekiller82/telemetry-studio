import { memo, useEffect, useMemo, useState } from 'react'
import type { LatLon } from '@shared/types'
import { detectLapTiming, nearestLatLon } from '@shared/telemetry/laps'
import { computeTrackTiming, type TrackTimingModel } from '@shared/telemetry/trackTiming'
import { useProjectStore } from '../store/projectStore'

const TimingMap = memo(function TimingMap({ model }: { model: TrackTimingModel }): React.JSX.Element | null {
  const points = model.route
  if (!points.length) return null
  const cos = Math.cos(points[0].lat * Math.PI / 180)
  const xs = points.map((p) => p.lon * cos), ys = points.map((p) => p.lat)
  const left = Math.min(...xs), top = Math.max(...ys)
  const scale = Math.min(260 / Math.max(1e-9, Math.max(...xs) - left), 140 / Math.max(1e-9, top - Math.min(...ys)))
  const pos = (p: LatLon): [number, number] => [20 + (p.lon * cos - left) * scale, 20 + (top - p.lat) * scale]
  const markers = [{ label: 'S3 / Finish', point: points[0], color: '#ffffff' },
    ...(model.gates ? [{ label: 'S1', point: model.gates.s1, color: '#ffd60a' }, { label: 'S2', point: model.gates.s2, color: '#3ddc71' }] : [])]
  return <svg viewBox="0 0 310 180" className="sector-timing-map" role="img" aria-label="Fixed sector locations on the reference circuit">
    <polyline points={points.map((p) => pos(p).join(',')).join(' ')} fill="none" stroke="#8d929c" strokeWidth="2" />
    {markers.map(({ label, point, color }) => {
      const [x, y] = pos(point)
      return <g key={label}><circle cx={x} cy={y} r="4" fill={color} stroke="#17171b" strokeWidth="2" />
        <text x={x > 230 ? x - 6 : x + 6} y={y < 18 ? y + 15 : y - 6} textAnchor={x > 230 ? 'end' : 'start'} fill={color} fontSize="11">{label}</text></g>
    })}
  </svg>
})

function MarkerEditor({ label, point, manual, current, onChange }: {
  label: string; point: LatLon | null; manual: boolean; current: LatLon | null; onChange: (p: LatLon | null) => void
}): React.JSX.Element {
  const [lat, setLat] = useState(''), [lon, setLon] = useState('')
  useEffect(() => { setLat(point?.lat.toFixed(7) ?? ''); setLon(point?.lon.toFixed(7) ?? '') }, [point?.lat, point?.lon])
  const valid = lat.trim() !== '' && lon.trim() !== '' && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) &&
    Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180
  return <div className="sector-marker-editor">
    <span className="field__hint">{label} · {manual ? 'Manual position' : 'Fixed automatic position'}</span>
    <div className="property-panel__add-row">
      <button className="property-panel__add" disabled={!current} onClick={() => current && onChange(current)}>Set {label} here</button>
      {manual && <button className="property-panel__delete" onClick={() => onChange(null)}>Auto</button>}
    </div>
    <form onSubmit={(event) => { event.preventDefault(); if (valid) onChange({ lat: Number(lat), lon: Number(lon) }) }}>
      <div className="sector-marker-coordinates">
        <label className="field"><span>Latitude</span><input type="number" step="any" min={-90} max={90} aria-label={`${label} latitude`} value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" /></label>
        <label className="field"><span>Longitude</span><input type="number" step="any" min={-180} max={180} aria-label={`${label} longitude`} value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" /></label>
      </div>
      <button className="property-panel__add" type="submit" disabled={!valid}>Apply {label} coordinates</button>
    </form>
  </div>
}

export default function SectorTimingSettings(): React.JSX.Element {
  const imported = useProjectStore((s) => s.imported)
  const startFinish = useProjectStore((s) => s.startFinish)
  const radius = useProjectStore((s) => s.startFinishRadiusM)
  const adjustments = useProjectStore((s) => s.crossingAdjustmentsMs)
  const ignored = useProjectStore((s) => s.ignoredCrossings)
  const excludedLaps = useProjectStore((s) => s.excludedLaps)
  const settings = useProjectStore((s) => s.sectorTiming)
  const setSettings = useProjectStore((s) => s.setSectorTiming)
  const setFinish = useProjectStore((s) => s.setStartFinish)
  const cts = useProjectStore((s) => s.currentTimeMs)
  const model = useMemo(() => {
    if (!imported || !startFinish) return null
    const detected = detectLapTiming(imported.telemetry.samples, startFinish, radius, adjustments, ignored, excludedLaps)
    return computeTrackTiming(imported.telemetry.samples, detected.crossings, settings, detected.excludedLapNumbers)
  }, [imported, startFinish, radius, adjustments, ignored, settings, excludedLaps])
  const current = imported ? nearestLatLon(imported.telemetry.samples, cts) : null
  const lap = model?.laps.find((l) => cts >= l.start && (cts < l.end || (!l.completed && cts === l.end)))
  return <div className="property-panel__section">
    <div className="property-panel__header"><span>Sectors &amp; Delta</span></div>
    <span className="field__hint">Sector Timer, Delta Time and Predicted Lap share fixed track positions and the same fastest valid reference lap. Pause at a sector line, then set its position.</span>
    {!startFinish && <span className="field__hint">Set the start/finish line above first.</span>}
    {model && <>
      <TimingMap model={model} />
      <span className="field__hint">{model.referenceLapNumber !== null ? `Fixed circuit from lap ${model.referenceLapNumber} (${model.routeLengthM.toFixed(0)} m).` : ''}</span>
      {model.error && <p className="sector-timing-error" role="status">{model.error}</p>}
      {lap?.reason && cts > lap.validUntil && <p className="sector-timing-error" role="status">Timing unavailable: {lap.reason.replaceAll('-', ' ')}. This interval cannot be a reference lap.</p>}
      {lap?.excluded && <p className="field__hint" role="status">Lap {lap.lapNumber} is manually excluded from results. Restore it in Lap results below the video.</p>}
      {lap?.longStopAt != null && cts >= lap.longStopAt && <p className="field__hint" role="status">Slow/stopped for at least 10 s. This is a suggestion only; use Lap results to decide whether this lap counts.</p>}
      <MarkerEditor label="S1 end" point={settings.s1 ?? model.gates?.s1 ?? null} manual={!!settings.s1} current={current}
        onChange={(s1) => setSettings({ ...settings, s1 })} />
      <MarkerEditor label="S2 end" point={settings.s2 ?? model.gates?.s2 ?? null} manual={!!settings.s2} current={current}
        onChange={(s2) => setSettings({ ...settings, s2 })} />
      <div className="sector-marker-editor">
        <span className="field__hint">S3 end = lap start/finish. Changing this also changes lap detection.</span>
        <button className="property-panel__add" disabled={!current} onClick={() => current && setFinish(current)}>Set S3 / finish here</button>
      </div>
      {!current && <span className="field__hint">No reliable GPS at the current frame. Choose a frame with GPS to set a marker.</span>}
    </>}
  </div>
}
