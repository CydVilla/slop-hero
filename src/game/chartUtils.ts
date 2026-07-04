/**
 * Chart helpers: id generation, sorting, validation, and runtime-state
 * construction. Pure and side-effect free.
 */

import { LANE_COUNT } from "./constants";
import type {
  ChartNote,
  Lane,
  NoteRuntimeState,
  RhythmChart,
} from "./types";

let idCounter = 0;

/**
 * Deterministic-ish unique id for notes. Not cryptographic; just needs to be
 * unique within a chart. Prefix lets us tell generated notes apart in logs.
 */
export function makeNoteId(prefix = "n"): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}`;
}

/** Type guard for a valid lane index. */
export function isLane(value: number): value is Lane {
  return Number.isInteger(value) && value >= 0 && value < LANE_COUNT;
}

/** Return notes sorted ascending by time (stable for equal times by lane). */
export function sortNotes(notes: readonly ChartNote[]): ChartNote[] {
  return [...notes].sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
}

/**
 * Build the initial per-note runtime map (all unjudged). Kept separate from the
 * chart so the immutable chart can be reused across attempts.
 */
export function createRuntimeState(
  chart: RhythmChart,
): Map<string, NoteRuntimeState> {
  const map = new Map<string, NoteRuntimeState>();
  for (const note of chart.notes) {
    map.set(note.id, { judged: false });
  }
  return map;
}

/**
 * Index of the first note whose `timeMs` is >= `timeMs`, found by binary search.
 * If every note is earlier, returns `notes.length`.
 *
 * REQUIRES `notes` sorted ascending by `timeMs` (the invariant every chart
 * source upholds — generators emit in order and importers run {@link sortNotes}).
 * This is the primitive the gameplay hook uses to turn its per-frame / per-tap
 * "which notes are near the hit line right now" scans from O(n) into
 * O(log n) + O(window). O(log n).
 */
export function firstIndexAtOrAfter(
  notes: readonly ChartNote[],
  timeMs: number,
): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((notes[mid] as ChartNote).timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Half-open index range `[lo, hi)` of the notes whose `timeMs` falls within the
 * inclusive `[minTimeMs, maxTimeMs]` window. A tiny epsilon on the upper bound
 * keeps notes sitting exactly on `maxTimeMs` inside the range despite floating
 * point (note times come from `beatsToMs`, so they are rarely integers).
 *
 * REQUIRES `notes` sorted ascending by `timeMs`. O(log n).
 */
export function noteIndexRange(
  notes: readonly ChartNote[],
  minTimeMs: number,
  maxTimeMs: number,
): [number, number] {
  const lo = firstIndexAtOrAfter(notes, minTimeMs);
  const hi = firstIndexAtOrAfter(notes, maxTimeMs + 1e-6);
  return [lo, Math.max(lo, hi)];
}

/** Total chart duration in ms (last note end), useful for progress bars. */
export function chartDurationMs(chart: RhythmChart): number {
  let max = 0;
  for (const note of chart.notes) {
    const end = note.timeMs + (note.durationMs ?? 0);
    if (end > max) max = end;
  }
  return max;
}

/**
 * Validate a parsed chart enough to fail loudly on obviously-broken data
 * (e.g. imported JSON). Returns the chart for fluent use or throws.
 */
export function assertValidChart(chart: RhythmChart): RhythmChart {
  if (!chart.id) throw new Error("Chart is missing an id.");
  if (!Array.isArray(chart.notes)) throw new Error("Chart.notes must be an array.");
  for (const note of chart.notes) {
    if (!isLane(note.lane)) {
      throw new Error(`Note ${note.id} has invalid lane ${note.lane}.`);
    }
    if (!Number.isFinite(note.timeMs) || note.timeMs < 0) {
      throw new Error(`Note ${note.id} has invalid timeMs ${note.timeMs}.`);
    }
  }
  return chart;
}

/** Beats -> milliseconds at a given BPM. */
export function beatsToMs(beats: number, bpm: number): number {
  return (beats / bpm) * 60_000;
}

/** Milliseconds -> beats at a given BPM. */
export function msToBeats(ms: number, bpm: number): number {
  return (ms / 60_000) * bpm;
}
