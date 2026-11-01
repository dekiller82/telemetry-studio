import { describe, expect, it, vi } from 'vitest'
import type { ClipInfo, VideoMeta } from '../../shared/types'
import type { VideoEncoder } from './gpuEncoder'

// runExport.ts transitively imports frameRenderer.ts -> registerFonts.ts, which reads
// electron's `app` at MODULE LOAD time (app.isPackaged/app.getAppPath) -- stub it so this file
// (a plain Node/vitest environment, no real Electron) can import runExport.ts at all. vitest
// hoists vi.mock calls above the imports below, so this runs before they resolve. Never actually
// called by the buildFfmpegArgs/clipsOverlappingTrim logic under test here.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('./frameWorker?modulePath', () => ({ default: 'mock-frame-worker.js' }))

const { buildFfmpegArgs, clipsOverlappingTrim } = await import('./runExport')

function makeVideo(fileName: string, durationMs: number, overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    path: `C:\\Gopro\\${fileName}`,
    fileName,
    durationMs,
    fps: 30,
    width: 3840,
    height: 2160,
    codec: 'h264',
    pixFmt: 'yuv420p',
    hasAudio: true,
    lrvPath: null,
    ...overrides
  }
}

// Four clips of 300000ms each, back to back: [0,300000), [300000,600000), [600000,900000), [900000,1200000).
function fourClips(): ClipInfo[] {
  return [
    { video: makeVideo('GH010254.MP4', 300000), startOffsetMs: 0 },
    { video: makeVideo('GH020254.MP4', 300000), startOffsetMs: 300000 },
    { video: makeVideo('GH030254.MP4', 300000), startOffsetMs: 600000 },
    { video: makeVideo('GH040254.MP4', 300000), startOffsetMs: 900000 }
  ]
}

const CPU_ENCODER: VideoEncoder = {
  codec: 'libx264',
  qualityArgs: (crf) => ['-crf', String(crf)],
  bitrateArgs: (kbps) => ['-b:v', `${kbps}k`],
  label: 'CPU (libx264)'
}

describe('clipsOverlappingTrim', () => {
  const clips = fourClips()

  it('returns only the one middle clip a trim range falls entirely within', () => {
    // 444602-506518 falls entirely inside clip[1] ([300000, 600000)) -- the real bug report scenario.
    const result = clipsOverlappingTrim(clips, 444602, 506518)
    expect(result).toEqual([clips[1]])
  })

  it('returns every clip when the trim spans the whole session', () => {
    expect(clipsOverlappingTrim(clips, 0, 1200000)).toEqual(clips)
  })

  it('returns just the first clip when trim only shaves its start', () => {
    expect(clipsOverlappingTrim(clips, 50000, 1200000)).toEqual(clips)
  })

  it('returns clips spanning a trim that starts in one clip and ends in another', () => {
    // Starts inside clip[0], ends inside clip[2] -- clips 0,1,2 overlap; clip 3 does not.
    expect(clipsOverlappingTrim(clips, 250000, 650000)).toEqual([clips[0], clips[1], clips[2]])
  })

  it('excludes a clip the trim ends exactly at the start of', () => {
    expect(clipsOverlappingTrim(clips, 0, 300000)).toEqual([clips[0]])
  })

  it('excludes a clip the trim starts exactly at the end of', () => {
    expect(clipsOverlappingTrim(clips, 300000, 600000)).toEqual([clips[1]])
  })
})

describe('buildFfmpegArgs multi-clip trim', () => {
  const settings = { width: 3840, height: 2160, fps: 30, crf: 18 }

  it('takes the single-clip trim path (not a 4-input concat) when trim falls entirely within one middle clip', () => {
    const clips = fourClips()
    const args = buildFfmpegArgs(clips, settings, 444602, 506518, 1856, CPU_ENCODER, 'out.mp4')

    // Only ONE real clip input -- the previous bug fed all 4, forcing ffmpeg to decode/concat the
    // whole session just to throw away everything outside the trim range.
    const inputFlags = args.filter((_, i) => args[i - 1] === '-i')
    expect(inputFlags).toEqual(['C:\\Gopro\\GH020254.MP4', 'pipe:0'])

    // The start offset (144.602s into this clip) is applied as a fast `-ss` INPUT seek, not a
    // filter-graph trim -- a filter trim would decode the whole 144.602s prefix just to discard it
    // (confirmed directly: ~19s that way vs ~0.4s via -ss, for byte-identical output frames). -ss
    // must come before this clip's own -i.
    const clipInputIndex = args.indexOf('C:\\Gopro\\GH020254.MP4')
    expect(args[clipInputIndex - 1]).toBe('-i')
    expect(args[clipInputIndex - 3]).toBe('-ss')
    expect(args[clipInputIndex - 2]).toBe('144.602')

    // Only the END trim remains as a filter, relative to the SEEKED stream's own timeline (which
    // restarts at ~0): 206.518 - 144.602 = 61.916.
    const filterComplexIndex = args.indexOf('-filter_complex')
    const filterComplex = args[filterComplexIndex + 1]
    expect(filterComplex).toContain('trim=end=61.916')
    expect(filterComplex).not.toContain('start=')
    expect(filterComplex).not.toContain('concat=')
  })

  it('still concatenates just the overlapping subset when trim spans multiple clips, seeking into the first one', () => {
    const clips = fourClips()
    const args = buildFfmpegArgs(clips, settings, 250000, 650000, 12000, CPU_ENCODER, 'out.mp4')

    const inputFlags = args.filter((_, i) => args[i - 1] === '-i')
    expect(inputFlags).toEqual(['C:\\Gopro\\GH010254.MP4', 'C:\\Gopro\\GH020254.MP4', 'C:\\Gopro\\GH030254.MP4', 'pipe:0'])

    // 250000ms is 250s into clip[0] -- seeked via -ss, same as the single-clip case.
    const firstClipIndex = args.indexOf('C:\\Gopro\\GH010254.MP4')
    expect(args[firstClipIndex - 1]).toBe('-i')
    expect(args[firstClipIndex - 3]).toBe('-ss')
    expect(args[firstClipIndex - 2]).toBe('250')

    const filterComplexIndex = args.indexOf('-filter_complex')
    const filterComplex = args[filterComplexIndex + 1]
    expect(filterComplex).toContain('concat=n=3')
    // The first clip's own segment has no start= trim (handled by -ss above); the middle and last
    // clips are unaffected by this fix.
    expect(filterComplex).not.toContain('[0:v]trim=start=')
  })

  it('omits -ss entirely when the trim range starts exactly at a clip boundary (no prefix to skip)', () => {
    const clips = fourClips()
    // 300000ms is exactly clip[1]'s own start -- nothing to seek past.
    const args = buildFfmpegArgs(clips, settings, 300000, 650000, 12000, CPU_ENCODER, 'out.mp4')
    const firstClipIndex = args.indexOf('C:\\Gopro\\GH020254.MP4')
    expect(args[firstClipIndex - 2]).not.toBe('-ss')
  })

  it('uses the original byte-for-byte single-clip path when the project genuinely has only one clip', () => {
    const clip: ClipInfo = { video: makeVideo('GH010254.MP4', 300000), startOffsetMs: 0 }
    const args = buildFfmpegArgs([clip], settings, 0, 300000, 9000, CPU_ENCODER, 'out.mp4')
    const filterComplexIndex = args.indexOf('-filter_complex')
    expect(args[filterComplexIndex + 1]).not.toContain('trim=')
    expect(args).not.toContain('-ss')
  })

  it.each([
    { name: 'single untrimmed clip', start: 0, end: 300000, clips: [fourClips()[0]] },
    { name: 'trim within a middle clip', start: 444602, end: 506518, clips: fourClips() },
    { name: 'trim across multiple clips', start: 250000, end: 650000, clips: fourClips() }
  ])('preserves ROI positioning and premultiplied alpha for $name', ({ start, end, clips }) => {
    const roi = { x: 80, y: 40, width: 320, height: 180 }
    const args = buildFfmpegArgs(clips, settings, start, end, 100, CPU_ENCODER, 'out.mp4', roi)
    expect(args[args.indexOf('-s') + 1]).toBe('320x180')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('overlay=80:40:format=auto:alpha=premultiplied')
    expect(graph).not.toContain('overlay=0:0')
  })

  it('reports a useful error when the export range overlaps no input clip', () => {
    expect(() => buildFfmpegArgs(fourClips(), settings, 1300000, 1400000, 100, CPU_ENCODER, 'out.mp4'))
      .toThrow('No video clips overlap the export range')
  })

  it('limits CUDA decoder threads before every active video input, without limiting filters or encoding', () => {
    const encoder: VideoEncoder = { ...CPU_ENCODER, codec: 'h264_nvenc', decodeHwaccel: 'cuda' }
    const args = buildFfmpegArgs(fourClips(), settings, 250000, 650000, 100, encoder, 'out.mp4')
    for (const clip of fourClips().slice(0, 3)) {
      const index = args.indexOf(clip.video.path)
      const previousInput = args.lastIndexOf('-i', index - 2)
      const inputOptions = args.slice(previousInput + 2, index)
      expect(inputOptions).toContain('cuda')
      expect(inputOptions.slice(inputOptions.indexOf('-threads'), inputOptions.indexOf('-threads') + 2)).toEqual(['-threads', '4'])
    }
    const pipeIndex = args.indexOf('pipe:0')
    expect(args.slice(pipeIndex)).not.toContain('-threads')
    const cpuArgs = buildFfmpegArgs(fourClips(), settings, 250000, 650000, 100, CPU_ENCODER, 'out.mp4')
    expect(cpuArgs).not.toContain('-threads')
    expect(cpuArgs).not.toContain('-hwaccel')
  })
})
