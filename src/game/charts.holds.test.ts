/**
 * Tests that the chart producers actually emit playable hold notes, so the
 * hold mechanic has real content to run against (demo chart + auto-mapper).
 */

import { describe, expect, it } from "vitest";

import { generateAutoChart } from "./autoMapper";
import { assertValidChart } from "./chartUtils";
import { MIN_HOLD_MS } from "./constants";
import { createDemoChart } from "./demoChart";
import { isHoldNote } from "./scoring";
import type { Difficulty } from "./types";

describe("demo chart", () => {
  it("includes at least a couple of playable holds", () => {
    const chart = createDemoChart();
    assertValidChart(chart);
    const holds = chart.notes.filter((n) => isHoldNote(n));
    expect(holds.length).toBeGreaterThanOrEqual(2);
    for (const h of holds) {
      expect(h.durationMs ?? 0).toBeGreaterThanOrEqual(MIN_HOLD_MS);
      expect(h.type).toBe("hold");
    }
  });
});

describe("auto-mapper holds", () => {
  it("produces holds on an easy chart, all with valid durations", () => {
    const chart = generateAutoChart({
      durationSeconds: 180,
      difficulty: "easy",
      bpm: 120,
    });
    assertValidChart(chart);
    const holds = chart.notes.filter((n) => isHoldNote(n));
    expect(holds.length).toBeGreaterThan(0);
    for (const h of holds) {
      expect(h.durationMs ?? 0).toBeGreaterThanOrEqual(MIN_HOLD_MS);
    }
  });

  it("is deterministic: same inputs → identical hold placement", () => {
    const opts = { durationSeconds: 90, difficulty: "medium" as Difficulty, bpm: 128 };
    const a = generateAutoChart(opts);
    const b = generateAutoChart(opts);
    expect(a.notes.map((n) => [n.timeMs, n.lane, n.durationMs ?? 0])).toEqual(
      b.notes.map((n) => [n.timeMs, n.lane, n.durationMs ?? 0]),
    );
  });

  it("never turns a chord partner into a hold (no two-lane holds)", () => {
    const chart = generateAutoChart({
      durationSeconds: 120,
      difficulty: "expert",
      bpm: 140,
    });
    // Group notes by timestamp; any timestamp with 2 notes is a chord and
    // neither should be a hold.
    const byTime = new Map<number, typeof chart.notes>();
    for (const n of chart.notes) {
      const list = byTime.get(n.timeMs) ?? [];
      list.push(n);
      byTime.set(n.timeMs, list);
    }
    for (const list of byTime.values()) {
      if (list.length > 1) {
        for (const n of list) expect(isHoldNote(n)).toBe(false);
      }
    }
  });
});
