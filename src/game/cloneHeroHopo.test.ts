/**
 * Tests that Clone Hero .chart imports carry real HOPO flags: natural spacing
 * (65/192 of a beat, new lane, non-chord), forced flips (`N 5`), and tap
 * notes (`N 6`), with ensureHopos leaving the authored flags untouched.
 */

import { describe, expect, it } from "vitest";

import { parseNotesChart } from "./cloneHeroParser";
import { ensureHopos } from "./hopo";

// 120 BPM at 192 resolution → 1 tick ≈ 2.604ms, natural gap = 65 ticks.
const CHART = `[Song]
{
  Name = "HOPO Test"
  Resolution = 192
  Offset = 0
}
[SyncTrack]
{
  0 = B 120000
}
[ExpertSingle]
{
  0 = N 0 0
  48 = N 1 0
  96 = N 1 0
  160 = N 2 0
  160 = N 3 0
  224 = N 4 0
  480 = N 0 0
  528 = N 0 0
  528 = N 5 0
  576 = N 1 0
  576 = N 5 0
  960 = N 2 0
  960 = N 6 0
}
`;

describe("clone hero HOPO import", () => {
  function hopoByTick(): Map<number, boolean | undefined> {
    const chart = parseNotesChart(CHART, "expert");
    const msPerTick = 60_000 / 120 / 192;
    return new Map(
      chart.notes.map((n) => [Math.round(n.timeMs / msPerTick), n.hopo] as const),
    );
  }

  it("marks natural HOPOs by spacing and lane change", () => {
    const byTick = hopoByTick();
    expect(byTick.get(0)).toBe(false); // first note
    expect(byTick.get(48)).toBe(true); // fast, new lane
    expect(byTick.get(96)).toBe(false); // fast but same lane
    expect(byTick.get(224)).toBe(true); // fast, differs from both chord lanes
    expect(byTick.get(480)).toBe(false); // too far from the previous note
  });

  it("chords are never HOPOs", () => {
    const chart = parseNotesChart(CHART, "expert");
    const msPerTick = 60_000 / 120 / 192;
    const chordNotes = chart.notes.filter(
      (n) => Math.round(n.timeMs / msPerTick) === 160,
    );
    expect(chordNotes).toHaveLength(2);
    for (const n of chordNotes) expect(n.hopo).toBe(false);
  });

  it("forced (N 5) flips the natural state both ways", () => {
    const byTick = hopoByTick();
    expect(byTick.get(528)).toBe(true); // same lane (natural strum) forced → HOPO
    expect(byTick.get(576)).toBe(false); // natural HOPO forced → strum
  });

  it("tap (N 6) is always a HOPO regardless of spacing", () => {
    const byTick = hopoByTick();
    expect(byTick.get(960)).toBe(true); // huge gap, still tappable
  });

  it("ensureHopos leaves the authored flags untouched", () => {
    const chart = parseNotesChart(CHART, "expert");
    expect(ensureHopos(chart)).toBe(chart);
  });
});
