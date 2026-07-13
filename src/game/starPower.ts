/**
 * Star power — Guitar Hero's signature risk/reward mechanic, pure logic only.
 *
 * The loop: charts contain STAR PHRASES (short runs of notes). Hitting every
 * note of a phrase banks a quarter of the star-power meter. Once at least half
 * a bar is stored the player may ACTIVATE: the meter drains over time and every
 * point scored is doubled (stacking with the combo multiplier, up to 8×).
 *
 * Imported Clone Hero charts keep their authored `S 2` phrases; every other
 * chart source gets phrases auto-marked here with a deterministic walk.
 *
 * The meter is never mutated per frame. While active it drains linearly from
 * `state.meter` starting at `state.activatedAtMs`, so the current level is a
 * pure function of song time — the renderer derives it each frame from a
 * snapshot and the game hook only writes state on discrete events.
 */

import { STAR_POWER } from "./constants";
import { sortNotes } from "./chartUtils";
import { clamp } from "./timing";
import type {
  ChartNote,
  RhythmChart,
  StarPhraseProgress,
  StarPowerState,
} from "./types";

/* ------------------------------ meter machine ----------------------------- */

export function createStarPower(): StarPowerState {
  return { meter: 0, active: false, activatedAtMs: 0, phrasesCompleted: 0 };
}

/**
 * Current meter level (0..1) at `songTimeMs`, accounting for the linear drain
 * while active. This is the single source of truth for "how much is left".
 */
export function starPowerMeterAt(
  state: StarPowerState,
  songTimeMs: number,
): number {
  if (!state.active) return clamp(state.meter, 0, 1);
  const drained = (songTimeMs - state.activatedAtMs) / STAR_POWER.fullBarDrainMs;
  return clamp(state.meter - drained, 0, 1);
}

/**
 * Bank a completed star phrase. While active this also EXTENDS the run
 * (GH-style): the drain restarts from the topped-up level.
 */
export function awardStarPhrase(
  state: StarPowerState,
  songTimeMs: number,
): StarPowerState {
  const level = starPowerMeterAt(state, songTimeMs);
  return {
    ...state,
    meter: clamp(level + STAR_POWER.phraseGain, 0, 1),
    activatedAtMs: state.active ? songTimeMs : state.activatedAtMs,
    phrasesCompleted: state.phrasesCompleted + 1,
  };
}

/** Whether the player is allowed to unleash star power right now. */
export function canActivateStarPower(
  state: StarPowerState,
  songTimeMs: number,
): boolean {
  return !state.active && starPowerMeterAt(state, songTimeMs) >= STAR_POWER.activationMin;
}

/** Unleash it. No-op (same state) if activation is not allowed. */
export function activateStarPower(
  state: StarPowerState,
  songTimeMs: number,
): StarPowerState {
  if (!canActivateStarPower(state, songTimeMs)) return state;
  return { ...state, active: true, activatedAtMs: songTimeMs };
}

/**
 * Per-frame settle: once an active run has fully drained, deactivate and pin
 * the stored meter at 0. Returns the same object when nothing changed so the
 * caller can cheaply skip a state write.
 */
export function tickStarPower(
  state: StarPowerState,
  songTimeMs: number,
): StarPowerState {
  if (!state.active) return state;
  if (starPowerMeterAt(state, songTimeMs) > 0) return state;
  return { ...state, active: false, meter: 0 };
}

/** Score multiplier contributed by star power (2 while active, else 1). */
export function starPowerScoreMultiplier(state: StarPowerState): number {
  return state.active ? STAR_POWER.scoreMultiplier : 1;
}

/**
 * Add raw meter (whammy trickle from a wiggled star sustain). Like a phrase
 * award it tops up an active run in place (drain restarts from the new
 * level), but it does not count as a completed phrase. Returns the same
 * object for a no-op gain so callers can skip the write.
 */
export function addStarPowerMeter(
  state: StarPowerState,
  amount: number,
  songTimeMs: number,
): StarPowerState {
  if (amount <= 0) return state;
  const level = starPowerMeterAt(state, songTimeMs);
  const next = clamp(level + amount, 0, 1);
  if (!state.active && next === state.meter) return state;
  return {
    ...state,
    meter: next,
    activatedAtMs: state.active ? songTimeMs : state.activatedAtMs,
  };
}

/* ----------------------------- phrase tracking ---------------------------- */

/**
 * Build the per-phrase progress index for a chart: phrase id → how many notes
 * it contains. The game hook advances `hit`/`broken` as notes resolve.
 */
export function buildPhraseIndex(
  notes: readonly ChartNote[],
): Map<number, StarPhraseProgress> {
  const index = new Map<number, StarPhraseProgress>();
  for (const note of notes) {
    if (note.starPhrase === undefined) continue;
    const entry = index.get(note.starPhrase);
    if (entry) entry.total += 1;
    else index.set(note.starPhrase, { total: 1, hit: 0, broken: false });
  }
  return index;
}

/**
 * Record a hit on a star note. Returns true exactly once per phrase: when this
 * hit completed it (every note hit, none missed) — the moment meter is awarded.
 */
export function registerStarNoteHit(
  index: Map<number, StarPhraseProgress>,
  phraseId: number,
): boolean {
  const entry = index.get(phraseId);
  if (!entry) return false;
  entry.hit += 1;
  return !entry.broken && entry.hit === entry.total;
}

/** Record a missed star note: the phrase can no longer award meter. */
export function registerStarNoteMiss(
  index: Map<number, StarPhraseProgress>,
  phraseId: number,
): void {
  const entry = index.get(phraseId);
  if (entry) entry.broken = true;
}

/* --------------------------- phrase auto-marking -------------------------- */

/** Skip the first few notes so star phrases never land on the song's pickup. */
const INTRO_SKIP_NOTES = 8;
/** A phrase spans at most this many notes... */
const PHRASE_MAX_NOTES = 6;
/** ...and at most this much time, so sparse charts get short phrases. */
const PHRASE_MAX_SPAN_MS = 4_000;
/** A phrase needs at least this many notes to be worth starring. */
const PHRASE_MIN_NOTES = 2;
/** Quiet time between the end of one phrase and the start of the next. */
const PHRASE_GAP_MS = 10_000;

/**
 * Deterministically mark star phrases on a chart that has none. Walks the
 * time-sorted notes: after a short intro, groups a handful of consecutive
 * notes into a phrase, then leaves a long gap before the next one — roughly
 * matching how often GH charters place phrases. Chords are never split across
 * a phrase boundary. Returns NEW note objects; input is not mutated.
 */
export function markStarPhrases(notes: readonly ChartNote[]): ChartNote[] {
  const sorted = sortNotes(notes);
  const starIds = new Map<string, number>();

  let phraseId = 0;
  let i = INTRO_SKIP_NOTES;
  while (i < sorted.length) {
    const start = sorted[i] as ChartNote;
    // Collect the phrase: bounded by note count and by wall-clock span.
    let end = i;
    while (
      end + 1 < sorted.length &&
      end + 1 - i < PHRASE_MAX_NOTES &&
      (sorted[end + 1] as ChartNote).timeMs - start.timeMs <= PHRASE_MAX_SPAN_MS
    ) {
      end += 1;
    }
    // Never split a chord: pull in any partner sharing the last note's time.
    while (
      end + 1 < sorted.length &&
      (sorted[end + 1] as ChartNote).timeMs === (sorted[end] as ChartNote).timeMs
    ) {
      end += 1;
    }

    if (end - i + 1 >= PHRASE_MIN_NOTES) {
      for (let k = i; k <= end; k += 1) {
        starIds.set((sorted[k] as ChartNote).id, phraseId);
      }
      phraseId += 1;
      // Cool down: resume after the gap, measured from the phrase's last note.
      const resumeAfter = (sorted[end] as ChartNote).timeMs + PHRASE_GAP_MS;
      i = end + 1;
      while (i < sorted.length && (sorted[i] as ChartNote).timeMs < resumeAfter) {
        i += 1;
      }
    } else {
      // Too sparse to phrase here (e.g. a lone outro note); try further along.
      i = end + 1;
    }
  }

  if (starIds.size === 0) return [...notes];
  return notes.map((note) => {
    const id = starIds.get(note.id);
    return id === undefined ? note : { ...note, starPhrase: id };
  });
}

/**
 * Guarantee a chart has star phrases: charts that carry authored phrases
 * (Clone Hero `S 2` imports, editor charts) pass through untouched, everything
 * else gets the deterministic auto-marking. Returns the same chart object when
 * unchanged.
 */
export function ensureStarPhrases(chart: RhythmChart): RhythmChart {
  if (chart.notes.some((n) => n.starPhrase !== undefined)) return chart;
  const marked = markStarPhrases(chart.notes);
  if (!marked.some((n) => n.starPhrase !== undefined)) return chart;
  return { ...chart, notes: marked };
}

/**
 * Renumber star markings into contiguous phrases — the editor's brush model.
 * Any starred note (starPhrase defined, value irrelevant) chains into the
 * same phrase as starred notes in the previous time step; a time step with no
 * starred note splits phrases. Judged per time GROUP so a mixed chord (one
 * starred, one normal lane) never splits a run. Returns NEW note objects with
 * phrases renumbered 0..n in time order; unstarred notes pass through.
 */
export function groupStarPhrases(notes: readonly ChartNote[]): ChartNote[] {
  const sorted = sortNotes(notes);
  const phraseById = new Map<string, number>();
  let phraseId = -1;
  let previousGroupStarred = false;
  let i = 0;
  while (i < sorted.length) {
    // One time group = all notes sharing this timeMs.
    let j = i;
    let groupStarred = false;
    while (j < sorted.length && (sorted[j] as ChartNote).timeMs === (sorted[i] as ChartNote).timeMs) {
      if ((sorted[j] as ChartNote).starPhrase !== undefined) groupStarred = true;
      j += 1;
    }
    if (groupStarred) {
      if (!previousGroupStarred) phraseId += 1;
      for (let k = i; k < j; k += 1) {
        const note = sorted[k] as ChartNote;
        if (note.starPhrase !== undefined) phraseById.set(note.id, phraseId);
      }
    }
    previousGroupStarred = groupStarred;
    i = j;
  }
  return notes.map((note) => {
    const id = phraseById.get(note.id);
    if (id === undefined) return note;
    return { ...note, starPhrase: id };
  });
}
