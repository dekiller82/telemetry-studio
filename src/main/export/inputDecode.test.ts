import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
import { probeCudaInput } from './inputDecode'

let child: EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.useFakeTimers()
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit('close', 1)); return true })
  })
  mocks.spawn.mockReset().mockReturnValue(child)
})
afterEach(() => { vi.useRealTimers() })

describe('actual input CUDA probe', () => {
  it('requires a decoded CUDA frame and tolerates split progress lines', async () => {
    const result = probeCudaInput('ffmpeg', 'source.mp4', 200)
    child.stdout.write('frame=0\nframe=')
    child.stdout.write('1\nprogress=end\n')
    child.emit('close', 0)
    expect(await result).toEqual({ ok: true, reason: null })
    const args = mocks.spawn.mock.calls[0][1] as string[]
    expect(args.slice(args.indexOf('-threads'), args.indexOf('-threads') + 2)).toEqual(['-threads', '4'])
    expect(args).toContain('wrapped_avframe')
    expect(args.slice(args.indexOf('-hwaccel_output_format'), args.indexOf('-hwaccel_output_format') + 2)).toEqual(['-hwaccel_output_format', 'cuda'])
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '200'])
  })

  it.each([0, 1])('rejects empty/software fallback output even at exit code %i', async code => {
    const result = probeCudaInput('ffmpeg', 'empty.mp4', 0)
    child.stdout.write('frame=0\nprogress=end\n')
    child.emit('close', code)
    expect(await result).toEqual({ ok: false, reason: code ? 'process-error' : 'no-hardware-frame' })
  })

  it('kills and reaps a timed-out probe', async () => {
    const result = probeCudaInput('ffmpeg', 'source.mp4', 0, undefined, 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(await result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('interrupts a running probe on cancellation and removes its listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = probeCudaInput('ffmpeg', 'source.mp4', 0, controller.signal)
    controller.abort()
    await vi.runAllTimersAsync()
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('does not spawn a process after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await probeCudaInput('ffmpeg', 'source.mp4', 0, controller.signal)).toEqual({ ok: false, reason: 'cancelled' })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('handles process startup failure', async () => {
    const result = probeCudaInput('missing', 'source.mp4', 0)
    child.emit('error', new Error('ENOENT'))
    expect(await result).toEqual({ ok: false, reason: 'process-error' })
  })
})
