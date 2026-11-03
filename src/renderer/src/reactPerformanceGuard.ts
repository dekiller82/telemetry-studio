/**
 * React's development build records a PerformanceMeasure for every component update. In a video
 * editor these updates happen for several widgets on every frame. Chromium keeps the measures' rich
 * devtools details in native memory. During development, omit these rich React details and
 * clear the buffered entries so ordinary playback does not accumulate an entire editing session.
 * The DEV-only bootstrap runs before react-dom; unrelated measurements keep their original API.
 */
export function installReactPerformanceGuard(perf: Performance): () => void {
  const originalMeasure = perf.measure
  const nativeMeasure = originalMeasure.bind(perf)
  const measureWithBoundedReactEntries: Performance['measure'] = (name, startOrOptions, endMark) => {
    const options = typeof startOrOptions === 'object' && startOrOptions !== null ? startOrOptions : null
    const devtools = (options?.detail as { devtools?: { track?: string; trackGroup?: string } } | undefined)?.devtools
    if (devtools?.track === 'Components ⚛' || devtools?.trackGroup === 'Scheduler ⚛') {
      // Preserve the timing but omit React's ever-changing, often very large prop-diff details.
      // Clear the buffered entry immediately so the browser does not retain a frame-by-frame trace
      // for the entire editing session. Do not touch app/extension performance measurements.
      const entry = nativeMeasure(name, { start: options?.start, end: options?.end })
      perf.clearMeasures(name)
      return entry
    }
    return nativeMeasure(name, startOrOptions as string | PerformanceMeasureOptions, endMark)
  }
  perf.measure = measureWithBoundedReactEntries
  return () => {
    perf.measure = originalMeasure
  }
}
