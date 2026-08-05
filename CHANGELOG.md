# Changelog

All notable changes to Telemetry Studio are documented here.

## [0.1.23] - 2026-08-04

### Fixed
- **VideoToolbox export silently fell back to CPU on real Apple Silicon hardware.** Confirmed by
  a real tester and by extracting the actual mac binary from a shipped release: ffmpeg-static
  bundles ffmpeg 6.0 for macOS, and the quality-mode flag (`-q:v`) the previous release used for
  VideoToolbox wasn't added until ffmpeg 6.1 — the startup smoke test correctly detected this
  didn't work and fell back to CPU exactly as designed, it just meant the GPU path never actually
  ran. Switched to plain bitrate-mode rate control instead, which VideoToolbox has supported since
  ffmpeg first wrapped it.
- **Documented the macOS "is damaged and can't be opened" Gatekeeper message** — this app isn't
  signed with a paid Apple Developer ID, and recent macOS versions show this (misleading) message
  instead of an "unidentified developer" bypass button. See the README's
  [Installing](README.md#macos-is-damaged-and-cant-be-opened) section for the one-line Terminal
  fix (`xattr -cr`).

## [0.1.22] - 2026-08-04

### Fixed
- **Export was completely broken on Intel Macs.** Both mac release builds (Intel and Apple
  Silicon) were shipping the exact same single-architecture ffmpeg binary, because the packaging
  step downloads one binary matching whichever machine builds it and had no way to tell it needed
  both. On this project's build machine that meant an Apple-Silicon-only binary got bundled into
  the Intel build too, and Intel Macs can't run it at all — export would have failed outright,
  independent of and unrelated to the new VideoToolbox change in the last release. Each
  architecture is now packaged as its own pass with the correct binary swapped in first.

## [0.1.21] - 2026-08-04

### Added
- **GPU-accelerated export on macOS (Apple VideoToolbox)** — exports on Mac were silently falling
  back to CPU encoding, since the encoder selection list only knew about NVIDIA/Intel/AMD GPUs,
  none of which exist on Apple Silicon. Added VideoToolbox as a candidate, tried before falling
  back to CPU, following the same "verify with a real throwaway ffmpeg run before trusting it"
  approach as every other encoder here. **Not yet verified on real Apple Silicon hardware** — if
  export behaves worse than before on Mac after updating, that's the first thing to suspect;
  reports welcome.

## [0.1.20] - 2026-08-04

### Fixed
- **In-app update failed with a 404 on Windows and Linux** — the installer/AppImage filename is
  derived from the app's display name ("Telemetry Studio"), which contains a space. That one space
  got sanitized two different, incompatible ways: electron-builder's own update-metadata file
  recorded it as a hyphen, while GitHub's release-asset upload recorded it as a dot, so the
  in-app updater downloaded a URL that never matched an actual asset. The installer/AppImage
  filenames no longer derive from the display name, so there's no space left for either side to
  mangle differently.

## [0.1.19] - 2026-08-04

### Fixed
- **macOS build failed to launch with "Cannot find native binding"** — the mac release packages
  both Intel (x64) and Apple Silicon (arm64) builds from a single CI runner, but the canvas library
  used for rendering (`@napi-rs/canvas`) ships a separate native binary per architecture, and npm
  only installs the one matching the runner's own arch. Whichever architecture didn't match the
  runner ended up packaged with no native binary at all, and the app crashed on launch on that
  arch. CI now force-installs both architectures' binaries before packaging, so both mac builds
  ship with a working binary regardless of which arch actually builds them.

## [0.1.18] - 2026-07-23

### Added
- **In-app updates on Windows and Linux** — the existing "a new version is available" banner now has
  an Update button: click it to download in the background with a visible progress bar, then Restart
  & Install when it's ready, instead of only linking out to the Releases page. macOS keeps the
  link-out banner unchanged — Apple's Gatekeeper requires a paid Developer ID to auto-update at all,
  which this project doesn't have. Windows updates work without a certificate too (no SmartScreen
  changes from what the installer already shows today).
  **Note:** this only works starting from the *next* release after this one — the update-metadata
  file it needs isn't present on any release published before this feature existed, so upgrading
  away from this exact version still has to be done manually.

## [0.1.17] - 2026-07-23

### Fixed
- **Dragging a trim handle didn't move the video** — only the trim marker itself updated, so you
  couldn't see where the start/end point would actually land until you released the mouse. Dragging
  either trim handle now seeks the video live, the same way scrubbing the playhead already does.

## [0.1.16] - 2026-07-23

### Added
- **Cancel an in-progress export** — a Cancel button on the export progress bar stops ffmpeg
  outright (not a graceful finish-then-discard) and cleans up the truncated partial file, instead
  of only being able to wait it out.

### Fixed
- **The toolbar's new "?" (shortcuts/help) button didn't match the other toolbar buttons** — it had
  its own circular styling instead of the same rectangular ghost-button look as Undo/Redo/File.

## [0.1.15] - 2026-07-23

### Added
- **Keyboard shortcuts & getting-started panel** — a "?" button in the toolbar (or just pressing
  `?`) opens a reference panel listing every keyboard shortcut (undo/redo, select all, delete,
  arrow-key nudge/frame-step, play/pause, shift-click multi-select) alongside a short written
  walkthrough of the core workflow (import → add widgets → set start/finish → style → export).
  Also reachable from the welcome screen before importing anything.
- **Widgets now lock during export, and a real OS notification fires when it finishes** — widget
  drag/resize and every property-panel edit are disabled (visually dimmed, and genuinely
  non-interactive via the browser's `inert` mechanism) for the duration of an export, so there's no
  more ambiguity about whether moving something mid-export changes the output. For the record: it
  never did — the export pipeline already works from a one-time snapshot of your widgets copied over
  IPC the instant you click Export, so this is purely about removing that uncertainty, not a
  correctness fix. A native desktop notification (only when the window isn't already focused) lets
  a long export run in the background without babysitting the progress bar.

## [0.1.14] - 2026-07-22

### Fixed
- **Font picker: the two bundled Formula1 weights weren't individually selectable** — the picker
  (both the global default and each widget's own override) only offered one combined "Formula1
  (bundled)" entry, which let each widget auto-mix Bold/Regular the way it always internally has
  (e.g. a label in Bold next to a value in Regular) but gave no way to force just one weight
  everywhere. "Formula1 Bold" and "Formula1 Regular" are now separate, directly selectable entries
  in both dropdowns — picking either uses that one weight for every element in the widget (or the
  whole project, for the global default), while the original "Formula1 — Auto" entry keeps the
  previous per-widget mixed behavior for anyone who preferred that look.

## [0.1.13] - 2026-07-22

### Added
- **Global + per-widget font picker** — a "Project Settings" panel (File menu) sets a project-wide
  default font, picked from your real OS-installed fonts (not just a curated bundled list) alongside
  the existing Formula1 look. Any widget can override this with its own font via a "Font family"
  dropdown in its Style panel, defaulting to "Inherit from global". Renders identically in live
  preview and export — the export pipeline registers the same system fonts `@napi-rs/canvas` uses.
- **Property panel reorganized into two tabs**: "Widgets" (start/finish line, add/arrange widgets,
  layouts, color themes) and "Style" (alignment tools plus the selected widget's own controls).
  Selecting any widget now jumps straight to its Style tab instead of requiring a scroll past every
  global section first — the panel had grown long enough (18 widget types) that this was becoming a
  real navigation cost.

## [0.1.12] - 2026-07-22

### Added
- **Distance widget** — a live running total of GPS arc-length covered since the start of the
  recording, for a distance counter you can keep on screen the whole session (previously only
  visible as a final total on the Session Summary card).
- **Compass/Heading widget** — a digital "047° NE" readout of direction of travel from GPS
  course-over-ground. GoPro cameras have no magnetometer, so this reflects which way you're moving,
  not which way the camera physically faces, and reads meaninglessly while stationary.
- **Acceleration Timer widget** — a Dragy-style launch timer. Auto-detects a genuine stop followed
  by acceleration (not just any slow corner) and times how long it takes to reach each of your own
  configured target speeds, keeping a session-best per target alongside the live current run. Target
  speeds are user-configurable rather than Dragy's fixed highway splits (0-60mph, 1/4 mile), since
  karts run a much lower, track-specific speed range.

## [0.1.11] - 2026-07-21

### Added
- **Elevation widget** — current altitude readout and/or a distance-based elevation profile graph
  for the whole session (toggleable independently), from the GPS altitude reading every GoPro clip
  already carries. Most useful for hillclimbs/rally; a flat closed circuit will understandably look
  close to a flat line.
- **G-Force Diagram: numeric readout** — a combined-G value ("0.8G") now shows above the friction
  circle by default, so the widget actually tells you how many G's you're pulling instead of only
  showing where on the circle you are.
- **G-Force Diagram: toggleable axis labels** — the ACCEL/BRAKE/LEFT/RIGHT text can now be turned
  off independently of the ring/grid, for a cleaner look.

### Fixed
- **Roll/Lean Angle widget always read a frozen 0°** — root-caused on a real HERO8 Black clip: its
  GRAV (gravity vector) stream is structurally present (right sample count, right cts spacing) but
  every single sample is exactly `{0,0,0}` — the metadata slot exists on this camera/firmware but
  isn't populated with real sensor-fusion output. The app trusted "stream present" as "gravity data
  available," which froze Roll/Lean at a permanent 0° and silently corrupted the G-Force widget's
  axis calibration too (both share the same vertical-axis detection, which picks whichever axis has
  the largest mean magnitude — meaningless when every axis is identically zero). An all-zero GRAV
  stream is now treated as absent, the same as a camera that never had one, falling back to the
  accelerometer-tilt estimate like the app already does for older cameras.

## [0.1.10] - 2026-07-21

### Changed
- **Renamed the app from "GoPro Overlay" to "Telemetry Studio"** — the app has grown well past a
  GoPro-specific tool (F1-style timing towers, G-force/lean-angle analysis, delivery presets...),
  and "GoPro" is someone else's trademark to begin with. Project files still use the `.gpo`
  extension unchanged, and video import is still GoPro-only for now (see the CHANGELOG entries
  above for what that actually covers) — this is a branding change, not a functional one.

## [0.1.9] - 2026-07-21

### Added
- **Widget-to-widget alignment/snapping** — dragging a widget now also snaps to other widgets' own
  left/center/right and top/middle/bottom edges, not just the frame's own edges/center. Whichever
  candidate is closest wins, and a live guide line shows exactly where.
- **Per-lap start/finish crossing nudge** — the automatic lap-crossing detection can register a
  crossing a few frames early or late on a given lap (GPS noise, an off-angle pass near the line).
  Click a lap marker on the timeline to select it, then nudge it ±1 frame at a time with a live
  offset readout and a Reset button — every widget, the export, and "Export Best Lap" all pick up
  the correction immediately.
- **Delivery presets for export** — a dropdown next to Export Video bundles resolution + bitrate for
  YouTube (4K/1080p), Instagram/TikTok/Reels, and Twitter/X, alongside the existing default "Source
  quality" (unchanged CRF-based, native-resolution) export.

## [0.1.8] - 2026-07-21

### Fixed
- **Video preview failed to load at all on Linux — original clip, remux, and transcoded proxy alike** —
  root-caused on real hardware (not reasoned about from Windows): the custom `gpo-video://` scheme
  used to serve local files to the `<video>` element is registered as a "standard" scheme so it
  parses like `file://`, but only the literal `file:` scheme gets the spec carve-out that tolerates
  an empty authority. For any other standard scheme, `gpo-video:///home/user/clip.mp4` silently lost
  its first real path segment to the (supposedly empty) host — Chromium parsed it as host `home`,
  path `/user/clip.mp4` — so the file was never found regardless of its actual codec, which is why
  the v0.1.6/v0.1.7 fixes didn't resolve the underlying complaint. The same parsing defect affected
  Windows drive-letter paths too (host `c`, path missing the drive letter entirely), just unnoticed
  until now. Fixed by giving these URLs an explicit, unambiguous placeholder host instead of relying
  on an empty one.

## [0.1.7] - 2026-07-20

### Fixed
- **Native video preview no longer needs a transcoded proxy on Linux in the common case** — Chromium
  doesn't enable hardware video decode (VA-API) on Linux by default, so GoPro H.264/HEVC clips fell
  back to a software decoder that isn't included at all (patent-licensed codecs), forcing every clip
  through the proxy fallback regardless of disk speed. Now enabled the same way this app already
  enables a Windows-only HEVC decode flag — a no-op if a system's GPU/driver doesn't support it,
  in which case the existing proxy fallback still catches it exactly as before.

## [0.1.6] - 2026-07-20

### Fixed
- **Preview now actually falls back to a real transcode when it needs to** — previously, if a clip's
  quick remux "succeeded" as a file but still couldn't be decoded (a genuinely unsupported codec,
  not just a container quirk), the app gave up with the same generic error instead of trying the
  VP9/WebM re-encode that could actually fix it. Reported as preview still failing "even after
  trying to transcode" on Linux, even from a fast internal SSD.

## [0.1.5] - 2026-07-19

### Fixed
- **Fixed video preview/import/export failing in packaged builds** (`spawn ENOTDIR`, reported on a
  Linux AppImage build) — the bundled ffmpeg/ffprobe binaries' paths weren't being resolved through
  electron-builder's `asarUnpack` correctly, so packaged installs (unlike a dev build run from
  source) could fail to spawn them at all. Affected clip import probing, the preview-proxy
  transcode fallback (used when a clip doesn't play natively), and real video export.

## [0.1.4] - 2026-07-19

### Added
- **GPS Track zoomed window view** — an optional view mode that keeps the current position centered
  and zoomed in to an adjustable radius, instead of always fitting the whole track to the widget.
  Makes a close gap to the ghost marker actually visible instead of a fraction of a pixel on the
  full track's own scale.
- **Apex markers on the GPS Track widget** — plots a marker at each detected corner apex directly on
  the track outline, with its own detection sensitivity, independent of the Apex Speed Callout
  widget's own settings.
- **Lap Consistency widget** — a bar chart of your most recent completed laps, taller bar means a
  relatively faster lap, fastest lap highlighted in its own color.
- **Widget lock** — pin a widget's position/size so it can't be accidentally dragged or resized on
  the canvas (still editable in the property panel), skipped by group drag/nudge too.
- **Color themes** — recolor every widget currently on the frame in one click from a small set of
  built-in palettes; only touches color fields (text/accent/background), never position/size, and
  leaves semantic colors (faster/slower, braking/accelerating) alone.
- **"Jump to fastest lap" button** and a **speed sparkline strip** under the timeline scrub bar —
  jump straight to your best lap, or click anywhere on the speed-over-time strip to seek there
  instead of scrubbing blind to find braking zones/corners.
- **Export just your fastest lap** as its own short clip, with configurable padding (seconds before
  and after) — doesn't touch your project's actual saved trim range.
- **In-app "What's New" viewer** — shows the changelog automatically once per new version, plus a
  toolbar button to reopen it anytime.
- **Update notification** — checks once per launch whether a newer version has been released and
  shows a dismissible banner with a link to it if so. Dismissing only suppresses that specific
  version's notice, so it comes back once an actually newer release ships.
- **Jump-to-lap markers on the timeline** — every detected start/finish crossing now shows as a
  clickable marker on the scrub bar (hover for the lap number and the preceding lap's time), not
  just the single fastest lap.
- **Custom Text/Logo widget** — freeform multi-line text (driver name, event title, sponsor
  watermark) and/or an uploaded image, the first widget whose content isn't derived from telemetry
  at all.

### Fixed
- **Session Summary no longer visibly updates while it's on screen** — its stats (distance,
  duration, top speed, avg speed) previously ticked upward for the whole reveal window instead of
  reading as a settled recap; it now shows the session's true final totals throughout.
- **Fixed a real memory leak that could crash the app with an out-of-memory error during a long
  editing session.** The cache backing widget header-logo images had no size limit at all — every
  distinct image ever tried as a header logo (including ones since replaced, or reverted via undo)
  stayed decoded in memory for the rest of the session, uncompressed. Also capped the undo/redo
  history, which had no limit either (every widget click, not just style edits, records a history
  point).

## [0.1.3] - 2026-07-19

### Added
- **Session Summary widget** — an end-of-session outro card with an eased opening animation,
  shown for a configurable number of seconds before the end of the trim range. Displays lap count,
  best lap/sector splits, top speed, distance, and elapsed time.
- **GPS ghost marker** — an optional second, translucent dot on the GPS Track widget showing your
  fastest completed lap's own position at the same elapsed time into its lap, so you can see
  ahead/behind spatially instead of just as a number. The property panel now shows a live status
  line explaining why the ghost isn't visible yet (no start/finish line set, or no lap completed)
  when it doesn't appear.
- **Rounded corners** on every widget's background, on by default, with an adjustable radius — and
  the digital speedometer gained its own background option to match the other widgets.
- **Recent Projects** — the start screen now lists your last 10 opened/saved projects for one-click
  reopening, instead of always going through the file picker.
- **Multi-select** — shift-click widgets (on the canvas or in the widget list) to build a selection;
  drag any member to move the whole group together, and align/center/delete apply to the whole
  selection at once.
- **Arrow-key nudge** — move the selected widget(s) by 1px (10px with Shift) using the arrow keys,
  active only while a widget is selected so it doesn't conflict with the timeline's own frame-step
  shortcut.
- **Undo/redo** for all widget edits (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or +Y), coalescing rapid bursts
  (e.g. dragging a slider) into a single undo step.
- **Saveable widget layout presets** — save your current widget arrangement under a name and
  re-apply it to any project later.
- **Autosave** with crash recovery — offers to restore your last session if the app didn't close
  cleanly.
- **LRV sidecar proxy fallback** — if a clip has a GoPro-written low-res `.LRV` proxy next to it,
  preview generation prefers that over transcoding from scratch, which is much faster.

### Fixed
- The layout-save name prompt used `window.prompt()`, which Electron's renderer does not support —
  clicking "Save current layout…" silently did nothing. Replaced with an inline name field, and
  loading a saved layout is now an explicit "Load" button instead of a plain clickable label.
- The Session Summary widget's optional best-sector row could render below the widget's own bottom
  edge instead of shrinking to fit, whenever sector data was present.
- GPS track rendering with speed/braking coloring is now cached per widget instead of re-stroking
  every segment on every frame, fixing a real performance drop during playback/scrubbing with that
  coloring mode enabled.
- No-fix `(0, 0)` GPS samples (camera briefly lost signal) are now filtered out at import instead of
  being treated as real telemetry.

## [0.1.2] - 2026-07-18

### Fixed
- No-fix (0,0) GPS samples are filtered out instead of imported as real telemetry.

### Documentation
- Documented SD card import slowness under Known limitations.
- README wording/punctuation fixes.

## [0.1.1] - 2026-07-17

### Added
- Crash diagnostics logging.

### Fixed
- Capped widget canvas device-pixel-ratio to avoid excessive backing-store size on high-DPI
  displays.

### Documentation
- Added a demo video link and expanded per-widget option details in the README.

## [0.1.0] - 2026-07-16

Initial release: import GoPro clips, build a customizable telemetry overlay from GPS track, timer,
sector timer, delta time, predictive lap timer, apex speed callout, speed/distance graph,
G-Force diagram, roll/lean angle, and speedometer (analog/digital) widgets, then export a burned-in
MP4 with GPU-accelerated encoding where available.
