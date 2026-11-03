import { describe, expect, it, vi } from 'vitest'
import { installReactPerformanceGuard } from './reactPerformanceGuard'

describe('React performance guard', () => {
  it('bounds React component and scheduler measurements without recording their prop details', () => {
    const measure = vi.fn(() => ({ name: 'entry' }) as PerformanceMeasure)
    const clearMeasures = vi.fn()
    const perf = { measure, clearMeasures } as unknown as Performance
    const restore = installReactPerformanceGuard(perf)

    const component = { start: 1, end: 2, detail: { devtools: { track: 'Components ⚛', properties: [['large', [1, 2, 3]]] } } }
    const scheduler = { start: 3, end: 4, detail: { devtools: { trackGroup: 'Scheduler ⚛', properties: [1] } } }
    perf.measure('WidgetCanvas', component)
    perf.measure('Blocking', scheduler)
    expect(measure).toHaveBeenNthCalledWith(1, 'WidgetCanvas', { start: 1, end: 2 })
    expect(measure).toHaveBeenNthCalledWith(2, 'Blocking', { start: 3, end: 4 })
    expect(clearMeasures).toHaveBeenCalledTimes(2)
    expect(clearMeasures).toHaveBeenNthCalledWith(1, 'WidgetCanvas')
    expect(clearMeasures).toHaveBeenNthCalledWith(2, 'Blocking')

    restore()
    expect(perf.measure).toBe(measure)
  })

  it('leaves unrelated measurements untouched', () => {
    const measure = vi.fn(() => ({ name: 'app' }) as PerformanceMeasure)
    const clearMeasures = vi.fn()
    const perf = { measure, clearMeasures } as unknown as Performance
    installReactPerformanceGuard(perf)
    const options = { start: 5, end: 6, detail: { source: 'export' } }
    perf.measure('export-render', options)
    expect(measure).toHaveBeenCalledWith('export-render', options, undefined)
    expect(clearMeasures).not.toHaveBeenCalled()
  })
})
