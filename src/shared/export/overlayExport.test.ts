import { describe, expect, it } from 'vitest'
import { DEFAULT_RENDER_WORKERS, exportWidgets, overlayExportRequestSchema } from './overlayExport'
import { createSectorTimerWidget, createGpsTrackWidget } from '../widgets/defaults'

describe('transparent export selection and request validation', () => {
  it('keeps full widgets and transforms unless a transparent subset is explicitly requested', () => {
    const widgets = [createGpsTrackWidget(), createSectorTimerWidget()]
    expect(exportWidgets(widgets, { format: 'video', widgetIds: [] })).toBe(widgets)
    expect(exportWidgets(widgets, { format: 'qtrle' })).toBe(widgets)
    const selected = exportWidgets(widgets, { format: 'qtrle', widgetIds: [widgets[1].id] })
    expect(selected).toEqual([widgets[1]])
    expect(selected[0]).toBe(widgets[1])
    expect(() => exportWidgets(widgets, { format: 'qtrle', widgetIds: [] })).toThrow('Select')
    expect(() => exportWidgets(widgets, { format: 'qtrle', widgetIds: ['missing'] })).toThrow('Select')
  })
  it('rejects unsupported formats and defaults old callers to ordinary video', () => {
    expect(overlayExportRequestSchema.parse({}).format).toBe('video')
    expect(overlayExportRequestSchema.safeParse({ format: 'mp4-alpha' }).success).toBe(false)
  })
  it('accepts only bounded worker counts while preserving old export requests', () => {
    expect(overlayExportRequestSchema.parse({}).renderWorkers).toBeUndefined()
    expect(DEFAULT_RENDER_WORKERS).toBe(2)
    for (const renderWorkers of [1, 2, 3, 4]) expect(overlayExportRequestSchema.parse({ renderWorkers }).renderWorkers).toBe(renderWorkers)
    for (const renderWorkers of [0, 5, -1, 2.5, '4', null, Infinity]) expect(overlayExportRequestSchema.safeParse({ renderWorkers }).success).toBe(false)
  })
})
