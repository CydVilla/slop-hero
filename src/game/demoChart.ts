/**
 * Hand-tuned demo chart so /play is immediately playable with no upload and no
 * audio file. It is built on a 120 BPM grid with a deliberately readable
 * pattern (runs, simple syncopation, a couple of light chords) to showcase the
 * gameplay loop. In demo mode the song time is driven by an internal timer
 * rather than real audio.
 */

import { beatsToMs, makeNoteId } from "./chartUtils";
import type { ChartNote, Lane, RhythmChart } from "./types";

const DEMO_BPM = 120;

/** Convenience: build a note at a beat position in a lane. */
function note(beat: number, lane: Lane, durationMs?: number): ChartNote {
  return {
    id: makeNoteId("demo"),
    timeMs: beatsToMs(beat, DEMO_BPM),
    lane,
    durationMs,
    type: durationMs ? "hold" : "tap",
  };
}

/**
 * A repeating 8-beat phrase, offset by `startBeat`. Keeps the demo lively
 * without hand-writing dozens of notes.
 */
function phrase(startBeat: number): ChartNote[] {
  return [
    note(startBeat + 0, 0),
    note(startBeat + 1, 1),
    note(startBeat + 2, 2),
    note(startBeat + 3, 3),
    note(startBeat + 4, 4),
    note(startBeat + 4.5, 3),
    note(startBeat + 5, 2),
    note(startBeat + 6, 1),
    note(startBeat + 6.5, 0),
    note(startBeat + 7, 2),
  ];
}

function buildDemoNotes(): ChartNote[] {
  const notes: ChartNote[] = [];

  // 4-beat lead-in with a simple climbing intro.
  notes.push(note(4, 0), note(5, 1), note(6, 2), note(7, 3));

  // Four phrases = 32 beats of main groove.
  for (let i = 0; i < 4; i += 1) {
    notes.push(...phrase(8 + i * 8));
  }

  // A small chord-flavoured outro.
  const outro = 40;
  notes.push(
    note(outro + 0, 0),
    note(outro + 0, 4),
    note(outro + 1, 1),
    note(outro + 2, 2),
    note(outro + 3, 1),
    note(outro + 3, 3),
    note(outro + 4, 2),
  );

  return notes;
}

export function createDemoChart(): RhythmChart {
  return {
    id: "demo_default",
    title: "Highway Demo",
    artist: "Slop Hero",
    bpm: DEMO_BPM,
    offsetMs: 0,
    difficulty: "medium",
    notes: buildDemoNotes(),
  };
}
