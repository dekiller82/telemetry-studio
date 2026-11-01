import { app } from 'electron'
import path from 'path'
import { GlobalFonts } from '@napi-rs/canvas'
import { FORMULA1_BOLD, FORMULA1_REGULAR } from '../../shared/render/fonts'
import { loadSystemFontsIntoGlobalFonts } from '../app/systemFonts'

// These .otf files live under the renderer's source tree (not bundled by the main-process build,
// since nothing there imports them). @napi-rs/canvas is a native addon and can't read files packed
// inside app.asar, so in a packaged build electron-builder copies this folder out to
// resources/fonts (see the "extraResources" entry in package.json's "build" config) and it's
// resolved via process.resourcesPath instead of the (asar-relative) app path.
// Keep the module importable by a plain Node/Vitest process as well as Electron's main process.
// Production still uses Electron's packaged/resource paths; the process.cwd() fallback is only for
// tests and tooling that invoke the renderer-independent export code without an Electron app object.
const FONTS_DIR = app?.isPackaged
  ? path.join(process.resourcesPath, 'fonts')
  : path.join(app?.getAppPath?.() ?? process.cwd(), 'src/renderer/src/fonts')

export function getExportFontsDirectory(): string {
  return FONTS_DIR
}

/** Idempotent -- safe to call multiple times (e.g. once per export) without re-registering. */
export function registerExportFonts(fontsDirectory = FONTS_DIR): void {
  if (!GlobalFonts.has(FORMULA1_REGULAR)) {
    GlobalFonts.registerFromPath(path.join(fontsDirectory, 'Formula1-Regular.otf'), FORMULA1_REGULAR)
  }
  if (!GlobalFonts.has(FORMULA1_BOLD)) {
    GlobalFonts.registerFromPath(path.join(fontsDirectory, 'Formula1-Bold.otf'), FORMULA1_BOLD)
  }
  // Makes real OS-installed fonts (a global/per-widget font choice) available to @napi-rs/canvas
  // during export, not just the bundled Formula1 pair -- also idempotent.
  loadSystemFontsIntoGlobalFonts()
}
