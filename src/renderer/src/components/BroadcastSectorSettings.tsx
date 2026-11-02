import { useState } from 'react'
import type { SectorTimerStyle } from '@shared/render/drawSectorTimer'

export default function BroadcastSectorSettings({ style, onChange }: {
  style: SectorTimerStyle
  onChange: (style: SectorTimerStyle) => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  return <>
    <label className="field"><span>Layout</span>
      <select value={style.layout ?? 'classic'} onChange={(e) => onChange({ ...style, layout: e.target.value as 'classic' | 'broadcast' })}>
        <option value="classic">Classic sectors</option><option value="broadcast">F1 broadcast card</option>
      </select>
    </label>
    {style.layout === 'broadcast' && <>
      <span className="field__hint">Compares with the fastest valid lap completed before this lap started. With one driver, a new personal best is also the session best (purple). Position and tyre are labels you set.</span>
      {(['driverName', 'positionLabel', 'teamLabel'] as const).map((key) => <label className="field" key={key}>
        <span>{{ driverName: 'Driver name', positionLabel: 'Position', teamLabel: 'Team initials (without logo)' }[key]}</span>
        <input type="text" maxLength={key === 'driverName' ? 60 : 8} value={style[key] ?? ''} onChange={(e) => onChange({ ...style, [key]: e.target.value })} />
      </label>)}
      <label className="field"><span>Tyre</span>
        <select value={style.tyre ?? ''} onChange={(e) => onChange({ ...style, tyre: e.target.value as SectorTimerStyle['tyre'] })}>
          <option value="">Hidden</option><option value="S">Soft (S)</option><option value="M">Medium (M)</option><option value="H">Hard (H)</option><option value="I">Intermediate (I)</option><option value="W">Wet (W)</option>
        </select>
      </label>
      <label className="field"><span>Team accent</span><input type="color" value={style.accentColor ?? '#3671c6'} onChange={(e) => onChange({ ...style, accentColor: e.target.value })} /></label>
      <label className="field"><span>Team logo</span><input type="file" accept="image/*" onChange={async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        setError(null)
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(file)
          })
          onChange({ ...style, headerImageDataUrl: dataUrl })
        } catch { setError('Could not read this logo. Please choose another image.') }
      }} /></label>
      {error && <span role="alert">{error}</span>}
      {style.headerImageDataUrl && <button onClick={() => onChange({ ...style, headerImageDataUrl: null })}>Remove logo</button>}
      {(['sectorHoldSeconds', 'lapHoldSeconds'] as const).map((key) => <label className="field" key={key}>
        <span>{key === 'sectorHoldSeconds' ? 'Sector result duration (seconds)' : 'Lap result duration (seconds)'}</span>
        <input type="number" min={0} max={60} step={0.5} value={style[key] ?? (key === 'sectorHoldSeconds' ? 5 : 3)} onChange={(e) => {
          const value = e.target.valueAsNumber
          if (Number.isFinite(value)) onChange({ ...style, [key]: Math.max(0, Math.min(60, value)) })
        }} />
      </label>)}
      <span className="field__hint">0 hides that popup. Lap results show the comparison, then the complete lap time within the chosen duration. The next lap keeps counting underneath. Card proportions stay fixed when resized. Set the shared fixed sector positions under Sectors &amp; Delta.</span>
    </>}
  </>
}
