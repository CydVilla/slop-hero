/**
 * Tests for the windowed hot-path helpers that keep per-frame / per-tap work
 * bounded on large charts:
 *   - firstIndexAtOrAfter / noteIndexRange (binary-search windowing)
 *   - findHittableNote with search bounds (== full scan, but cheaper)
 *   - collectMissedFrom (cursor-based miss detection == findNewlyMissedNoteIds)
 *
 * The guiding property for the optimised paths is EQUIVALENCE: they must return
 * exactly what the original whole-chart scans return, just faster. Several tests
 * assert that directly against the reference implementations.
 */

import { describe, expect, it } from "vitest";

import { firstIndexAtOrAfter, noteIndexRange, sortNotes } from "./chartUtils";
import { HIT_WINDOWS, MISS_THRESHOLD_MS } from "./constants";
import {
  collectMissedFrom,
  findHittableNote,
  findNewlyMissedNoteIds,
} from "./scoring";
import type { ChartNote, Lane, NoteRuntimeState } from "./types";

function makeNote(
  id: string,
  timeMs: number,
  lane: Lane,
  durationMs?: number,
): ChartNote {
  return { id, timeMs, lane, durationMs, type: durationMs ? "hold" : "tap" };
}

function runtimeFor(notes: readonly ChartNote[]): Map<string, NoteRuntimeState> {
  const map = new Map<string, NoteRuntimeState>();
  for (const n of notes) map.set(n.id, { judged: false });
  return map;
}

/**
 * A deterministic, reasonably dense sorted chart across all five lanes so the
 * equivalence sweeps below exercise real windows (overlapping notes, chords,
 * gaps). Times are non-integer on purpose to catch floating-point edge cases.
 */
function buildChart(count: number): ChartNote[] {
  const notes: ChartNote[] = [];
  for (let i = 0; i < count; i += 1) {
    const timeMs = i * 137.5 + (i % 3) * 11.3; // clustered but ascending-ish
    notes.push(makeNote(`n${i}`, timeMs, (i % 5) as Lane, i % 7 === 0 ? 400 : undefined));
    if (i % 11 === 0) {
      // a chord partner sharing the same time in a different lane
      notes.push(makeNote(`n${i}b`, timeMs, ((i + 2) % 5) as Lane));
    }
  }
  return sortNotes(notes);
}

describe("firstIndexAtOrAfter", () => {
  const notes = [
    makeNote("a", 100, 0),
    makeNote("b", 200, 1),
    makeNote("c", 200, 2), // duplicate time
    makeNote("d", 500, 3),
  ];

  it("returns 0 when the target precedes every note", () => {
    expect(firstIndexAtOrAfter(notes, 0)).toBe(0);
    expect(firstIndexAtOrAfter(notes, 100)).toBe(0);
  });

  it("returns length when the target is past every note", () => {
    expect(firstIndexAtOrAfter(notes, 501)).toBe(4);
    expect(firstIndexAtOrAfter(notes, 1e9)).toBe(4);
  });

  it("lands on the FIRST note of a duplicate-time run", () => {
    expect(firstIndexAtOrAfter(notes, 200)).toBe(1);
  });

  it("returns the first strictly-later note for an in-between target", () => {
    expect(firstIndexAtOrAfter(notes, 201)).toBe(3);
    expect(firstIndexAtOrAfter(notes, 101)).toBe(1);
  });

  it("handles the empty chart", () => {
    expect(firstIndexAtOrAfter([], 42)).toBe(0);
  });

  it("agrees with a linear scan for many random-ish targets", () => {
    const chart = buildChart(200);
    for (let t = -50; t < chart.length * 140; t += 17) {
      const linear = chart.findIndex((n) => n.timeMs >= t);
      const expected = linear === -1 ? chart.length : linear;
      expect(firstIndexAtOrAfter(chart, t)).toBe(expected);
    }
  });
});

describe("noteIndexRange", () => {
  const notes = [
    makeNote("a", 100, 0),
    makeNote("b", 200, 1),
    makeNote("c", 300, 2),
    makeNote("d", 400, 3),
  ];

  it("includes notes sitting exactly on both bounds", () => {
    const [lo, hi] = noteIndexRange(notes, 200, 300);
    expect(notes.slice(lo, hi).map((n) => n.id)).toEqual(["b", "c"]);
  });

  it("is empty (lo === hi) when no note falls in the window", () => {
    const [lo, hi] = noteIndexRange(notes, 210, 290);
    expect(hi).toBe(lo);
  });

  it("covers the whole array for a wide window", () => {
    const [lo, hi] = noteIndexRange(notes, -1e6, 1e6);
    expect([lo, hi]).toEqual([0, notes.length]);
  });
});

describe("findHittableNote with search bounds", () => {
  it("returns the same note as a full scan across a time sweep", () => {
    const chart = buildChart(300);
    const runtime = runtimeFor(chart);
    // Judge a scattering of notes so 'already judged' skipping is exercised too.
    let k = 0;
    for (const n of chart) {
      if (k % 4 === 0) runtime.set(n.id, { judged: true, rating: "great" });
      k += 1;
    }

    const offset = 40;
    const cal = -25;
    for (let t = 0; t < chart.length * 140; t += 23) {
      const chartTimeMs = t - offset + cal;
      const [lo, hi] = noteIndexRange(
        chart,
        chartTimeMs - HIT_WINDOWS.good,
        chartTimeMs + HIT_WINDOWS.good,
      );
      for (let lane = 0 as Lane; lane < 5; lane = (lane + 1) as Lane) {
        const full = findHittableNote(chart, runtime, lane, t, offset, cal);
        const windowed = findHittableNote(chart, runtime, lane, t, offset, cal, lo, hi);
        expect(windowed?.id).toBe(full?.id);
      }
    }
  });
});

describe("collectMissedFrom", () => {
  it("marks a note missed exactly when it passes the late window", () => {
    const chart = [makeNote("a", 1000, 0)];
    const runtime = runtimeFor(chart);
    // Just inside the window → not yet missed.
    const inside = collectMissedFrom(chart, runtime, 0, 1000 + MISS_THRESHOLD_MS, 0, 0);
    expect(inside.missedIds).toEqual([]);
    expect(inside.nextIndex).toBe(0);
    // One ms past → missed, cursor advances past it.
    const past = collectMissedFrom(chart, runtime, 0, 1000 + MISS_THRESHOLD_MS + 1, 0, 0);
    expect(past.missedIds).toEqual(["a"]);
    expect(past.nextIndex).toBe(1);
  });

  it("does not re-report a note the cursor has already moved past", () => {
    const chart = [makeNote("a", 1000, 0), makeNote("b", 2000, 1)];
    const runtime = runtimeFor(chart);
    const first = collectMissedFrom(chart, runtime, 0, 5000, 0, 0);
    expect(first.missedIds.sort()).toEqual(["a", "b"]);
    expect(first.nextIndex).toBe(2);
    // Feeding the cursor back yields nothing new even though time marches on.
    const second = collectMissedFrom(chart, runtime, first.nextIndex, 9999, 0, 0);
    expect(second.missedIds).toEqual([]);
    expect(second.nextIndex).toBe(2);
  });

  it("skips notes that were hit before their deadline but still advances", () => {
    const chart = [makeNote("a", 1000, 0), makeNote("b", 1100, 1)];
    const runtime = runtimeFor(chart);
    runtime.set("a", { judged: true, rating: "perfect" }); // hit earlier
    const res = collectMissedFrom(chart, runtime, 0, 3000, 0, 0);
    expect(res.missedIds).toEqual(["b"]); // 'a' judged → not a miss
    expect(res.nextIndex).toBe(2); // cursor still clears both
  });

  it("catches every note when many cross the line in one frame (lag spike)", () => {
    const chart = sortNotes([
      makeNote("a", 100, 0),
      makeNote("b", 200, 1),
      makeNote("c", 300, 2),
      makeNote("d", 400, 3),
    ]);
    const runtime = runtimeFor(chart);
    // Jump straight past all of them in a single frame.
    const res = collectMissedFrom(chart, runtime, 0, 10_000, 0, 0);
    expect(res.missedIds.sort()).toEqual(["a", "b", "c", "d"]);
    expect(res.nextIndex).toBe(4);
  });

  it("accounts for chart offset and calibration like the reference scan", () => {
    const chart = [makeNote("a", 1000, 0)];
    const runtime = runtimeFor(chart);
    // offset +300 pushes the effective time (and its deadline) 300ms later.
    const t = 1000 + MISS_THRESHOLD_MS + 100;
    expect(collectMissedFrom(chart, runtime, 0, t, 300, 0).missedIds).toEqual([]);
    expect(collectMissedFrom(chart, runtime, 0, t, 0, 0).missedIds).toEqual(["a"]);
  });

  it("frame-by-frame cursor sweep matches findNewlyMissedNoteIds", () => {
    const chart = buildChart(250);
    // Two independent runtimes: one driven by the cursor, one by the reference
    // full scan. They must reach identical judged state at every step.
    const cursorRt = runtimeFor(chart);
    const refRt = runtimeFor(chart);
    let cursor = 0;

    for (let t = 0; t < chart.length * 140 + 500; t += 19) {
      // Cursor-based (what the hook does).
      const { missedIds, nextIndex } = collectMissedFrom(chart, cursorRt, cursor, t, 0, 0);
      cursor = nextIndex;
      for (const id of missedIds) cursorRt.set(id, { judged: true, rating: "miss" });

      // Reference: rescan the whole chart every frame.
      const refMissed = findNewlyMissedNoteIds(chart, refRt, t, 0, 0);
      for (const id of refMissed) refRt.set(id, { judged: true, rating: "miss" });

      expect(missedIds.slice().sort()).toEqual(refMissed.slice().sort());
    }

    // Everything ends up missed exactly once, in both models.
    const missedCursor = [...cursorRt.values()].filter((s) => s.rating === "miss").length;
    expect(missedCursor).toBe(chart.length);
    expect(cursor).toBe(chart.length);
  });
});
