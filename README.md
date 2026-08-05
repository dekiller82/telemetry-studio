# Telemetry Studio

A desktop editor for burning GoPro telemetry (GPS, speed, lean angle, G-forces, lap/sector
timing…) directly into your video as a rendered overlay. No cloud upload, no subscription!! Import
one or more GoPro clips, drag widgets onto the frame, and export a finished MP4 with everything
baked in.

Built with Electron, React, and TypeScript. Runs on Windows, macOS, and Linux.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Demo

![Telemetry Studio demo](docs/demo.gif)

**[▶ Watch the full demo video with audio](https://youtu.be/YtDYg4stG4M)**

Shows the GPS track, sector timer, timing tower, delta time, apex speed callout, and digital
speedometer widgets running together over real footage.

## Features

- **Multi-clip import** — select every part of a chapter-split GoPro recording
  (`GH010230.MP4`, `GH020230.MP4`, ...) at once; they're stitched into a single timeline with
  continuous telemetry.
- **18 widgets** (17 telemetry-driven, plus a freeform text/logo widget), each fully configurable
  (colors, fonts, size, smoothing) via the property panel — see [Widgets](#widgets) below for what
  each one shows and its own options.
- **Font picker** — a project-wide default font (Project Settings, in the File menu), picked from
  your real OS-installed fonts alongside the built-in Formula1 look, with a per-widget override
  available in each widget's own Style panel.
- **Lap & sector detection** from a start/finish line you place on the GPS track — everything
  (timer, sector timer, delta time, predictive lap timer, speed graph, session summary, lap
  consistency) derives from it automatically.
- **Timeline lap navigation** — a "Jump to fastest lap" button, a clickable marker for every
  detected lap on the scrub bar (hover for the lap number and time), and a speed sparkline strip
  under the timeline so you can spot braking zones/corners without scrubbing blind.
- **Whole-layout color themes** — recolor every widget currently on the frame in one click from a
  small set of built-in palettes; only touches color fields, never position/size, and leaves
  semantic colors (faster/slower, braking/accelerating) alone.
- **Widget lock** — pin a widget's position/size so it can't be accidentally dragged or resized
  while working on neighbors, still editable in the property panel.
- **Multi-select** — shift-click widgets (on the canvas or in the widget list) to build a
  selection; drag any member to move the whole group together, and align/center/delete/arrow-key
  nudge all apply to the whole selection at once.
- **Widget alignment tools** — snap-to-edge/center dragging (against the frame's own edges/center
  *and* other widgets' edges/centers, whichever's closer) with configurable padding, one-click
  align/center buttons, and arrow-key nudge (1px, 10px with Shift) for pixel-precise placement.
- **Per-lap start/finish crossing nudge** — the automatic lap-crossing detection can register a
  crossing a few frames early or late on a given lap; click a lap marker on the timeline to select
  it, then nudge it ±1 frame with a live offset readout and a Reset button. Every widget, live
  preview and export alike, reflects the correction immediately.
- **Select all** — Ctrl/Cmd+A selects every widget on the canvas, ready for group move/align/delete.
- **Drag/resize/rotate** every widget directly on the video preview; live preview matches the
  final export exactly.
- **Undo/redo** for every widget edit, saveable/re-applicable widget layout presets, and autosave
  with crash recovery.
- **Export just your fastest lap** as its own short clip, with configurable padding (seconds
  before/after) — doesn't touch your project's actual saved trim range.
- **Delivery presets** — a dropdown next to Export Video bundles resolution + bitrate for YouTube
  (4K/1080p), Instagram/TikTok/Reels, and Twitter/X, alongside the default native-resolution
  "Source quality" export.
- **Recent Projects** list on the start screen for one-click reopening of your last 10
  opened/saved projects.
- **Project files** (`.gpo`) save the full editing state (imported clips, widgets, trim, start/finish
  line) so you can come back and keep editing.
- **In-app "What's New" viewer** and an **in-app updater** — the changelog shows automatically once
  per new version (reopenable anytime from the toolbar), and a dismissible banner appears if a newer
  release is available on GitHub. On Windows and Linux, that banner can download and install the
  update for you (progress bar, then Restart & Install) instead of only linking to the Releases page.
  macOS keeps the link-out-only banner — Apple's Gatekeeper requires a paid Developer ID to
  auto-update at all, which this project doesn't have.
- **Keyboard shortcuts & getting-started panel** — press `?` (or click the toolbar's `?` button, or
  from the welcome screen before importing anything) for a reference list of every shortcut plus a
  short written walkthrough of the core workflow.
- **Export locks the editor, can be cancelled, and notifies you when done** — widgets and the
  property panel become read-only for the duration of an export (the export already renders from an
  independent snapshot taken the instant you click Export, so this is just about removing ambiguity,
  not a correctness fix); a Cancel button stops ffmpeg outright and cleans up the partial file; and a
  native OS notification fires if the window isn't focused when it finishes.
- **GPU-accelerated export** — automatically detects and smoke-tests a working hardware encoder
  (NVIDIA NVENC, Intel Quick Sync, AMD AMF) before trusting it, falling back to CPU (libx264) if
  none is available or the GPU encoder fails partway through. See [GPU acceleration](#gpu-acceleration)
  below for exactly what's accelerated on which vendor.

## Widgets

Every widget is drag/resize/rotate-able on the preview and shares a common set of options where it
makes sense: a text outline width/color, and (for panel-style widgets) a background color/opacity.
Lap/sector-dependent widgets all key off the single start/finish point you place on the GPS track.

- **GPS track map** — the full track outline with a moving position dot. Three coloring modes:
  `solid` (one color), `speed` (gradient between a slow/fast color, scaled to this session's own
  min/max speed), or `braking` (segments colored by braking/accelerating/neutral, with an adjustable
  G-force threshold for what counts as "braking"). Dot color, radius, and an optional glow are
  configurable separately from the line. An optional **ghost marker** shows your fastest completed
  lap's own position at the same elapsed time into its lap, once one exists to compare against —
  a real spatial ahead/behind gap, not just a number. A **zoomed window view mode** keeps the
  current position centered and zoomed in to an adjustable radius instead of always fitting the
  whole track to the widget, so a close gap to the ghost marker is actually visible.

- **Speedometer (analog & digital)** — current speed in km/h or mph, Gaussian-smoothed to damp GPS
  jitter (smoothing window is adjustable). The analog gauge has its own configurable min/max scale;
  color, accent color, and the unit label can all be toggled/recolored.

- **Timer** — two modes. `elapsed` is a plain running-time readout (color, centiseconds on/off,
  optional label). `laps` is a full F1-style timing tower: upload your own header logo (or use the
  bundled default) with an adjustable scale, set custom header text, choose `ranked` (fastest-to-slowest)
  or `chronological` row order (with newest-on-top or -bottom), and a fixed visible row count so the
  tower never resizes as laps come in.

- **Sector timer** — auto-divides each lap into three sectors by GPS arc-length (no manual marking
  needed). A sector turns **purple** the moment it ties or beats your best-ever time for that
  specific sector, even mid-lap. An optional secondary row shows the last fully completed lap's own
  S1/S2/S3 for direct comparison.

- **Delta time** — your in-progress lap's time vs. your fastest *completed* lap, compared at the
  same distance into the lap (not the same elapsed time, which would be meaningless once pace
  diverges). Separate colors for ahead/behind/no-baseline-yet, optional label.

- **Predictive lap timer** — projects a finishing time for the current lap at your current pace
  (baseline lap time + live delta). Can show a small +/- sub-readout using the same color convention
  as the Delta Time widget.

- **Apex speed callout** — detects real corner apexes (a genuine speed dip, not GPS noise) and
  flashes the minimum speed reached. Tunable detection: minimum speed drop required on both sides of
  the dip, minimum gap between consecutive apexes, and how long each callout stays on screen.

- **Speed/distance graph** — two view modes. `fullLap` draws each of the last N laps across its
  entire distance, each in its own color. `window` instead scrolls to keep your current position
  centered, showing only a band of track behind/ahead of you (width adjustable in meters) — every
  prior lap is drawn in one shared neutral reference color so the only thing that stands out is
  whether your current line is running above or below the pack right at that exact spot on track.
  Number of laps shown, current-lap highlighting, and grid styling are all configurable.

- **G-Force friction circle** — plots lateral (cornering) vs. longitudinal (braking/accelerating) G
  on a ring-gridded scatter, with a fading trail behind the current smoothed reading (trail duration,
  smoothing window, grid radius in G, and all colors are adjustable), plus a numeric combined-G
  readout above the diagram and independently-toggleable ACCEL/BRAKE/LEFT/RIGHT axis labels. Axis
  mapping is auto-calibrated per import from the accelerometer + GPS; a manual override (pick the
  vertical and longitudinal axis index, invert any axis) is available if auto-calibration picks the
  wrong one.

- **Roll / lean angle** — a numeric readout plus a tilting horizon bar (degrees-per-full-swing is
  adjustable). Uses the camera's gravity-vector stream when present, falling back to an
  accelerometer-tilt estimate on older footage (with an optional on-screen accuracy note — see
  [Known limitations](#known-limitations)). Shares the same axis auto-calibration/manual-override
  pattern as the G-Force widget.

- **Session summary** — an end-of-session outro card with an eased opening animation, shown for a
  configurable number of seconds before the end of the trim range. Displays lap count, best
  lap/sector splits, top speed, distance covered, and elapsed time — the session's true final
  totals throughout the reveal, not a live-ticking readout.

- **Lap consistency** — a bar chart of your most recent completed laps; a taller bar means a
  relatively faster lap (scaled between the shown laps' own fastest/slowest), fastest lap
  highlighted in its own color.

- **Custom Text/Logo** — the one widget not derived from telemetry at all: freeform multi-line
  text (driver name, event title, sponsor watermark) and/or an uploaded image, stacked
  image-above-text when both are set.

- **Elevation** — current altitude readout and/or a distance-based elevation profile for the whole
  session (readout, graph, or both, independently toggleable), with a moving marker showing where
  you are on the profile right now. Most useful for hillclimbs/rally; on a flat closed circuit it'll
  understandably look close to a flat line.

- **Distance** — a live running total of GPS arc-length covered since the start of the recording,
  for keeping a distance counter on screen the whole session instead of only seeing a final total on
  the Session Summary card.

- **Compass/Heading** — a digital "047° NE" readout of your direction of travel, from GPS
  course-over-ground (GoPro cameras have no magnetometer, so this is which way you're moving, not
  which way the camera physically faces — and reads meaninglessly while stationary).

- **Acceleration Timer** — a Dragy-style launch timer: auto-detects a genuine stop followed by
  acceleration and times how long it takes to reach each of your own configured target speeds (not
  Dragy's fixed highway splits — karts don't reach highway speeds), keeping a session-best per target
  alongside the current run. Tunable stationary-speed threshold and minimum stop duration in case a
  slow corner on your track needs to be told apart from a real stop.

## Requirements

- Real GoPro footage with embedded GPMF telemetry (GPS is required! ; the G-Force
  and Roll/Lean widgets need the accelerometer/gyroscope streams present on Hero5 and later; the
  gravity-vector stream used for the most accurate roll reading is only present on newer cameras —
  older footage automatically falls back to an accelerometer-tilt estimate, see
  [Known limitations](#known-limitations)).
- Windows 10+, macOS 11+, or a recent Linux desktop.

## Installing

Download the installer for your platform from the
[Releases page](https://github.com/dekiller82/telemetry-studio/releases):

- **Windows** — `.exe` installer or the portable `.exe`
- **macOS** — `.dmg`
- **Linux** — `.AppImage` or `.deb`

### macOS install steps

This app isn't signed with a paid Apple Developer ID (see [GPU acceleration](#gpu-acceleration) and
the in-app update section above for why that also limits auto-update to Windows/Linux), so macOS
Gatekeeper will refuse to open it straight after downloading — normally with a message claiming
the file **"is damaged and can't be opened."** It isn't actually damaged; that's just Gatekeeper's
generic rejection for anything from an unidentified developer, and newer macOS versions removed the
old right-click-to-open bypass for this case. One extra Terminal step gets around it:

1. Open the `.dmg` and drag **Telemetry Studio** into **Applications**, as usual.
2. Open **Terminal** and run:
   ```bash
   xattr -cr "/Applications/Telemetry Studio.app"
   ```
   This clears the quarantine flag Gatekeeper attaches to anything downloaded from the internet.
3. Launch the app from **Applications** as normal. You only need to repeat step 2 after
   installing a new version the same way (in-app updates, once you're on a version that supports
   them, don't re-trigger this).

## Development

```bash
npm install
npm run dev        # launches the app with hot reload
npm run typecheck
npm test
```

### Building distributables locally

```bash
npm run dist:win     # Windows installer + portable exe
npm run dist:mac     # macOS .dmg + .zip (must be run on macOS)
npm run dist:linux   # Linux AppImage + .deb
```

Output lands in `release/`. Cross-compiling macOS builds from Windows/Linux isn't supported by
electron-builder for the parts that need Apple's own tooling (codesigning, DMG creation) — the
[release workflow](.github/workflows/release.yml) builds all three platforms natively in CI via a
GitHub Actions matrix, triggered by pushing a `v*.*.*` tag.

## GPU acceleration

Export runs everything through ffmpeg. On startup of each export, `selectVideoEncoder` (see
[`src/main/export/gpuEncoder.ts`](src/main/export/gpuEncoder.ts)) tries, in order:

1. **NVIDIA NVENC** (`h264_nvenc`) — encode *and* decode (`-hwaccel cuda`) both run on the GPU.
2. **Intel Quick Sync** (`h264_qsv`) — encode always attempted; GPU-accelerated decode
   (`-hwaccel qsv`) is additionally enabled only after its own real decode+encode roundtrip probe
   passes on your machine, since QSV decode support varies more by driver/platform than NVENC's.
3. **AMD AMF** (`h264_amf`) — GPU-accelerated encode. Decode stays on CPU: AMD's decode hwaccel
   pairing is platform-specific (`d3d11va` on Windows, `vaapi` on Linux) and untested on real AMD
   hardware, so rather than guess a flag that could break the export outright, only the encode step
   is GPU-accelerated for AMD today.
4. **Apple VideoToolbox** (`h264_videotoolbox`, macOS) — encode always attempted; GPU-accelerated
   decode (`-hwaccel videotoolbox`) is enabled only after its own real roundtrip probe passes, same
   treatment as Quick Sync above. **Newest and least-tested candidate here** — there's no Apple
   Silicon machine available to verify it directly, so it's only been checked by argument-shape
   review, not a real export on real Mac hardware. It's still fully covered by the "verify before
   trusting" smoke test below, so a machine where it doesn't actually work should just fall through
   to CPU rather than break the export outright — but if you hit an export failure on Mac after this
   change, that's the first thing to suspect.
5. **CPU** (`libx264`) — used if no GPU encoder is available, and as an automatic mid-export
   fallback if a GPU encoder that passed its startup smoke test still fails on the real export.

Every candidate is verified with a real, throwaway ffmpeg run before being trusted — nothing here
is guessed from the vendor name alone. The currently-selected encoder is shown in the export
progress bar.

## Architecture

```
src/
  main/            Electron main process — video probing/import, ffmpeg export, IPC handlers
  preload/         contextBridge API exposed to the renderer
  renderer/         React UI — editor, timeline, property panel, widget canvas
  shared/          Code used by both processes: telemetry parsing/math, widget draw functions,
                   project schema (zod), types
```

Each widget follows the same pattern: a style interface + defaults in
`shared/render/draw<Widget>.ts`, wired into `shared/render/drawWidget.ts` (the dispatch used by
both the live preview and the export renderer, so they're pixel-identical), `shared/widgets/defaults.ts`,
`shared/project/schema.ts`, and a section in `PropertyPanel.tsx`.

Telemetry (GPS/ACCL/GYRO/GRAV) is parsed once per import via `gopro-telemetry`, normalized into a
flat sample-array format, and sampled at arbitrary timestamps through `TelemetrySampler`
(`shared/telemetry/sampleAt.ts`), which both the live preview and the frame-by-frame export
renderer use identically.

## Known limitations

- **360° footage isn't supported yet.** The app assumes a flat rectilinear video frame; a raw 360
  file will import but won't be reprojected, so widgets will overlay on the unwrapped/fisheye
  source instead of a normal-looking view. I don't own a 360 camera to test against, so this hasn't
  been built. If you've got 360 GoPro footage (Max, or a Hero with a Max Lens Mod) and are willing
  to send me a sample clip, I'd like to take a shot at supporting it properly — open an issue on the
  repo and we can figure out how to get a file to me.
- **IMU axis calibration** (used by the G-Force and Roll/Lean widgets) is auto-detected per import
  by correlating accelerometer data against GPS-derived acceleration — it needs at least some
  braking/accelerating events in the clip to calibrate reliably. A manual axis override is
  available in each widget's property panel if auto-calibration picks the wrong axis.
- **Roll/lean angle accuracy** without a gravity-vector stream (older cameras) is estimated from
  raw accelerometer tilt, which reads exaggerated during hard cornering since lateral G adds to the
  tilt signal. The widget flags when it's using this fallback.
- **Start/finish crossing timing** is bounded by the GoPro's own GPS accuracy and sample rate —
  consumer GPS position noise (a few meters) is often comparable to how far you actually move
  between samples at typical track speeds, so a detected crossing can land within roughly a sample
  interval (commonly a few video frames) of the real line. This is close to the physical limit of
  the hardware, not something sub-sample interpolation can safely improve on (tried and reverted —
  it amplified GPS noise into a worse result than the plain nearest-sample approach). Click a lap
  marker on the timeline to manually nudge that specific crossing ±1 frame if it's visibly off —
  see the per-lap crossing nudge feature above.
- **Importing directly from an SD card (especially over a USB card reader) is noticeably slower
  than importing from a local drive, and is more likely to fall back to generating a preview proxy
  even for an otherwise-supported codec.** GoPro's in-camera MP4s store their index (the `moov` atom)
  at the *end* of the file rather than the front, so the very first thing playback needs is a large
  seek to near the end of a multi-gigabyte file, then back to the start. Random-access reads that far
  apart are much slower on SD cards than on an SSD, and if that seek is slow enough, Chromium's
  `<video>` element reports it the same way it would report a genuinely unsupported codec — the app
  can't currently tell the two apart. **Recommendation:** copy clips to a local drive before
  importing if you hit this.

## License

The source code in this repository is MIT licensed — see [LICENSE](LICENSE).

The bundled `Formula1-*.otf` font files under `src/renderer/src/fonts/` are **not** covered by that
license; they belong to their respective rights holder. They're included so the app's default
timing-tower styling works out of the box, but if you fork this project for wider redistribution,
consider swapping them for a font you have clear rights to.
