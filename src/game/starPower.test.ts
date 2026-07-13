/**
 * Tests for the star power system:
 *   - the meter state machine (award / activate / drain / extend / deplete)
 *   - phrase progress tracking (award exactly once, broken phrases never award)
 *   - deterministic auto-marking of star phrases on unmarked charts
 *   - score stacking (star power × combo multiplier) and the star rating
 *
 * The gameplay hook is a thin wrapper over these pure functions, so covering
 * them covers the mechanic itself.
 */

import { describe, expect, it } from "vitest";

import { SCORE_VALUES, STAR_POWER } from "./constants";
import {
  applyHit,
  baseChartScore,
  createInitialScore,
  starRating,
} from "./scoring";
import {
  activateStarPower,
  awardStarPhrase,
  buildPhraseIndex,
  canActivateStarPower,
  createStarPower,
  ensureStarPhrases,
  markStarPhrases,
  registerStarNoteHit,
  registerStarNoteMiss,
  starPowerMeterAt,
  starPowerScoreMultiplier,
  tickStarPower,
} from "./starPower";
import type { ChartNote, RhythmChart } from "./types";

/** Build a chart note quickly. */
function makeNote(
  id: string,
  timeMs: number,
  lane: ChartNote["lane"],
  starPhrase?: number,
): ChartNote {
  return { id, timeMs, lane, type: "tap", starPhrase };
}

/** N tap notes spaced `gapMs` apart, cycling lanes. */
function evenNotes(count: number, gapMs: number): ChartNote[] {
  return Array.from({ length: count }, (_, i) =>
    makeNote(`n${i}`, i * gapMs, (i % 5) as ChartNote["lane"]),
  );
}

describe("star power meter", () => {
  it("starts empty and inactive", () => {
    const sp = createStarPower();
    expect(sp.meter).toBe(0);
    expect(sp.active).toBe(false);
    expect(starPowerMeterAt(sp, 1234)).toBe(0);
  });

  it("banks a quarter bar per phrase and clamps at full", () => {
    let sp = createStarPower();
    for (let i = 0; i < 6; i += 1) sp = awardStarPhrase(sp, 1000 * i);
    expect(sp.meter).toBe(1);
    expect(sp.phrasesCompleted).toBe(6);
  });

  it("cannot activate below half a bar, can at half", () => {
    let sp = awardStarPhrase(createStarPower(), 0);
    expect(canActivateStarPower(sp, 0)).toBe(false);
    expect(activateStarPower(sp, 0)).toBe(sp); // no-op returns same state
    sp = awardStarPhrase(sp, 0);
    expect(starPowerMeterAt(sp, 0)).toBeCloseTo(STAR_POWER.activationMin);
    expect(canActivateStarPower(sp, 0)).toBe(true);
  });

  it("drains linearly while active and deactivates when empty", () => {
    let sp = awardStarPhrase(awardStarPhrase(createStarPower(), 0), 0); // 0.5
    sp = activateStarPower(sp, 10_000);
    expect(sp.active).toBe(true);

    // Half a bar lasts half of fullBarDrainMs.
    const midway = 10_000 + STAR_POWER.fullBarDrainMs / 4;
    expect(starPowerMeterAt(sp, midway)).toBeCloseTo(0.25);
    expect(tickStarPower(sp, midway)).toBe(sp); // still burning → same state

    const done = 10_000 + STAR_POWER.fullBarDrainMs / 2 + 1;
    const settled = tickStarPower(sp, done);
    expect(settled.active).toBe(false);
    expect(settled.meter).toBe(0);
    expect(canActivateStarPower(settled, done)).toBe(false);
  });

  it("extends an active run when another phrase lands", () => {
    let sp = awardStarPhrase(awardStarPhrase(createStarPower(), 0), 0); // 0.5
    sp = activateStarPower(sp, 0);
    const quarterIn = STAR_POWER.fullBarDrainMs / 8; // burned 0.125 → 0.375 left
    sp = awardStarPhrase(sp, quarterIn);
    expect(sp.active).toBe(true);
    expect(starPowerMeterAt(sp, quarterIn)).toBeCloseTo(0.625);
  });

  it("doubles scoring only while active", () => {
    const idle = createStarPower();
    expect(starPowerScoreMultiplier(idle)).toBe(1);
    const active = activateStarPower(
      awardStarPhrase(awardStarPhrase(idle, 0), 0),
      0,
    );
    expect(starPowerScoreMultiplier(active)).toBe(STAR_POWER.scoreMultiplier);
  });
});

describe("phrase progress tracking", () => {
  const notes = [
    makeNote("a", 0, 0, 0),
    makeNote("b", 500, 1, 0),
    makeNote("c", 1000, 2, 0),
    makeNote("d", 5000, 3, 1),
  ];

  it("awards exactly once, on the hit that completes the phrase", () => {
    const index = buildPhraseIndex(notes);
    expect(registerStarNoteHit(index, 0)).toBe(false);
    expect(registerStarNoteHit(index, 0)).toBe(false);
    expect(registerStarNoteHit(index, 0)).toBe(true); // 3/3 → award now
  });

  it("a single miss kills the phrase's award", () => {
    const index = buildPhraseIndex(notes);
    expect(registerStarNoteHit(index, 0)).toBe(false);
    registerStarNoteMiss(index, 0);
    expect(registerStarNoteHit(index, 0)).toBe(false);
    expect(registerStarNoteHit(index, 0)).toBe(false); // all resolved, no award
  });

  it("phrases are independent", () => {
    const index = buildPhraseIndex(notes);
    registerStarNoteMiss(index, 0);
    expect(registerStarNoteHit(index, 1)).toBe(true); // 1-note phrase completes
  });

  it("ignores unknown phrase ids", () => {
    const index = buildPhraseIndex(notes);
    expect(registerStarNoteHit(index, 99)).toBe(false);
    registerStarNoteMiss(index, 99); // must not throw
  });
});

describe("markStarPhrases", () => {
  it("marks phrases after the intro, separated by long gaps", () => {
    const notes = evenNotes(40, 500); // 0..19500ms
    const marked = markStarPhrases(notes);

    const starred = marked.filter((n) => n.starPhrase !== undefined);
    const phraseIds = new Set(starred.map((n) => n.starPhrase));
    expect(phraseIds.size).toBeGreaterThanOrEqual(2);

    // Nothing in the intro is starred.
    for (const n of marked.slice(0, 8)) expect(n.starPhrase).toBeUndefined();

    // Phrases are contiguous runs with a long quiet gap between them.
    const byPhrase = new Map<number, ChartNote[]>();
    for (const n of starred) {
      const list = byPhrase.get(n.starPhrase as number) ?? [];
      list.push(n);
      byPhrase.set(n.starPhrase as number, list);
    }
    const ranges = [...byPhrase.values()]
      .map((list) => ({
        start: Math.min(...list.map((n) => n.timeMs)),
        end: Math.max(...list.map((n) => n.timeMs)),
      }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]!.start - ranges[i - 1]!.end).toBeGreaterThanOrEqual(10_000);
    }
  });

  it("is deterministic and does not mutate its input", () => {
    const notes = evenNotes(40, 500);
    const a = markStarPhrases(notes);
    const b = markStarPhrases(notes);
    expect(a.map((n) => n.starPhrase)).toEqual(b.map((n) => n.starPhrase));
    for (const n of notes) expect(n.starPhrase).toBeUndefined();
  });

  it("never splits a chord across the phrase boundary", () => {
    const notes = evenNotes(14, 500);
    // Chord partner exactly at what would be the 6-note phrase cutoff
    // (intro = 8 notes → phrase covers notes 8..13; note 13 is at 6500ms).
    notes.push(makeNote("chord", 6500, 4));
    const marked = markStarPhrases(notes);
    const atCut = marked.filter((n) => n.timeMs === 6500);
    expect(atCut.length).toBe(2);
    const [x, y] = atCut;
    expect(x!.starPhrase).toBeDefined();
    expect(x!.starPhrase).toBe(y!.starPhrase);
  });

  it("leaves charts too short to phrase untouched", () => {
    const marked = markStarPhrases(evenNotes(9, 500));
    // 8 intro notes + 1 leftover — a 1-note phrase is below the minimum.
    expect(marked.every((n) => n.starPhrase === undefined)).toBe(true);
  });
});

describe("ensureStarPhrases", () => {
  function chartOf(notes: ChartNote[]): RhythmChart {
    return { id: "t", title: "t", offsetMs: 0, difficulty: "medium", notes };
  }

  it("keeps authored phrases untouched (same object)", () => {
    const chart = chartOf([makeNote("a", 0, 0, 3), makeNote("b", 100, 1)]);
    expect(ensureStarPhrases(chart)).toBe(chart);
  });

  it("auto-marks charts without phrases", () => {
    const chart = chartOf(evenNotes(40, 500));
    const ensured = ensureStarPhrases(chart);
    expect(ensured).not.toBe(chart);
    expect(ensured.notes.some((n) => n.starPhrase !== undefined)).toBe(true);
  });

  it("returns the same chart when marking finds nothing to star", () => {
    const chart = chartOf(evenNotes(4, 500));
    expect(ensureStarPhrases(chart)).toBe(chart);
  });
});

describe("score stacking and star rating", () => {
  it("stacks the star power multiplier on the combo multiplier", () => {
    const s0 = { ...createInitialScore(10), combo: 9 }; // next hit → combo 10 → ×2
    const s1 = applyHit(s0, "perfect", STAR_POWER.scoreMultiplier);
    expect(s1.score).toBe(SCORE_VALUES.perfect * 2 * 2);
  });

  it("baseChartScore counts perfects plus sustain bonuses, no multipliers", () => {
    const notes: ChartNote[] = [
      makeNote("a", 0, 0),
      { id: "h", timeMs: 500, lane: 1, durationMs: 1000, type: "hold" },
    ];
    // 2 perfects + 1000ms of sustain at 0.5 pts/ms.
    expect(baseChartScore(notes)).toBe(2 * SCORE_VALUES.perfect + 500);
  });

  it("maps the score/base ratio onto 0–5 stars", () => {
    expect(starRating(0, 10_000)).toBe(0);
    expect(starRating(4_000, 10_000)).toBe(1);
    expect(starRating(10_000, 10_000)).toBe(2);
    expect(starRating(18_000, 10_000)).toBe(3);
    expect(starRating(26_000, 10_000)).toBe(4);
    expect(starRating(34_000, 10_000)).toBe(5);
    expect(starRating(999_999, 0)).toBe(0); // degenerate chart
  });
});
