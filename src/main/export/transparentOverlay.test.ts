import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCanvas } from '@napi-rs/canvas'
import ffmpegPath from 'ffmpeg-static'
import ffprobe from 'ffprobe-static'
import { describe, expect, it } from 'vitest'
import { buildTransparentOverlayArgs } from './transparentOverlay'
import { attemptOutputPath, assertTransparentOutputContainer } from './exportOutput'

describe('transparent MOV export through bundled FFmpeg', () => {
  it.each(['qtrle', 'prores4444'] as const)('preserves alpha, colours, full-frame placement and exact timing: %s', (format) => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-alpha-test-'))
    const output = join(dir, 'overlay.mov')
    const width = 128, height = 80
    const roi = { x: 24, y: 16, width: 80, height: 48 }
    const canvas = createCanvas(roi.width, roi.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgba(40, 180, 110, 0.4)'
    ctx.fillRect(0, 0, 80, 48)
    ctx.fillStyle = '#c754ef'
    ctx.fillRect(12, 8, 24, 24)
    ctx.fillStyle = 'rgba(255, 225, 50, 0.75)'
    ctx.beginPath(); ctx.arc(55, 24, 15, 0, Math.PI * 2); ctx.fill()
    const frame = Buffer.from(canvas.data())
    try {
      const args = buildTransparentOverlayArgs({ width, height, fps: 50 }, roi, 4, format, output)
      const encoded = spawnSync(ffmpegPath!, args, { input: Buffer.concat([frame, frame, frame, frame]), timeout: 15000 })
      expect(encoded.error).toBeUndefined()
      expect(encoded.status, encoded.stderr.toString()).toBe(0)
      expect(readFileSync(output).byteLength).toBeGreaterThan(0)
      const probe = spawnSync(ffprobe.path, ['-v', 'error', '-show_streams', '-of', 'json', output])
      expect(probe.status).toBe(0)
      const streams = JSON.parse(probe.stdout.toString()).streams
      expect(streams).toHaveLength(1)
      expect(streams[0]).toMatchObject({ width, height, r_frame_rate: '50/1', nb_frames: '4', start_time: '0.000000' })
      expect(streams[0].codec_name).toBe(format === 'qtrle' ? 'qtrle' : 'prores')
      expect(streams[0].color_space).toBe(format === 'qtrle' ? 'gbr' : 'bt709')
      expect(streams[0].color_transfer).toBe('iec61966-2-1')
      expect(streams[0].color_primaries).toBe('bt709')
      expect(Number(streams[0].duration)).toBeCloseTo(0.08, 6)
      const decoded = spawnSync(ffmpegPath!, ['-v', 'error', '-i', output, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'])
      expect(decoded.status, decoded.stderr.toString()).toBe(0)
      expect(decoded.stdout.length).toBe(width * height * 4)
      let maxAlphaError = 0, maxCompositeError = 0
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const inside = x >= roi.x && x < roi.x + roi.width && y >= roi.y && y < roi.y + roi.height
        const src = ((y - roi.y) * roi.width + x - roi.x) * 4
        const dst = (y * width + x) * 4
        const expectedAlpha = inside ? frame[src + 3] : 0
        const actualAlpha = decoded.stdout[dst + 3]
        maxAlphaError = Math.max(maxAlphaError, Math.abs(actualAlpha - expectedAlpha))
        for (const background of [0, 255]) for (let channel = 0; channel < 3; channel++) {
          const expected = (inside ? frame[src + channel] : 0) + background * (1 - expectedAlpha / 255)
          const actual = decoded.stdout[dst + channel] * actualAlpha / 255 + background * (1 - actualAlpha / 255)
          maxCompositeError = Math.max(maxCompositeError, Math.abs(expected - actual))
        }
      }
      expect(maxAlphaError).toBeLessThanOrEqual(format === 'qtrle' ? 0 : 1)
      expect(maxCompositeError).toBeLessThanOrEqual(format === 'qtrle' ? 1.1 : 4)
    } finally {
      try { unlinkSync(output) } catch { /* Encode may fail before output creation. */ }
      rmdirSync(dir)
    }
  }, 20000)

  it('does not open camera inputs or discard alpha and preserves the temporary container suffix', () => {
    const args = buildTransparentOverlayArgs({ width: 2704, height: 1520, fps: 50 }, { x: 10, y: 20, width: 640, height: 300 }, 10, 'qtrle', 'out.mov')
    expect(args.filter(arg => arg === '-i')).toHaveLength(1)
    expect(args).not.toContain('yuv420p')
    expect(args.join(' ')).toContain('pad=2704:1520:10:20:color=black@0')
    expect(attemptOutputPath('out.mov', 'job', 1)).toMatch(/\.tmp\.mov$/)
    expect(attemptOutputPath('out.mp4', 'job', 1)).toMatch(/\.tmp\.mp4$/)
    expect(() => assertTransparentOutputContainer('out.MOV')).not.toThrow()
    expect(() => assertTransparentOutputContainer('out.mp4')).toThrow('.mov')
    expect(() => assertTransparentOutputContainer('out')).toThrow('.mov')
  })
})
