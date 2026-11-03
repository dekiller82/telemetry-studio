import { afterEach, describe, expect, it, vi } from 'vitest'

const install = vi.hoisted(() => vi.fn())
vi.mock('./reactPerformanceGuard', () => ({ installReactPerformanceGuard: install }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.resetModules()
})

describe('performance guard bootstrap', () => {
  it('installs the guard during development', async () => {
    vi.stubEnv('DEV', true)
    await import('./devPerformanceGuard')
    expect(install).toHaveBeenCalledExactlyOnceWith(performance)
  })

  it('does not replace the Performance API in production', async () => {
    vi.stubEnv('DEV', false)
    await import('./devPerformanceGuard')
    expect(install).not.toHaveBeenCalled()
  })
})
