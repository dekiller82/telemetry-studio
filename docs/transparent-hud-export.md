# Transparent HUD export

## Exporting for another editor

1. Set the trim range and arrange the HUD in Telemetry Studio.
2. Choose **Transparent HUD (MOV Animation)** or **Transparent HUD (ProRes 4444)** in the toolbar.
3. Choose all widgets, or select one/multiple widgets in the canvas and choose **Selected widgets**.
4. Export to a MOV file. Import the original GoPro footage separately into the editing application.
5. Place the transparent file above the camera footage at Telemetry Studio's trim-start offset.
   Its own first timestamp is zero; its full frame matches the source dimensions and frame rate.
6. Group/link the two tracks before cutting or changing speed. Grade the camera clip separately.

Transparent export ignores delivery downscaling/bitrate presets so its coordinates match the
original footage. It does not decode or re-encode the GoPro picture/audio. H.264 MP4 exports retain
their existing combined-video path and hardware-encoder selection.

Animation is RGB with exact alpha in the regression fixture. ProRes 4444 uses 4:4:4 colour, alpha,
and a BT.709 YUV matrix; it is a high-quality intermediate, not a lossless RGB guarantee. Both
formats are tagged with BT.709/sRGB primaries and the **sRGB transfer characteristic** because the
Canvas graphics are sRGB. Both are exported with straight (unassociated) alpha. The original
Canvas alpha plane is preserved separately while RGB is unpremultiplied, avoiding dark outlines
and changed panel opacity.

In a colour-managed editor, interpret the HUD as sRGB graphics rather than GoPro log/camera space.
Apply the camera transform/LUT and creative grade to camera clips. A timeline grade or an
adjustment clip above both layers affects the HUD too. HDR output needs a suitable graphics/output
transform; this exporter does not bake a camera LUT or an HDR conversion into HUD pixels.
If an editor guesses alpha incorrectly, set the clip's alpha interpretation to **Straight**.
Import support and automatic colour/alpha interpretation must be checked in the actual installed
version of CapCut/Jianying or DaVinci Resolve.

The codecs encode on the CPU. This does not indicate a failure of NVENC; the existing H.264 hardware
path does not retain the alpha needed here. Sparse HUDs may be much smaller with Animation than
ProRes 4444. Long full-resolution exports still need real-media speed and memory validation.

## Render workers

Choose **File → Export rendering → 1, 2, 3 or 4 workers**. The default remains **2**.
The setting is saved in local preferences, not in the project, and applies to combined video,
best-lap and transparent exports. One worker uses the serial renderer; 2–4 use independent
background renderers with one outstanding frame request per worker and ordered FFmpeg input.
Worker startup failure falls back to one renderer without changing the requested alpha codec.
Cancellation and failure await worker cleanup. More workers require more memory and can move the
bottleneck to encoding or pipe backpressure. Four workers are optional: real-media throughput
and peak memory have not been benchmarked, and a speedup is not promised.

## Output protection and cancellation

Transparent exports require a `.mov` file name, including when the save dialog is given a custom
extension. Each attempt writes to a private temporary MOV in the destination directory and only
publishes after successful encoding. Cancellation, render failure and disk-full errors remove the
attempt while preserving a pre-existing destination. Cancellation during publication uses the
same rollback as MP4 export; recovery failures report the backup location. Every imported source
is protected, including chapters outside the trim range and filesystem aliases. Alpha encoding
failures are reported and never retried as opaque H.264.

For a best-lap export, align the HUD to the actual exported range start (lap start minus the
requested leading padding, clamped to the sequence start), rather than the project's saved trim.
Keep the HUD and camera layers linked through edits and speed changes.

## Validation boundary

Targeted regressions encode and decode tiny synthetic fixtures with the bundled FFmpeg for both
alpha codecs. They check full-frame placement, all decoded pixels over black and white, preserved
alpha, source dimensions, frame rate, frame count, zero start time, duration, sRGB transfer and
BT.709 primaries, and a single video stream without audio. Animation's fixture has exact alpha;
ProRes permits small colour/alpha rounding differences and is not a lossless RGB guarantee.

Mocked coordinator and worker regressions cover 1/2/3/4 selection, backward worker replies,
ordered frame submission, bounded outstanding requests, failure/cancellation cleanup and MOV
publication rollback. Existing overlay ROI and static-layer pixel/budget protections remain in
place. Request tests reject unsupported formats/counts and empty or stale widget selections.

These checks do not establish long-recording speed or peak memory. This change has not been
validated by running the application, a production build, a full test suite, or importing the MOV
into an external editor. Check colour management and straight-alpha interpretation in the editor
version actually used, especially for HDR timelines.
