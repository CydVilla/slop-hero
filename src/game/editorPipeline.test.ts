/**
 * Integration test for the editor → play pipeline: notes painted in the
 * editor (★ brush markers included) flow through groupStarPhrases →
 * ensureStarPhrases → ensureHopos into exactly the chart the game plays —
 * authored phrases preserved, natural HOPOs marked, and the auto-hit finder
 * firing against them. Mirrors the browser-verified scenario (a tapped seed
 * note followed by a fast alternating run played entirely by held lanes).
 */

import { describe, expect, it } from "vitest";

import { beatsToMs } from "./chartUtils";
import { ensureHopos, findHopoAutoHits } from "./hopo";
import { ensureStarPhrases, groupStarPhrases } from "./starPower";
import type { ChartNote, Lane, NoteRuntimeState, RhythmChart } from "./types";

function editorNote(beat: number, lane: Lane, star: boolean): ChartNote {
  const n: ChartNote = {
    id: `ed_${beat}_${lane}`,
    timeMs: beatsToMs(beat, 120),
    lane,
    type: "tap",
  };
  if (star) n.starPhrase = 0; // the ★ brush marker (renumbered at build)
  return n;
}

describe("editor chart → play pipeline", () => {
  it("keeps authored phrases, marks the fast runs as HOPOs, and auto-hits them", () => {
    const notes = [
      editorNote(4, 0, true),
      editorNote(4.25, 1, true),
      editorNote(4.5, 2, true),
      editorNote(4.75, 1, true),
      editorNote(5, 2, true),
      editorNote(8, 0, false),
      editorNote(8.25, 1, false),
      editorNote(8.5, 2, false),
      editorNote(8.75, 1, false),
      editorNote(9, 2, false),
    ];
    const raw: RhythmChart = {
      id: "editor",
      title: "t",
      bpm: 120,
      offsetMs: 0,
      difficulty: "medium",
      notes: groupStarPhrases(notes),
    };
    const chart = ensureHopos(ensureStarPhrases(raw));

    // Authored phrase survives (ensureStarPhrases must not re-mark).
    const starred = chart.notes.filter((n) => n.starPhrase !== undefined);
    expect(starred).toHaveLength(5);
    expect(new Set(starred.map((n) => n.starPhrase))).toEqual(new Set([0]));

    // Every 1/4-beat run note is a natural HOPO; seeds and the slow gap not.
    const hopos = chart.notes.filter((n) => n.hopo).map((n) => n.timeMs);
    expect(hopos).toEqual([2125, 2250, 2375, 2500, 4125, 4250, 4375, 4500]);

    // Seed hit → the first run note auto-fires against a merely-held lane.
    const runtime = new Map<string, NoteRuntimeState>(
      chart.notes.map((n) => [n.id, { judged: false }]),
    );
    const seed = chart.notes.find((n) => n.timeMs === 2000)!;
    runtime.set(seed.id, { judged: true, rating: "great" });
    const hits = findHopoAutoHits(
      chart.notes,
      runtime,
      new Set<Lane>([1, 2]),
      2125,
      0,
      0,
    );
    expect(hits.map((h) => h.note.timeMs)).toEqual([2125]);
  });
});
