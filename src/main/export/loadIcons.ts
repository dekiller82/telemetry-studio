import { app } from 'electron'
import path from 'path'
import { loadImage, type Image } from '@napi-rs/canvas'

// Bundled asset, not user-provided -- lives under the renderer's source tree same as the fonts
// (see registerFonts.ts for why packaged builds resolve this via process.resourcesPath instead).
// Keep this module importable by plain Node/Vitest smoke tests. Electron's paths remain the source
// of truth in the packaged app; process.cwd() is only a development/test fallback.
const ICONS_DIR = app?.isPackaged
  ? path.join(process.resourcesPath, 'icons')
  : path.join(app?.getAppPath?.() ?? process.cwd(), 'src/renderer/src/icons')

export function getExportIconsDirectory(): string {
  return ICONS_DIR
}

const fastestLapIcons = new Map<string, Promise<Image>>()

/** Loaded once and cached for the life of the process -- it's a fixed bundled asset, not per-widget. */
export function loadFastestLapIcon(iconsDirectory = ICONS_DIR): Promise<Image> {
  let icon = fastestLapIcons.get(iconsDirectory)
  if (!icon) {
    icon = loadImage(path.join(iconsDirectory, 'fl.png'))
    fastestLapIcons.set(iconsDirectory, icon)
  }
  return icon
}
