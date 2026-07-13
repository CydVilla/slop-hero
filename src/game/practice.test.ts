/**
 * Tests for practice mode's pure logic: sectioning a chart, the pre-resolved
 * loop runtime, and the loop timing helpers. The hook is a thin wrapper that
 * seeks the clock; everything decision-shaped lives here.
 */

import { describe, expect, it } from "vitest";

import { PRACTICE } from "./constants";
import { beatsToMs } from "./chartUtils";
import {
  chartSections,
  practiceLoopEnded,
  practicePlayFromMs,
  practiceRuntime,
} from "./practice";
import type { ChartNote, Lane, RhythmChart } from "./types";

function makeNote(id: string, timeMs: number, lane: Lane = 0): ChartNote {
  return { id, timeMs, lane, type: "tap" };
}

function chartOf(notes: ChartNote[], bpm?: number): RhythmChart {
  return { id: "t", title: "t", bpm, offsetMs: 0, difficulty: "medium", notes };
}

describe("chartSections", () => {
  it("splits by 8 bars with a tempo and labels bar ranges", () => {
    // 120 BPM → a section is 32 beats = 16s. Notes in sections 0 and 2 only.
    const notes = [
      makeNote("a", 1000),
      makeNote("b", 8000),
      makeNote("c", beatsToMs(70, 120)), // 35s → third section (64–96 beats)
    ];
    const sections = chartSections(chartOf(notes, 120));
    expect(sections).toHaveLength(2); // the empty middle section is dropped
    expect(sections[0]).toMatchObject({
      startMs: 0,
      endMs: beatsToMs(32, 120),
      noteCount: 2,
      label: "Bars 1–8",
    });
    expect(sections[1]).toMatchObject({
      startMs: beatsToMs(64, 120),
      noteCount: 1,
      label: "Bars 17–24",
    });
  });

  it("falls back to time-window sections without a tempo", () => {
    const notes = [makeNote("a", 1000), makeNote("b", 20_000)];
    const sections = chartSections(chartOf(notes));
    expect(sections).toHaveLength(2);
    expect(sections[0]?.endMs).toBe(PRACTICE.fallbackSectionMs);
    expect(sections[0]?.label).toContain("0:00");
  });

  it("returns nothing for empty charts", () => {
    expect(chartSections(chartOf([]))).toEqual([]);
  });
});

describe("practiceRuntime", () => {
  it("pre-resolves notes outside the section and counts the rest", () => {
    const notes = [
      makeNote("before", 500),
      makeNote("in1", 1500),
      makeNote("in2", 2500),
      makeNote("after", 5000),
    ];
    const { runtime, inSectionCount } = practiceRuntime(notes, {
      startMs: 1000,
      endMs: 3000,
    });
    expect(inSectionCount).toBe(2);
    expect(runtime.get("before")?.judged).toBe(true);
    expect(runtime.get("in1")?.judged).toBe(false);
    expect(runtime.get("in2")?.judged).toBe(false);
    expect(runtime.get("after")?.judged).toBe(true);
    // Pre-resolved notes carry no rating: silent, no feedback, not scored.
    expect(runtime.get("before")?.rating).toBeUndefined();
  });
});

describe("loop timing", () => {
  const section = { startMs: 10_000, endMs: 20_000 };

  it("starts playback a lead-in before the section (clamped at zero)", () => {
    expect(practicePlayFromMs(section)).toBe(10_000 - PRACTICE.leadInMs);
    expect(practicePlayFromMs({ startMs: 500 })).toBe(0);
  });

  it("wraps only after the section end plus the resolve tail", () => {
    expect(practiceLoopEnded(section, 20_000)).toBe(false);
    expect(practiceLoopEnded(section, 20_000 + PRACTICE.loopTailMs - 1)).toBe(false);
    expect(practiceLoopEnded(section, 20_000 + PRACTICE.loopTailMs)).toBe(true);
  });
});
