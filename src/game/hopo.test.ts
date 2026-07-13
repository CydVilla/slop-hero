/**
 * Tests for HOPOs (hammer-ons / pull-offs):
 *   - natural marking rules (spacing, different lane, chords excluded)
 *   - ensureHopos passthrough vs auto-marking
 *   - the per-frame auto-hit finder (held lane + previous-note-hit chain)
 *
 * The gameplay hook applies auto-hits through the same path as taps, so
 * covering the pure finder covers the mechanic.
 */

import { describe, expect, it } from "vitest";

import { HIT_WINDOWS, HOPO } from "./constants";
import {
  ensureHopos,
  findHopoAutoHits,
  hopoGapMs,
  markNaturalHopos,
} from "./hopo";
import { beatsToMs } from "./chartUtils";
import type { ChartNote, Lane, NoteRuntimeState, RhythmChart } from "./types";

function makeNote(
  id: string,
  timeMs: number,
  lane: Lane,
  hopo?: boolean,
): ChartNote {
  return { id, timeMs, lane, type: "tap", hopo };
}

function runtimeFor(notes: readonly ChartNote[]): Map<string, NoteRuntimeState> {
  const map = new Map<string, NoteRuntimeState>();
  for (const n of notes) map.set(n.id, { judged: false });
  return map;
}

describe("hopoGapMs", () => {
  it("scales with tempo and falls back without one", () => {
    expect(hopoGapMs(120)).toBeCloseTo(beatsToMs(HOPO.beatFraction, 120));
    expect(hopoGapMs(240)).toBeCloseTo(hopoGapMs(120) / 2);
    expect(hopoGapMs(undefined)).toBe(HOPO.fallbackGapMs);
    expect(hopoGapMs(0)).toBe(HOPO.fallbackGapMs);
  });
});

describe("markNaturalHopos", () => {
  // At 120 BPM the natural gap is ~169ms; 150ms spacing is inside, 400 is not.
  const BPM = 120;

  it("marks fast different-lane runs, leaves slow or same-lane notes", () => {
    const notes = [
      makeNote("a", 1000, 0),
      makeNote("b", 1150, 1), // fast, new lane → HOPO
      makeNote("c", 1300, 1), // fast, SAME lane → tap
      makeNote("d", 1700, 2), // slow → tap
      makeNote("e", 1850, 3), // fast, new lane → HOPO
    ];
    const marked = markNaturalHopos(notes, BPM);
    expect(marked.map((n) => n.hopo)).toEqual([false, true, false, false, true]);
    // Input untouched; every output note carries an explicit flag.
    expect(notes.every((n) => n.hopo === undefined)).toBe(true);
  });

  it("never marks chords, but a single note after a chord can be one", () => {
    const notes = [
      makeNote("a", 1000, 0),
      makeNote("b", 1150, 1),
      makeNote("c", 1150, 2), // chord partner
      makeNote("d", 1300, 3), // single note after the chord, new lane → HOPO
      makeNote("e", 1450, 1), // lane 1 was in the chord? no — chord was b/c at 1150; prev group is d
    ];
    const marked = markNaturalHopos(notes, BPM);
    const byId = new Map(marked.map((n) => [n.id, n.hopo]));
    expect(byId.get("b")).toBe(false);
    expect(byId.get("c")).toBe(false);
    expect(byId.get("d")).toBe(true);
    expect(byId.get("e")).toBe(true);
  });

  it("requires the new lane to differ from EVERY note of a preceding chord", () => {
    const notes = [
      makeNote("a", 1000, 1),
      makeNote("b", 1000, 3),
      makeNote("c", 1150, 3), // lane 3 is in the chord → tap
      makeNote("d", 1300, 0), // differs from lane 3 → HOPO
    ];
    const marked = markNaturalHopos(notes, BPM);
    const byId = new Map(marked.map((n) => [n.id, n.hopo]));
    expect(byId.get("c")).toBe(false);
    expect(byId.get("d")).toBe(true);
  });
});

describe("ensureHopos", () => {
  function chartOf(notes: ChartNote[], bpm?: number): RhythmChart {
    return { id: "t", title: "t", bpm, offsetMs: 0, difficulty: "medium", notes };
  }

  it("keeps authored flags untouched (same object)", () => {
    const chart = chartOf([makeNote("a", 0, 0, false), makeNote("b", 100, 1)]);
    expect(ensureHopos(chart)).toBe(chart);
  });

  it("auto-marks charts without flags", () => {
    const chart = chartOf([makeNote("a", 1000, 0), makeNote("b", 1100, 1)], 120);
    const ensured = ensureHopos(chart);
    expect(ensured).not.toBe(chart);
    expect(ensured.notes[1]?.hopo).toBe(true);
  });

  it("returns the same chart when nothing qualifies", () => {
    const chart = chartOf([makeNote("a", 0, 0), makeNote("b", 5000, 1)], 120);
    expect(ensureHopos(chart)).toBe(chart);
  });
});

describe("findHopoAutoHits", () => {
  const OFFSET = 0;
  const CAL = 0;
  const notes = [
    makeNote("a", 1000, 0, false),
    makeNote("b", 1150, 1, true),
    makeNote("c", 1300, 2, true),
  ];

  function hitsAt(
    runtime: Map<string, NoteRuntimeState>,
    held: Lane[],
    songTimeMs: number,
  ) {
    return findHopoAutoHits(
      notes,
      runtime,
      new Set(held),
      songTimeMs,
      OFFSET,
      CAL,
    );
  }

  it("fires for a held lane when the previous note was hit", () => {
    const runtime = runtimeFor(notes);
    runtime.set("a", { judged: true, rating: "perfect" });
    const hits = hitsAt(runtime, [1], 1150);
    expect(hits.map((h) => h.note.id)).toEqual(["b"]);
    expect(Math.abs(hits[0]!.errorMs)).toBeLessThanOrEqual(HIT_WINDOWS.perfect);
  });

  it("stays quiet when the lane is not held", () => {
    const runtime = runtimeFor(notes);
    runtime.set("a", { judged: true, rating: "perfect" });
    expect(hitsAt(runtime, [0, 2, 3, 4], 1150)).toEqual([]);
  });

  it("requires the previous note to be hit — a miss breaks the chain", () => {
    const missed = runtimeFor(notes);
    missed.set("a", { judged: true, rating: "miss" });
    expect(hitsAt(missed, [1], 1150)).toEqual([]);

    const pending = runtimeFor(notes); // previous not judged at all
    expect(hitsAt(pending, [1], 1150)).toEqual([]);
  });

  it("only fires inside the perfect window", () => {
    const runtime = runtimeFor(notes);
    runtime.set("a", { judged: true, rating: "perfect" });
    expect(hitsAt(runtime, [1], 1150 - HIT_WINDOWS.perfect - 1)).toEqual([]);
    expect(hitsAt(runtime, [1], 1150 + HIT_WINDOWS.perfect + 1)).toEqual([]);
  });

  it("never re-fires a judged note and never fires the first note", () => {
    const runtime = runtimeFor(notes);
    runtime.set("a", { judged: true, rating: "perfect" });
    runtime.set("b", { judged: true, rating: "perfect" });
    expect(hitsAt(runtime, [1], 1150)).toEqual([]);

    const first = [makeNote("z", 500, 0, true), ...notes];
    expect(
      findHopoAutoHits(first, runtimeFor(first), new Set([0]), 500, OFFSET, CAL),
    ).toEqual([]);
  });

  it("chains through consecutive HOPOs as each one lands", () => {
    const runtime = runtimeFor(notes);
    runtime.set("a", { judged: true, rating: "perfect" });
    const [first] = hitsAt(runtime, [1, 2], 1150);
    runtime.set(first!.note.id, { judged: true, rating: "perfect" });
    const second = hitsAt(runtime, [1, 2], 1300);
    expect(second.map((h) => h.note.id)).toEqual(["c"]);
  });
});
