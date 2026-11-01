# Export pipeline, measurements, and diagnostics

The exporter still draws HUDs with `@napi-rs/canvas`, composites with FFmpeg's CPU `overlay`
filter, and encodes with the selected hardware encoder or libx264. This change accelerates that
pipeline without introducing a GPU compositor or changing the telemetry and lap algorithms.

## Rendering and memory ownership

- Normal UI exports pass raw telemetry to two independent render workers. Each worker constructs
  its own sampler and renderer. There is at most one outstanding frame request per worker; the
  writer consumes frames in timeline order and respects FFmpeg's pipe backpressure. Work and pixel
  queues do not grow with the duration of the export.
- Every frame is an owned `Buffer.from(canvas.data())` snapshot. Its backing buffer is transferred
  to the parent, not reused by the worker while FFmpeg still owns it. Canvas pixels remain
  premultiplied; `overlay=...:alpha=premultiplied` replaces the per-frame JavaScript unpremultiply
  scan. Do not replace the owned snapshot with a borrowed view of the mutable canvas.
- A fixed overlay ROI can reduce transparent pixel traffic. G-force trails, GPS window views,
  and ghost/apex markers can draw outside their widget bounds, so they use the full output frame.
  Trim-aware GPS overviews also use full-frame output: their live dot interpolates against the
  full sampler and can leave the bounds of the retained fixes at either trim boundary. Enlarged
  Custom Text images use the same fallback because their width cap does not cap their height.
- Trimmed GPS geometry and its matching colored track image are prepared once per renderer,
  rather than slicing and redrawing all segments for every video frame.
- Speedometer labels/backgrounds and G-force grids are cached with padding and the original
  fractional pixel phase. They are composited without resizing. Rotated widgets retain immediate
  vector drawing. Static layers have a combined 16 MiB pixel budget per renderer; excess widgets
  use immediate drawing.
- Eligible, unrotated `fullLap` speed graphs reuse their background/axes/completed traces and their
  most recent live trace between GPS updates. This cache has two reusable surfaces and a combined
  16 MiB pixel budget per renderer across all graphs. Window views, rotation, and oversized graphs
  use immediate drawing. The budget excludes the main overlay canvas, telemetry, and native
  rasterizer temporaries. Two workers therefore allow up to 32 MiB of retained graph surfaces and
  another 32 MiB of static widget surfaces.

Two workers duplicate telemetry, samplers, and native rendering resources. They improve throughput
but use more memory than one renderer. This is not a total-process memory cap or a fix for every
preview/decoder memory issue. Internal API callers can set `settings.renderWorkers: 1` for serial
validation; callers providing only a sampler also use the serial path. Worker initialization
failure falls back to serial rendering after the failed workers have exited.

## Decoding, failures, and output publication

NVENC selection verifies encoding capability. A separate probe must decode an actual CUDA frame
from every input overlapping the trim range before CUDA decode is requested. It uses four input
decoder threads to avoid excessive NVDEC surfaces. A failed probe keeps NVENC encoding with
software decoding. The probe has a timeout and responds to cancellation; probe processes are
closed before continuing.

FFmpeg exit failures are observed immediately, including while the main process awaits a worker
frame or pipe drain. Those waits respond to process exit and cancellation without adding one
permanent exit-promise handler per frame. Worker/process cleanup is awaited before retrying.
Only hardware-related FFmpeg failures trigger the existing CPU-encoder retry; render, input,
filesystem, and output-publication errors are reported directly.

Each attempt writes a private temporary MP4 beside the requested destination. Publication happens
after FFmpeg succeeds. Cancellation/failure removes the attempt, preserving an existing output.
Cancellation is checked before/after asynchronous source-identity checks and after each replacement
rename. If cancellation arrives during a rename, the old destination is restored; if there was no
old destination, the newly published attempt is removed. Failed recovery preserves the backup and
reports its location as an error instead of hiding it as ordinary cancellation.

The successful final rename and its subsequent cancellation check form the publication commit
point. Backup deletion is best-effort, post-commit cleanup; a cancellation arriving only during
that cleanup does not undo the completed output.
All imported source paths are protected, including chapters outside the trim range: normalized
Windows path aliases, real paths, and hard links cannot be used to overwrite source video/GPMF.
The protection is checked before work begins and again before publication.

## Windows benchmark (2026-10-26)

Baseline: unmodified upstream `20de28df6f5c028989b6049171641b3369946608`.
Proposed: this export-only change on that same commit. Both used the same dependencies, original
H.264 input chapter, full project telemetry/history, 9 widgets, global trim position, fonts,
NVENC `p5`/CQ 18 settings, and 2704x1520 output at 50 fps. The trimmed range was 20 seconds within
one chapter; identical clip selection avoided comparing unrelated chapter-selection behavior.

Host: Windows x64, Ryzen 9 7940H (16 logical CPUs), RTX 4070 Laptop GPU, 16 GB RAM. The harness
called the source export code in fresh Node 24.16.0 processes with canvas 1.0.2 and the bundled
FFmpeg 6.1.1. Historical source modules were read from the pinned Git commit. Runs were sequential,
with two repetitions per version. Wall time includes setup, encoder selection, decoding probe,
rendering, FFmpeg, output publication, and worker shutdown.

| Measurement | Upstream | Proposed |
| --- | ---: | ---: |
| Wall time, run 1 | 43.93 s | 20.27 s |
| Wall time, run 2 | 43.89 s | 19.90 s |
| Mean wall time | 43.91 s | 20.08 s |
| Effective export fps | 22.77 | 49.80 |
| Peak Node + worker RSS | 230-238 MiB | 404-408 MiB |
| NVDEC initialization fallback warnings | Present in both runs | None detected |

On this workload, mean elapsed time decreased **54.3%**, or **2.19x throughput**. This combines
worker rendering, alpha handling, caching, and decoding changes; it is not an isolated measurement
of any one feature and is not a promise for other projects. The upstream run requested 34 decode
surfaces and fell back to software decode. The proposed startup probe passed, and no runtime
fallback diagnostic was detected; this does not prove every exported frame used hardware decode.

Both outputs contain exactly 1,000 video frames, 20.000 seconds of H.264 video and AAC audio, at
the requested dimensions/rate. Decoded audio hashes match. Full-sequence decoded-image PSNR is
49.78 dB (minimum per-frame PSNR 48.44 dB); outputs are not byte-identical. Pixel regression tests
separately compare alpha composition, fractional cache placement/rotation, GPS window output,
and graph cache drawing against their immediate paths.

Validation also includes both TypeScript checks, the complete Vitest suite, a production build,
and an Electron 43.1.1 smoke test: both production-bundled workers loaded native canvas/fonts,
rendered the same real-project frame to identical owned buffers, and terminated. This is not a
packaged-installer test. Long complete sessions, real chapter boundaries, and hardware exports
on Intel/AMD/macOS still need validation; neither the timing nor RSS above measures those cases.

## Reading a profile

Each encoder attempt prints one `[export:profile]` JSON record. It retains at most 256 sampled
render durations and bounded diagnostic text, not frames, source paths, or a log entry per frame.

- `durationMs` covers the attempt; renderer setup and encoder selection are reported separately.
  Use external wall time for total time-to-file, including publication and teardown.
  `outcome` describes the encoder attempt; output publication can still fail or be cancelled later.
- `renderMs` is summed worker render time and can exceed wall time when workers overlap.
  `renderWaitMs` measures the submission loop's wait for ordered frames. Do not add the summed
  worker durations to wall-clock pipe waits as if they were serial stages.
- `renderAvgMs` covers all recorded frame renders; `renderP95Ms` uses the bounded, evenly-spaced
  sample, while `renderMaxMs` tracks the true all-frame maximum.
- `writeCallMs`, `drainWaitMs`, `submissionLoopMs`, and `ffmpegWaitMs` help separate renderer
  production from pipe backpressure and the final encoder flush.
- `renderedFrames`/`submittedFrames` are producer counts. `encodedFrames` remains `null`: it is
  not inferred from pipe writes. Use FFprobe to verify the completed file's exact frame count.
- `decodeHwaccel` identifies a requested backend. `decodeProbeStatus: passed` proves a startup
  hardware frame, and `decodeRuntimeStatus: fallback-detected` records a recognized runtime
  diagnostic. `requested` means no fallback was detected, not measured hardware utilization.

To compare another project, use the same sources, trim, layout, fonts, encoder settings, and
output dimensions for each version. Time complete exports, inspect the profile, verify video/audio
duration and frame count, and compare decoded images. Measure process memory alongside speed;
the Windows Task Manager's aggregate GPU percentage alone cannot identify the bottleneck.
