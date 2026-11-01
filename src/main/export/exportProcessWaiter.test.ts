import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createExportProcessWaiter } from './exportProcessWaiter'

describe('bounded export process waiter', () => {
  it('observes a rejection before any frame wait is installed', async () => {
    const failure = new Error('ffmpeg failed')
    const waiter = createExportProcessWaiter(Promise.reject(failure), undefined, () => new Error('cancelled'))
    await new Promise(resolve => setImmediate(resolve))
    await expect(waiter.waitFor(Promise.resolve('frame'))).rejects.toBe(failure)
    waiter.dispose()
  })

  it('keeps one abort listener through many frames and removes it when finished', async () => {
    const controller = new AbortController()
    const waiter = createExportProcessWaiter(new Promise(() => {}), controller.signal, () => new Error('cancelled'))
    for (let frame = 0; frame < 1000; frame++) {
      expect(await waiter.waitFor(Promise.resolve(frame))).toBe(frame)
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    waiter.dispose()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('notices a signal already aborted before the waiter was created', async () => {
    const controller = new AbortController()
    controller.abort()
    const failure = new Error('cancelled')
    const waiter = createExportProcessWaiter(new Promise(() => {}), controller.signal, () => failure)
    await expect(waiter.waitFor(new Promise(() => {}))).rejects.toBe(failure)
    waiter.dispose()
  })
})
