/**
 * Tests that Clone Hero .chart imports keep their authored star-power phrases
 * (`S 2` special events) instead of dropping them, and that ensureStarPhrases
 * respects those authored phrases.
 */

import { describe, expect, it } from "vitest";

import { parseNotesChart } from "./cloneHeroParser";
import { ensureStarPhrases } from "./starPower";

const CHART = `[Song]
{
  Name = "SP Test"
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
  192 = N 1 0
  384 = N 2 0
  384 = S 2 384
  480 = N 3 0
  768 = N 4 0
  960 = N 0 0
  960 = S 2 192
  1056 = N 1 0
}
`;

describe("clone hero star power import", () => {
  it("tags exactly the notes inside each S 2 range, in phrase order", () => {
    const chart = parseNotesChart(CHART, "expert");
    const byTick = new Map(
      // 120 BPM @ 192 res → 192 ticks = 500ms/beat → tick × (500/192) ms.
      chart.notes.map((n) => [Math.round((n.timeMs * 192) / 500), n] as const),
    );

    // First phrase covers ticks [384, 768): the notes at 384 and 480.
    expect(byTick.get(384)?.starPhrase).toBe(0);
    expect(byTick.get(480)?.starPhrase).toBe(0);
    // The phrase end is exclusive — 768 is outside.
    expect(byTick.get(768)?.starPhrase).toBeUndefined();

    // Second phrase covers ticks [960, 1152): the notes at 960 and 1056.
    expect(byTick.get(960)?.starPhrase).toBe(1);
    expect(byTick.get(1056)?.starPhrase).toBe(1);

    // Notes before any phrase stay normal.
    expect(byTick.get(0)?.starPhrase).toBeUndefined();
    expect(byTick.get(192)?.starPhrase).toBeUndefined();
  });

  it("ensureStarPhrases leaves the authored phrases untouched", () => {
    const chart = parseNotesChart(CHART, "expert");
    expect(ensureStarPhrases(chart)).toBe(chart);
  });

  it("charts without S events still import (no phrases)", () => {
    const bare = CHART.split("\n")
      .filter((l) => !l.includes("S 2"))
      .join("\n");
    const chart = parseNotesChart(bare, "expert");
    expect(chart.notes.every((n) => n.starPhrase === undefined)).toBe(true);
  });
});
