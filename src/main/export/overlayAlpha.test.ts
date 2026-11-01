import { spawnSync } from 'node:child_process'
import { createCanvas } from '@napi-rs/canvas'
import ffmpegPath from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { unpremultiplyRgbaInPlace } from './unpremultiply'

const width = 96
const height = 64

function composite(overlay: Buffer, background: string, alpha: 'straight' | 'premultiplied'): Buffer {
  if (!ffmpegPath) throw new Error('Bundled FFmpeg is missing')
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${background}:s=${width}x${height}:r=1`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', '1', '-i', 'pipe:0',
    '-filter_complex', `[1:v]format=rgba[ov];[0:v][ov]overlay=0:0:format=auto:alpha=${alpha}[v]`,
    '-map', '[v]', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'
  ]
  const result = spawnSync(ffmpegPath, args, { input: overlay, maxBuffer: 1024 * 1024 })
  if (result.status !== 0) throw new Error(`FFmpeg composition failed: ${result.stderr.toString()}`)
  expect(result.stdout.byteLength).toBe(width * height * 3)
  return result.stdout
}

describe('premultiplied export overlay', () => {
  it('keeps a frame snapshot stable after the Canvas is redrawn', () => {
    const canvas = createCanvas(2, 2)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgba(255, 0, 0, 0.25)'
    ctx.fillRect(0, 0, 2, 2)
    const snapshot = Buffer.from(canvas.data())
    expect(snapshot[0]).toBeGreaterThanOrEqual(62)
    expect(snapshot[0]).toBeLessThanOrEqual(64)
    expect(snapshot[3]).toBeGreaterThanOrEqual(62)

    ctx.clearRect(0, 0, 2, 2)
    expect(snapshot[0]).toBeGreaterThanOrEqual(62)
    expect(snapshot[3]).toBeGreaterThanOrEqual(62)
  })

  it('matches straight-alpha FFmpeg composition for translucent shapes and text', () => {
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgba(255, 50, 20, 0.25)'
    ctx.fillRect(0, 0, 45, height)
    const gradient = ctx.createLinearGradient(30, 0, 90, 0)
    gradient.addColorStop(0, 'rgba(0, 255, 255, 0)')
    gradient.addColorStop(1, 'rgba(0, 255, 255, 0.8)')
    ctx.fillStyle = gradient
    ctx.fillRect(30, 4, 60, 42)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)'
    ctx.font = '20px Arial'
    ctx.fillText('HUD', 50, 58)

    const premultiplied = Buffer.from(canvas.data())
    const straight = Buffer.from(premultiplied)
    unpremultiplyRgbaInPlace(straight)

    for (const background of ['0x202020', '0xe0e0e0']) {
      const oldOutput = composite(straight, background, 'straight')
      const newOutput = composite(premultiplied, background, 'premultiplied')
      let maxDifference = 0
      for (let i = 0; i < oldOutput.length; i++) {
        maxDifference = Math.max(maxDifference, Math.abs(oldOutput[i] - newOutput[i]))
      }
      // Different integer rounding in FFmpeg's two alpha paths can change a color by 1–2 levels.
      expect(maxDifference).toBeLessThanOrEqual(2)
    }
  }, 20_000)
})
