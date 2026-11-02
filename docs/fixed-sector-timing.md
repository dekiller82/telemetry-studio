# Fixed sectors, shared delta and manual lap results

Sector Timer, Delta Time and Predicted Lap share one reference circuit and fixed S1/S2
locations in preview and export. Sector splits are no longer thirds of each lap's eventual
GPS distance, which could compare different physical positions on different laps.

## Setting sector locations

1. Set the lap start/finish line under **WIDGETS**.
2. Open **Sectors & Delta** to see the fixed circuit and its markers.
3. Pause at the end of Sector 1 and choose **Set S1 end here**; repeat for S2.
4. Alternatively enter latitude/longitude and choose **Apply coordinates**. Typing alone does
   not repeatedly rebuild the model.
5. **Auto** restores a marker's automatic position. S3 ends at the lap start/finish line;
   **Set S3 / finish here** updates that shared line and lap detection.

The first usable closed circuit establishes the geometry. Automatic S1/S2 lie at its thirds;
these are GPS-derived locations, not surveyed official timing lines. Later faster laps and
manual result exclusions do not move them. Reversed, duplicate, too-close or off-circuit
markers show an explanation and withhold comparisons until corrected.

## Comparing the same positions

Every lap is mapped in driving order onto the same circuit, within a 30 m corridor. Mapping
stops at missing GPS or an unmappable route instead of inventing progress. Partial final laps
can show S1/S2 without a future finish crossing. No usable circuit means no splits or delta;
the ordinary lap clock can still follow actual detected crossings.

The reference for a displayed lap is the fastest eligible lap completed before its start.
It remains fixed for that lap. The broadcast card freezes cumulative delta at each checkpoint;
live Delta compares the current position. They agree at the checkpoint, then can diverge as
live Delta advances. Predicted Lap is reference total plus live delta, not a guaranteed finish.

## Excluding or restoring a lap result

Open **Lap results** beside **Fastest lap**, then toggle **Count result**. Alternatively select
the lap's starting timeline marker and use **Exclude lap result** or **Restore lap result**.
Excluded intervals are shaded and retain their crossing markers, lap numbers and running
clock. Their results are removed from the timing tower, fastest-lap jump/export, reference
selection, sector bests, comparison traces and session recap. Sector Timer displays
**LAP EXCLUDED** and delta/prediction are unavailable during the excluded interval.

**Delete crossing** is a separate action for a false crossing: it merges adjacent intervals.
Exclusion identities use both original crossing timestamps. A frame nudge preserves an
exclusion; deleting an endpoint cannot transfer it to a different merged interval. Restoring
the crossing restores the original decision. Changing the start/finish line or radius, or
importing another project, clears decisions; appending chapters retains them.

A continuous stop below 1 m/s for ten seconds only suggests reviewing a lap. The user decides
whether to count it. Restoring a result cannot reconstruct missing GPS or an unmappable route.

## Saving and export

Project save/open and autosave retain marker positions and result decisions. Older projects
default to automatic fixed markers and count all results. The serial renderer and parallel
workers receive the same timing settings and exclusions; frame lookup derives from source
timestamps so seeking and out-of-order rendering do not change the timing result.

Software consistency and physical timing accuracy are separate: GPS drift, parallel track
segments and an incorrectly chosen finish line can still affect detection and mapping.
