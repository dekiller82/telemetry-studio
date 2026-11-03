import { describe, expect, it } from 'vitest'
import { projectFileSchema, widgetSchema } from './schema'
import { createSectorTimerWidget } from '../widgets/defaults'

function legacyProject() {
  return {
    version: 2, id: 'legacy-timing', clips: [], telemetryCacheFile: 'telemetry.json',
    widgets: [createSectorTimerWidget()], startFinish: null, trimStartMs: 0, trimEndMs: 1000
  }
}

describe('timing settings and broadcast project compatibility', () => {
  it('opens older projects with automatic fixed markers, counted results and classic cards', () => {
    const raw = legacyProject()
    delete raw.widgets[0].style.layout
    delete raw.widgets[0].style.sectorHoldSeconds
    delete raw.widgets[0].style.lapHoldSeconds
    const project = projectFileSchema.parse(raw)
    expect(project.sectorTiming).toEqual({ s1: null, s2: null })
    expect(project.excludedLaps).toEqual({})
    expect(project.widgets[0]).toMatchObject({
      type: 'sectorTimer', style: { layout: 'classic', sectorHoldSeconds: 5, lapHoldSeconds: 3 }
    })
  })

  it('retains manual gates, exclusions and broadcast options through JSON serialization', () => {
    const project = {
      ...legacyProject(), sectorTiming: { s1: { lat: 30.001, lon: 106.001 }, s2: { lat: 30.002, lon: 106.002 } },
      excludedLaps: { '1000:61000': true },
      widgets: [{ ...createSectorTimerWidget(), style: {
        ...createSectorTimerWidget().style, layout: 'broadcast', driverName: 'DRIVER',
        sectorHoldSeconds: 7.5, lapHoldSeconds: 0
      } }]
    }
    expect(projectFileSchema.parse(JSON.parse(JSON.stringify(project)))).toMatchObject(project)
  })

  it.each([
    { s1: { lat: 91, lon: 106 }, s2: null },
    { s1: null, s2: { lat: 30, lon: 181 } },
    { s1: { lat: NaN, lon: 106 }, s2: null }
  ])('rejects out-of-range or non-finite sector coordinates', sectorTiming => {
    expect(projectFileSchema.safeParse({ ...legacyProject(), sectorTiming }).success).toBe(false)
  })

  it.each([-1, 61, Infinity])('rejects unsupported result durations (%s)', lapHoldSeconds => {
    const widget = createSectorTimerWidget()
    expect(widgetSchema.safeParse({ ...widget, style: { ...widget.style, lapHoldSeconds } }).success).toBe(false)
  })
})
