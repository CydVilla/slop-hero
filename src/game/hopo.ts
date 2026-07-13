/**
 * Hammer-ons / pull-offs (HOPOs), pure logic only.
 *
 * On a guitar controller a HOPO needs no strum if the previous note was hit.
 * The touch adaptation: a HOPO note AUTO-HITS when it crosses the hit line
 * while its lane is already held — a finger resting there, slid there, or a
 * held key — provided the previous note was hit. Fast cross-lane runs play by
 * sliding/walking fingers instead of machine-gun tapping.
 *
 * Marking follows Clone Hero's natural-HOPO rules: a non-chord note within
 * 65/192 of a beat of the previous note, on a lane the previous note(s) don't
 * use. `.chart` imports refine this with authored forced (`N 5`, flips the
 * natural state) and tap (`N 6`, always on) flags in the parser; every other
 * source gets naturals auto-marked here. Chords are never HOPOs.
 */

import { HIT_WINDOWS, HOPO } from "./constants";
import { beatsToMs, sortNotes } from "./chartUtils";
import { timingErrorMs } from "./timing";
import type { ChartNote, Lane, NoteRuntimeState, RhythmChart } from "./types";

/** Natural-HOPO spacing threshold in ms for a chart's tempo. */
export function hopoGapMs(bpm?: number): number {
  return bpm && bpm > 0 ? beatsToMs(HOPO.beatFraction, bpm) : HOPO.fallbackGapMs;
}

/**
 * Group indices of time-sorted notes into chords (same timeMs). Returns the
 * half-open [start, end) index ranges in order.
 */
function timeGroups(sorted: readonly ChartNote[]): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && (sorted[j] as ChartNote).timeMs === (sorted[i] as ChartNote).timeMs) {
      j += 1;
    }
    groups.push([i, j]);
    i = j;
  }
  return groups;
}

/**
 * Deterministically mark natural HOPOs on a chart that has none. Returns NEW
 * note objects (every note gets an explicit boolean); input is not mutated.
 */
export function markNaturalHopos(
  notes: readonly ChartNote[],
  bpm?: number,
): ChartNote[] {
  const sorted = sortNotes(notes);
  const gap = hopoGapMs(bpm);
  const groups = timeGroups(sorted);
  const hopoIds = new Set<string>();

  for (let g = 1; g < groups.length; g += 1) {
    const [start, end] = groups[g] as [number, number];
    if (end - start > 1) continue; // chords are never HOPOs
    const note = sorted[start] as ChartNote;
    const [prevStart, prevEnd] = groups[g - 1] as [number, number];
    const prevTime = (sorted[prevStart] as ChartNote).timeMs;
    if (note.timeMs - prevTime > gap) continue;
    // Different-lane rule: a repeated lane must be re-tapped.
    let sameLane = false;
    for (let k = prevStart; k < prevEnd; k += 1) {
      if ((sorted[k] as ChartNote).lane === note.lane) {
        sameLane = true;
        break;
      }
    }
    if (!sameLane) hopoIds.add(note.id);
  }

  return notes.map((n) => ({ ...n, hopo: hopoIds.has(n.id) }));
}

/**
 * Guarantee a chart has HOPO flags: charts that carry authored flags
 * (Clone Hero `.chart` imports) pass through untouched, everything else gets
 * naturals auto-marked. Returns the same chart object when nothing changes.
 */
export function ensureHopos(chart: RhythmChart): RhythmChart {
  if (chart.notes.some((n) => n.hopo !== undefined)) return chart;
  const marked = markNaturalHopos(chart.notes, chart.bpm);
  if (!marked.some((n) => n.hopo)) return chart;
  return { ...chart, notes: marked };
}

/**
 * The per-frame auto-hit scan: unjudged HOPO notes inside [searchLo, searchHi)
 * whose lane is currently held, whose timing error is within the perfect
 * window, and whose previous note (whole chord, walked back through `sorted`)
 * was hit. Pure — the caller applies the hits.
 *
 * REQUIRES `sorted` ascending by timeMs (chords contiguous).
 */
export function findHopoAutoHits(
  sorted: readonly ChartNote[],
  runtime: ReadonlyMap<string, NoteRuntimeState>,
  heldLanes: ReadonlySet<Lane>,
  songTimeMs: number,
  chartOffsetMs: number,
  calibrationOffsetMs: number,
  searchLo = 0,
  searchHi = sorted.length,
): Array<{ note: ChartNote; errorMs: number }> {
  if (heldLanes.size === 0) return [];
  const hits: Array<{ note: ChartNote; errorMs: number }> = [];

  for (let i = searchLo; i < searchHi; i += 1) {
    const note = sorted[i] as ChartNote;
    if (!note.hopo) continue;
    if (!heldLanes.has(note.lane)) continue;
    if (runtime.get(note.id)?.judged) continue;

    const errorMs = timingErrorMs(note, songTimeMs, chartOffsetMs, calibrationOffsetMs);
    if (Math.abs(errorMs) > HIT_WINDOWS.perfect) continue;

    // The previous note (its whole chord) must have been HIT — a missed note
    // breaks the chain and the HOPO must be tapped like a normal note.
    let prevEnd = i;
    while (prevEnd > 0 && (sorted[prevEnd - 1] as ChartNote).timeMs === note.timeMs) {
      prevEnd -= 1; // skip chord partners at the same time
    }
    if (prevEnd === 0) continue; // nothing before it — must be tapped
    const prevTime = (sorted[prevEnd - 1] as ChartNote).timeMs;
    let chainAlive = true;
    for (let k = prevEnd - 1; k >= 0 && (sorted[k] as ChartNote).timeMs === prevTime; k -= 1) {
      const state = runtime.get((sorted[k] as ChartNote).id);
      if (!state?.judged || state.rating === "miss") {
        chainAlive = false;
        break;
      }
    }
    if (chainAlive) hits.push({ note, errorMs });
  }

  return hits;
}
