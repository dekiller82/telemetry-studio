import { describe, expect, it } from 'vitest'
import { isDiskFullError } from './exportDiskSpace'

describe('isDiskFullError', () => {
  it('recognizes ffmpeg output that names the encoder on the same line', () => {
    expect(isDiskFullError({ stderrTail: '[vost#0:0/h264_nvenc @ 0] Error submitting a packet to the muxer: No space left on device' })).toBe(true)
  })

  it('recognizes the ENOSPC exit code, signed or as Windows reports it', () => {
    expect(isDiskFullError({ exitCode: -28, stderrTail: '' })).toBe(true)
    expect(isDiskFullError({ exitCode: 4294967268, stderrTail: '' })).toBe(true)
  })

  it('recognizes Node ENOSPC errors, including as a cause', () => {
    expect(isDiskFullError(Object.assign(new Error('write'), { code: 'ENOSPC' }))).toBe(true)
    expect(isDiskFullError(new Error('wrapped', { cause: { code: 'ENOSPC' } }))).toBe(true)
  })

  it('does not flag unrelated failures', () => {
    expect(isDiskFullError({ exitCode: 1, stderrTail: 'nvenc initialization failed' })).toBe(false)
    expect(isDiskFullError(new Error('Permission denied'))).toBe(false)
    expect(isDiskFullError(null)).toBe(false)
  })
})
