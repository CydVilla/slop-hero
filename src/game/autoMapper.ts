/**
 * Placeholder automapper.
 *
 * This is intentionally NOT machine learning. It generates a deterministic,
 * "musical-ish" chart on a fixed BPM grid so the game is playable immediately.
 * The real pipeline (BPM detection, onset analysis, stem separation, etc.) is
 * described in docs/aiChartGenerationPlan.md and will eventually replace this
 * function while keeping the same RhythmChart output shape.
 *
 * Design goals:
 *  - Deterministic for a given (duration, difficulty, bpm) so charts are
 *    reproducible and testable.
 *  - Never spam the same lane repeatedly (unplayable on a touchscreen).
 *  - Density scales with difficulty.
 */

import { LANE_COUNT } from "./constants";
import { beatsToMs, makeNoteId } from "./chartUtils";
import { densityScaleFor } from "./tuning";
import type { ChartNote, Difficulty, Lane, RhythmChart } from "./types";

export interface AutoMapOptions {
  durationSeconds: number;
  difficulty: Difficulty;
  bpm?: number;
  title?: string;
  artist?: string;
  offsetMs?: number;
}

interface DifficultyProfile {
  /** Step between grid slots, in beats. Smaller = denser. */
  stepBeats: number;
  /** Probability [0..1] that a given grid slot actually gets a note. */
  fillChance: number;
  /** Probability that a populated slot becomes a two-note chord. */
  chordChance: number;
  /**
   * Absolute floor between consecutive notes, in ms. This caps throughput
   * independent of BPM so a fast song can't produce an unplayable wall of taps
   * on a touchscreen (where the finger must travel to each gem). Notes that
   * would land sooner than this after the previous one are dropped; chord
   * partners share a timestamp and are exempt.
   */
  minGapMs: number;
}

// Densities are deliberately conservative for tap-the-note touchscreen play.
// Rough sustained ceilings (from minGapMs): easy ~2/s, medium ~3/s, hard ~4/s,
// expert ~5.5/s — and fillChance keeps the average well below those peaks.
const PROFILES: Record<Difficulty, DifficultyProfile> = {
  // ~one note every 2 beats
  easy: { stepBeats: 2, fillChance: 0.8, chordChance: 0, minGapMs: 500 },
  // ~one note every beat
  medium: { stepBeats: 1, fillChance: 0.85, chordChance: 0, minGapMs: 320 },
  // quarter grid + occasional eighths/chords
  hard: { stepBeats: 0.5, fillChance: 0.7, chordChance: 0.05, minGapMs: 240 },
  // eighth grid + chords. On a touchscreen "expert" means denser + more chords,
  // not literally faster than fingers can travel, so the gap floor still applies.
  expert: { stepBeats: 0.5, fillChance: 0.95, chordChance: 0.18, minGapMs: 200 },
};

/**
 * Tiny deterministic PRNG (mulberry32). We seed it from the inputs so the same
 * song+difficulty always yields the same chart, which keeps the experience and
 * any tests stable.
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(opts: AutoMapOptions, bpm: number): number {
  const diffSeed = opts.difficulty.length * 131;
  return Math.floor(opts.durationSeconds * 1000) ^ (bpm * 2654435761) ^ diffSeed;
}

/**
 * Pick a lane that avoids immediate repetition and avoids huge jumps, which
 * reads as a more natural melodic line than pure random.
 */
function nextLane(rng: () => number, previous: Lane | null): Lane {
  if (previous === null) {
    return Math.floor(rng() * LANE_COUNT) as Lane;
  }
  // Prefer stepping +-1 or +-2 lanes, wrapping, never staying put.
  const offsets = [-2, -1, 1, 2];
  const pick = offsets[Math.floor(rng() * offsets.length)] ?? 1;
  const lane = (((previous + pick) % LANE_COUNT) + LANE_COUNT) % LANE_COUNT;
  return lane as Lane;
}

/** A second lane for a chord that is not adjacent to `lane` (more comfortable). */
function chordPartnerLane(rng: () => number, lane: Lane): Lane {
  const candidates: Lane[] = ([0, 1, 2, 3, 4] as Lane[]).filter(
    (l) => Math.abs(l - lane) >= 2,
  );
  const idx = Math.floor(rng() * candidates.length);
  return candidates[idx] ?? ((lane + 2) % LANE_COUNT as Lane);
}

export function generateAutoChart(opts: AutoMapOptions): RhythmChart {
  const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : 120;
  const offsetMs = opts.offsetMs ?? 0;
  const profile = PROFILES[opts.difficulty];
  // The self-improvement loop nudges density per difficulty based on real miss
  // rates; apply it here (clamped to a safe range in tuning.ts). 1 = baseline.
  const fillChance = Math.min(1, Math.max(0, profile.fillChance * densityScaleFor(opts.difficulty)));
  const rng = makeRng(seedFrom(opts, bpm));

  const totalBeats = (opts.durationSeconds / 60) * bpm;
  const notes: ChartNote[] = [];

  let previousLane: Lane | null = null;
  let lastNoteMs = -Infinity;

  // Leave a short lead-in so the first note is readable.
  const leadInBeats = 4;

  for (let beat = leadInBeats; beat < totalBeats; beat += profile.stepBeats) {
    if (rng() > fillChance) continue;

    const timeMs = beatsToMs(beat, bpm);
    // Enforce the per-difficulty throughput floor so high-BPM songs stay
    // playable on a touchscreen regardless of the beat grid.
    if (timeMs - lastNoteMs < profile.minGapMs) continue;

    const lane = nextLane(rng, previousLane);
    previousLane = lane;
    lastNoteMs = timeMs;

    notes.push({ id: makeNoteId("auto"), timeMs, lane, type: "tap" });

    if (profile.chordChance > 0 && rng() < profile.chordChance) {
      const partner = chordPartnerLane(rng, lane);
      notes.push({ id: makeNoteId("auto"), timeMs, lane: partner, type: "tap" });
    }
  }

  return {
    id: `auto_${Math.floor(opts.durationSeconds)}_${opts.difficulty}_${bpm}`,
    title: opts.title ?? "Uploaded Song",
    artist: opts.artist,
    bpm,
    offsetMs,
    difficulty: opts.difficulty,
    notes,
  };
}
