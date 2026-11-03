import type { ExportFormat } from '../../shared/export/overlayExport'
import type { VideoEncoder } from './gpuEncoder'
import type { OverlayRoi } from './overlayRoi'

export function transparentEncoder(format: Exclude<ExportFormat, 'video'>): VideoEncoder {
  return {
    codec: format === 'qtrle' ? 'qtrle' : 'prores_ks',
    label: format === 'qtrle' ? 'Transparent MOV (Animation, CPU)' : 'Transparent MOV (ProRes 4444, CPU)',
    qualityArgs: () => [], bitrateArgs: () => []
  }
}

/** Unpremultiply RGB at higher precision while preserving the original alpha in its own branch.
 * Convert only the ROI, then pad to restore the preview's full-frame coordinates. */
export function transparentOverlayFilter(roi: OverlayRoi, width: number, height: number, prores: boolean): string {
  const alpha = 'split=2[pm][mask];[pm]format=gbrap16le,unpremultiply=inplace=1:planes=7,format=rgb24[rgb];[mask]alphaextract[a];[rgb][a]alphamerge'
  const padded = `${alpha},pad=${width}:${height}:${roi.x}:${roi.y}:color=black@0`
  return prores ? `${padded},scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva444p10le` : padded
}

export function buildTransparentOverlayArgs(
  settings: { width: number; height: number; fps: number }, roi: OverlayRoi, frames: number,
  format: Exclude<ExportFormat, 'video'>, outputPath: string
): string[] {
  const prores = format === 'prores4444'
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-filter_threads', '2',
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${roi.width}x${roi.height}`,
    '-framerate', String(settings.fps), '-i', 'pipe:0',
    '-vf', transparentOverlayFilter(roi, settings.width, settings.height, prores),
    '-frames:v', String(frames), '-an', '-c:v', prores ? 'prores_ks' : 'qtrle', '-threads', '2',
    ...(prores ? ['-profile:v', '4', '-alpha_bits', '16', '-pix_fmt', 'yuva444p10le',
      '-colorspace', 'bt709', '-color_range', 'tv'] : ['-pix_fmt', 'argb', '-colorspace', 'rgb', '-color_range', 'pc']),
    // Canvas colour values are sRGB. BT.709 shares its primaries, but not its transfer curve:
    // tagging these unchanged values as a camera/log or BT.709 transfer would alter graded HUDs.
    '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-movflags', '+write_colr',
    '-f', 'mov', outputPath
  ]
}
