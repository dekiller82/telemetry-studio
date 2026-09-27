import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { orderAndValidateGoProClipPaths, parseGoProClipName } from './goproClipOrder'

describe('parseGoProClipName', () => {
  it('parses modern GoPro chapter and recording numbers', () => {
    expect(parseGoProClipName('GH021552.MP4')).toEqual({ chapter: 2, recordingId: '1552' })
    expect(parseGoProClipName('GX031553.mp4')).toEqual({ chapter: 3, recordingId: '1553' })
  })

  it('parses the legacy first-file GOPR name as chapter zero', () => {
    expect(parseGoProClipName('GOPR1552.MP4')).toEqual({ chapter: 0, recordingId: '1552' })
  })

  it('returns null for unrelated video names', () => {
    expect(parseGoProClipName('kart-session.mp4')).toBeNull()
  })
})

describe('orderAndValidateGoProClipPaths', () => {
  const dir = join('videos', '100GOPRO')

  it('sorts one recording by numeric chapter order', () => {
    const result = orderAndValidateGoProClipPaths([
      join(dir, 'GH031553.MP4'),
      join(dir, 'GH011553.MP4'),
      join(dir, 'GH021553.MP4')
    ])
    expect(result.map((filePath) => parseGoProClipName(filePath.split(/[\\/]/).at(-1)!)?.chapter)).toEqual([1, 2, 3])
  })

  it('treats directory casing consistently when grouping one recording', () => {
    const result = orderAndValidateGoProClipPaths([
      join('VIDEOS', '100GOPRO', 'GH021553.MP4'),
      join('videos', '100gopro', 'GH011553.MP4')
    ])
    expect(result.map((filePath) => parseGoProClipName(filePath.split(/[\\/]/).at(-1)!)?.chapter)).toEqual([1, 2])
  })

  it('rejects multiple recording ids instead of interleaving them alphabetically', () => {
    expect(() =>
      orderAndValidateGoProClipPaths([
        join(dir, 'GH011552.MP4'),
        join(dir, 'GH011553.MP4'),
        join(dir, 'GH021552.MP4'),
        join(dir, 'GH021553.MP4')
      ])
    ).toThrow(/multiple GoPro recordings[\s\S]*1552[\s\S]*1553[\s\S]*separate project/i)
  })

  it('rejects a missing chapter inside a selected recording', () => {
    expect(() =>
      orderAndValidateGoProClipPaths([join(dir, 'GH011553.MP4'), join(dir, 'GH031553.MP4')])
    ).toThrow(/missing chapter/i)
  })

  it('rejects duplicate chapters for one recording', () => {
    expect(() =>
      orderAndValidateGoProClipPaths([join(dir, 'GH011553.MP4'), join(dir, 'GX011553.MP4')])
    ).toThrow(/duplicate GoPro chapter/i)
  })

  it('keeps alphabetical fallback behavior for unknown naming schemes', () => {
    expect(orderAndValidateGoProClipPaths([join(dir, 'part-b.mp4'), join(dir, 'part-a.mp4')])).toEqual([
      join(dir, 'part-a.mp4'),
      join(dir, 'part-b.mp4')
    ])
  })
})
