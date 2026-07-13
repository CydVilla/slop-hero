/**
 * Practice mode, pure logic only — Rock Band-style sectioned rehearsal.
 *
 * A chart is split into fixed-size sections (8 bars when the tempo is known,
 * ~15s otherwise). The player picks one; the game loops it with a short
 * lead-in, the rock meter can't fail them, and playback can run slow. All the
 * looping/judging state math lives here so it's unit-testable; the hook only
 * wires it to the clock.
 */

import { PRACTICE } from "./constants";
import { beatsToMs, chartDurationMs } from "./chartUtils";
import type { ChartNote, NoteRuntimeState, RhythmChart } from "./types";

export interface PracticeSection {
  index: number;
  /** Section bounds in chart time (ms), end exclusive. */
  startMs: number;
  endMs: number;
  noteCount: number;
  /** Display label: "Bars 1–8" with a tempo, else a time range. */
  label: string;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Split a chart into practice sections. Sections with no notes are dropped
 * (there's nothing to rehearse in them); bounds stay grid-aligned so labels
 * match musical structure.
 */
export function chartSections(chart: RhythmChart): PracticeSection[] {
  const durationMs = chartDurationMs(chart);
  if (durationMs <= 0 || chart.notes.length === 0) return [];

  const hasTempo = Boolean(chart.bpm && chart.bpm > 0);
  const sectionMs = hasTempo
    ? beatsToMs(4 * PRACTICE.barsPerSection, chart.bpm as number)
    : PRACTICE.fallbackSectionMs;
  if (!Number.isFinite(sectionMs) || sectionMs <= 0) return [];

  const sections: PracticeSection[] = [];
  for (let start = 0; start < durationMs; start += sectionMs) {
    const end = start + sectionMs;
    const noteCount = chart.notes.reduce(
      (count, n) => (n.timeMs >= start && n.timeMs < end ? count + 1 : count),
      0,
    );
    if (noteCount === 0) continue;
    // The MUSICAL position, not the list position — bar labels must stay
    // correct even when empty sections between phrases are dropped.
    const ordinal = Math.round(start / sectionMs);
    const label = hasTempo
      ? `Bars ${ordinal * PRACTICE.barsPerSection + 1}–${(ordinal + 1) * PRACTICE.barsPerSection}`
      : `${formatTime(start)}–${formatTime(Math.min(end, durationMs))}`;
    sections.push({ index: ordinal, startMs: start, endMs: end, noteCount, label });
  }
  return sections;
}

/**
 * Runtime map for one practice loop: notes OUTSIDE the section are
 * pre-resolved (judged silently, no rating → no feedback, never missed, not
 * drawn), notes inside start fresh. Also reports how many notes are actually
 * in play, for the loop's score/accuracy denominators.
 */
export function practiceRuntime(
  notes: readonly ChartNote[],
  section: Pick<PracticeSection, "startMs" | "endMs">,
): { runtime: Map<string, NoteRuntimeState>; inSectionCount: number } {
  const runtime = new Map<string, NoteRuntimeState>();
  let inSectionCount = 0;
  for (const note of notes) {
    const inside = note.timeMs >= section.startMs && note.timeMs < section.endMs;
    runtime.set(note.id, { judged: !inside });
    if (inside) inSectionCount += 1;
  }
  return { runtime, inSectionCount };
}

/** Song position (ms) a practice loop starts playback from. */
export function practicePlayFromMs(
  section: Pick<PracticeSection, "startMs">,
): number {
  return Math.max(0, section.startMs - PRACTICE.leadInMs);
}

/** Whether the current loop is over and playback should wrap around. */
export function practiceLoopEnded(
  section: Pick<PracticeSection, "endMs">,
  songTimeMs: number,
): boolean {
  return songTimeMs >= section.endMs + PRACTICE.loopTailMs;
}
