/**
 * Tests for the hold / sustain feature.
 *
 * These exercise the PURE engine that powers hold notes end to end:
 *   - classifying a note as a hold (isHoldNote)
 *   - the sustain-end timing helper
 *   - starting a hold from a head tap (resolveTap.startsHold)
 *   - resolving a release into completed / dropped / none (resolveRelease)
 *   - auto-completing a held tail each frame (findCompletedHoldIds)
 *   - scoring: sustain bonus, combo behaviour on complete vs. drop
 *   - a couple of full "press → hold → resolve" scenarios stitched together
 *
 * The gameplay hook (useRhythmGame) and the canvas are thin wrappers over these
 * functions, so covering them here covers the mechanic itself.
 */

import { describe, expect, it } from "vitest";

import {
  HIT_WINDOWS,
  HOLD_RELEASE_GRACE_MS,
  MIN_HOLD_MS,
  SCORE_VALUES,
  SUSTAIN_POINTS_PER_MS,
} from "./constants";
import {
  applyHit,
  applyHoldComplete,
  applyHoldDrop,
  createInitialScore,
  findCompletedHoldIds,
  holdBonusPoints,
  isHoldNote,
  resolveRelease,
  resolveTap,
} from "./scoring";
import { sustainEndTimeMs } from "./timing";
import type { ChartNote, NoteRuntimeState } from "./types";

/** Build a chart note quickly. */
function makeNote(
  id: string,
  timeMs: number,
  lane: ChartNote["lane"],
  durationMs?: number,
): ChartNote {
  return {
    id,
    timeMs,
    lane,
    durationMs,
    type: durationMs ? "hold" : "tap",
  };
}

/** Runtime map seeded from a list of notes (all unjudged). */
function runtimeFor(notes: readonly ChartNote[]): Map<string, NoteRuntimeState> {
  const map = new Map<string, NoteRuntimeState>();
  for (const n of notes) map.set(n.id, { judged: false });
  return map;
}

describe("isHoldNote", () => {
  it("treats a note with a long-enough duration as a hold", () => {
    expect(isHoldNote({ durationMs: MIN_HOLD_MS })).toBe(true);
    expect(isHoldNote({ durationMs: MIN_HOLD_MS + 500, type: "hold" })).toBe(true);
  });

  it("treats short or zero durations as taps", () => {
    expect(isHoldNote({ durationMs: 0 })).toBe(false);
    expect(isHoldNote({})).toBe(false);
    expect(isHoldNote({ durationMs: MIN_HOLD_MS - 1 })).toBe(false);
  });

  it("honours an explicit type: 'tap' even with a duration", () => {
    expect(isHoldNote({ durationMs: 1000, type: "tap" })).toBe(false);
  });

  it("does not promote a tiny sustain just because type says hold", () => {
    expect(isHoldNote({ durationMs: 50, type: "hold" })).toBe(false);
  });
});

describe("sustainEndTimeMs", () => {
  it("is the effective head time plus the duration", () => {
    const note = makeNote("a", 1000, 0, 500);
    // offset +100, calibration -50 → effective head = 1000 + 100 - (-50) = 1150
    expect(sustainEndTimeMs(note, 100, -50)).toBe(1150 + 500);
  });

  it("equals the head time when there is no duration", () => {
    const note = makeNote("a", 1000, 0);
    expect(sustainEndTimeMs(note, 0, 0)).toBe(1000);
  });
});

describe("resolveTap on a hold head", () => {
  it("reports startsHold=true when the head of a hold is hit", () => {
    const notes = [makeNote("h", 1000, 2, 800)];
    const runtime = runtimeFor(notes);
    const result = resolveTap(notes, runtime, 2, 1000, 0, 0);
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      expect(result.startsHold).toBe(true);
      expect(result.rating).toBe("perfect");
    }
  });

  it("reports startsHold=false for a plain tap", () => {
    const notes = [makeNote("t", 1000, 2)];
    const runtime = runtimeFor(notes);
    const result = resolveTap(notes, runtime, 2, 1000, 0, 0);
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      expect(result.startsHold).toBe(false);
    }
  });

  it("still misses when the head is outside the good window", () => {
    const notes = [makeNote("h", 1000, 2, 800)];
    const runtime = runtimeFor(notes);
    const late = 1000 + HIT_WINDOWS.good + 5;
    expect(resolveTap(notes, runtime, 2, late, 0, 0).kind).toBe("miss-input");
  });
});

describe("resolveRelease", () => {
  const note = makeNote("h", 1000, 1, 500); // ends at 1500 (offset/cal 0)
  const holding = (): Map<string, NoteRuntimeState> =>
    new Map([["h", { judged: true, rating: "perfect", hold: "holding" }]]);

  it("returns 'none' when no sustain is being held in the lane", () => {
    const runtime = new Map<string, NoteRuntimeState>([
      ["h", { judged: true, rating: "perfect" }],
    ]);
    expect(resolveRelease([note], runtime, 1, 1500, 0, 0).kind).toBe("none");
  });

  it("returns 'none' for a release in a different lane", () => {
    expect(resolveRelease([note], holding(), 3, 1500, 0, 0).kind).toBe("none");
  });

  it("completes a release at the exact tail end", () => {
    expect(resolveRelease([note], holding(), 1, 1500, 0, 0).kind).toBe("completed");
  });

  it("completes a release within the grace window before the end", () => {
    const t = 1500 - HOLD_RELEASE_GRACE_MS; // exactly on the grace boundary
    expect(resolveRelease([note], holding(), 1, t, 0, 0).kind).toBe("completed");
  });

  it("completes a late release (held slightly past the end)", () => {
    expect(resolveRelease([note], holding(), 1, 1600, 0, 0).kind).toBe("completed");
  });

  it("drops a release before the grace window", () => {
    const t = 1500 - HOLD_RELEASE_GRACE_MS - 1;
    const result = resolveRelease([note], holding(), 1, t, 0, 0);
    expect(result.kind).toBe("dropped");
    if (result.kind === "dropped") {
      expect(result.earlyMs).toBe(1500 - t);
    }
  });

  it("accounts for chart offset and calibration in the tail end", () => {
    // offset +200 → end shifts to 1700. A release at 1650 is within grace.
    expect(resolveRelease([note], holding(), 1, 1650, 200, 0).kind).toBe("completed");
    // Same release with no offset is early → dropped.
    expect(resolveRelease([note], holding(), 1, 1300, 0, 0).kind).toBe("dropped");
  });
});

describe("findCompletedHoldIds", () => {
  it("completes only holds whose tail has effectively elapsed", () => {
    const a = makeNote("a", 1000, 0, 500); // ends 1500
    const b = makeNote("b", 1000, 1, 2000); // ends 3000
    const runtime = new Map<string, NoteRuntimeState>([
      ["a", { judged: true, hold: "holding" }],
      ["b", { judged: true, hold: "holding" }],
    ]);
    // At t=1450 (>= 1500 - grace) only 'a' is done.
    expect(findCompletedHoldIds([a, b], runtime, 1450, 0, 0)).toEqual(["a"]);
    // Later both are done.
    expect(findCompletedHoldIds([a, b], runtime, 3000, 0, 0).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("ignores notes that are not currently holding", () => {
    const a = makeNote("a", 1000, 0, 500);
    const runtime = new Map<string, NoteRuntimeState>([
      ["a", { judged: true, hold: "completed" }],
    ]);
    expect(findCompletedHoldIds([a], runtime, 5000, 0, 0)).toEqual([]);
  });
});

describe("hold scoring", () => {
  it("scales the sustain bonus with duration", () => {
    expect(holdBonusPoints(1000)).toBe(Math.round(1000 * SUSTAIN_POINTS_PER_MS));
    expect(holdBonusPoints(0)).toBe(0);
    expect(holdBonusPoints(-50)).toBe(0);
  });

  it("adds the bonus at the current combo multiplier and keeps the combo", () => {
    const base = { ...createInitialScore(10), combo: 25, maxCombo: 25 };
    const after = applyHoldComplete(base, 1000);
    // combo 25 → ×3 multiplier
    expect(after.score).toBe(base.score + holdBonusPoints(1000) * 3);
    expect(after.combo).toBe(25);
    expect(after.maxCombo).toBe(25);
  });

  it("breaks combo on a drop without adding a miss or points", () => {
    const base = { ...createInitialScore(10), score: 4000, combo: 30, miss: 1 };
    const after = applyHoldDrop(base);
    expect(after.combo).toBe(0);
    expect(after.score).toBe(4000);
    expect(after.miss).toBe(1);
  });
});

describe("full hold scenarios", () => {
  it("head hit then held through the tail → head points + sustain bonus", () => {
    const note = makeNote("h", 1000, 0, 1000); // ends 2000
    const notes = [note];
    const runtime = runtimeFor(notes);
    let score = createInitialScore(1);

    // Press the head right on time.
    const tap = resolveTap(notes, runtime, 0, 1000, 0, 0);
    expect(tap.kind).toBe("hit");
    if (tap.kind === "hit") {
      runtime.set(note.id, {
        judged: true,
        rating: tap.rating,
        hold: tap.startsHold ? "holding" : undefined,
      });
      score = applyHit(score, tap.rating);
    }
    expect(score.score).toBe(SCORE_VALUES.perfect); // combo 1 → ×1

    // A frame late in the tail auto-completes the sustain.
    const done = findCompletedHoldIds(notes, runtime, 2000, 0, 0);
    expect(done).toEqual(["h"]);
    for (const id of done) {
      const prev = runtime.get(id)!;
      runtime.set(id, { ...prev, hold: "completed" });
    }
    score = applyHoldComplete(score, note.durationMs ?? 0);

    expect(runtime.get("h")?.hold).toBe("completed");
    expect(score.score).toBe(SCORE_VALUES.perfect + holdBonusPoints(1000));
    expect(score.combo).toBe(1);
    // The head still counts as exactly one judged note.
    expect(score.perfect).toBe(1);
  });

  it("head hit then released early → keeps head credit but breaks combo", () => {
    const note = makeNote("h", 1000, 0, 1000); // ends 2000
    const notes = [note];
    const runtime = runtimeFor(notes);
    let score = createInitialScore(1);

    const tap = resolveTap(notes, runtime, 0, 1000, 0, 0);
    if (tap.kind === "hit") {
      runtime.set(note.id, { judged: true, rating: tap.rating, hold: "holding" });
      score = applyHit(score, tap.rating);
    }
    const headScore = score.score;
    expect(score.combo).toBe(1);

    // Release way before the tail end → drop.
    const rel = resolveRelease(notes, runtime, 0, 1200, 0, 0);
    expect(rel.kind).toBe("dropped");
    if (rel.kind === "dropped") {
      runtime.set(note.id, { ...runtime.get(note.id)!, hold: "dropped" });
      score = applyHoldDrop(score);
    }

    expect(runtime.get("h")?.hold).toBe("dropped");
    expect(score.score).toBe(headScore); // head points retained
    expect(score.combo).toBe(0); // sustain drop broke the combo
    expect(score.miss).toBe(0); // but it is not counted as a miss
    // A held note that was already resolved must not re-complete on a later frame.
    expect(findCompletedHoldIds(notes, runtime, 5000, 0, 0)).toEqual([]);
  });

  it("a hold whose head is never pressed stays unjudged (times out like a tap)", () => {
    const note = makeNote("h", 1000, 0, 1000);
    const runtime = runtimeFor([note]);
    // Never pressed → never enters the holding state → not completable.
    expect(findCompletedHoldIds([note], runtime, 5000, 0, 0)).toEqual([]);
    expect(runtime.get("h")?.hold).toBeUndefined();
  });
});
