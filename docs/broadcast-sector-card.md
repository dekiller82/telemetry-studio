# Optional broadcast sector card

Select a Sector Timer, open **STYLE**, and choose **Layout → F1 broadcast card**. Classic is
still the default for new and saved projects. The card keeps its design proportions when
resized; changing layout adjusts its initial height to fit the broadcast design.

Set the driver name, optional position/tyre labels, team accent and initials or upload a team
logo. Position and tyres are user-entered labels, not measurements from GoPro telemetry.
No team marks are bundled. The position number uses bundled Titillium Web, whose copyright
and SIL OFL 1.1 text are in `src/renderer/src/fonts/TitilliumWeb-OFL.txt`.

Sector results default to five seconds and lap results to three seconds. Both accept 0–60
seconds; zero hides the corresponding popup. Durations include entrance/exit transitions.
A lap result first shows the comparison, then the full lap time. The next lap's underlying
clock keeps running, and all transitions derive from the video's timestamp rather than a
real-time animation clock. Seeking, trims and render workers therefore evaluate the same frame.

The card uses the same fixed circuit, gates and reference lap as live Delta and Predicted Lap;
see [timing settings](fixed-sector-timing.md). The reference is a real eligible lap completed
before the displayed lap starts, not an ideal lap assembled from best sectors. With one driver,
session and personal bests coincide: tied/new sector bests are purple, slower sectors yellow,
sectors without a benchmark white, and pending sectors gray. The cumulative delta is green
when ahead and yellow otherwise. Manually excluded laps cannot supply results or references.

## Design reference

The visual layout and transition timing were informed by
[wertewrt/F1_Lap_Timing](https://github.com/wertewrt/F1_Lap_Timing), specifically
[commit 00fae5df775da8febfb603f4ce0bbbf50550dc06](https://github.com/wertewrt/F1_Lap_Timing/tree/00fae5df775da8febfb603f4ce0bbbf50550dc06).
This is an independent TypeScript/Canvas implementation with source-timestamp-based timing;
the reference project's Python source is not bundled. Font rasterization differs between
browser Canvas, native Canvas and the reference's Pillow renderer; pixel identity is not claimed.

The referenced revision has no project-level source-code license statement. This credit
identifies the design source and is not permission to redistribute its source or assets.
Its [asset attribution](https://github.com/wertewrt/F1_Lap_Timing/blob/00fae5df775da8febfb603f4ce0bbbf50550dc06/assets/ATTRIBUTION.md)
separately identifies Titillium Web's OFL, excludes Formula1 fonts from that statement and
identifies team marks as belonging to their respective rights holders. Those statements do
not supply a license for all project contents.
