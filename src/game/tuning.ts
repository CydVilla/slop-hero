/**
 * Auto-tunable gameplay parameters.
 *
 * Unlike `constants.ts` (hand-tuned balance that only humans should touch), the
 * values in `tuning.json` are the ones the **autonomous self-improvement loop**
 * is allowed to rewrite based on aggregated, anonymous play metrics:
 *
 *   metrics → aggregate → insights → recommended tuning → PR → CI → merge
 *
 * See `scripts/apply-tuning.mjs` and `docs/metricsAndSelfImprovement.md`. Keeping
 * the machine-writable surface as a tiny, validated JSON file means a bad
 * recommendation can only nudge a handful of bounded numbers — never rewrite
 * game logic.
 */

import type { Difficulty } from "./types";
import tuningData from "./tuning.json";

export interface Tuning {
  /** Bumped every time the self-improvement loop rewrites the file. */
  version: number;
  /** ISO date the tuning was last updated. */
  updatedAt: string;
  /**
   * Calibration offset (ms) the game starts with. The loop nudges this toward
   * the median offset players actually dial in, so the default sync improves
   * over time. Positive = judge notes later.
   */
  defaultCalibrationOffsetMs: number;
  /**
   * Per-difficulty multiplier applied to the auto-mapper's note density. 1 = the
   * hand-authored baseline. The loop lowers it for difficulties players miss too
   * much, and raises it (bounded) where players find charts too easy.
   */
  difficultyDensityScale: Record<Difficulty, number>;
  notes?: string;
}

/** Hard safety rails the self-improvement loop must never exceed. */
export const TUNING_BOUNDS = {
  calibrationMs: { min: -120, max: 120 },
  densityScale: { min: 0.5, max: 1.3 },
} as const;

export const TUNING: Tuning = tuningData as Tuning;

/** Density multiplier for a difficulty, clamped to the safe range. */
export function densityScaleFor(difficulty: Difficulty): number {
  const raw = TUNING.difficultyDensityScale[difficulty] ?? 1;
  return clamp(raw, TUNING_BOUNDS.densityScale.min, TUNING_BOUNDS.densityScale.max);
}

/** The starting calibration offset, clamped to the safe range. */
export function defaultCalibrationOffsetMs(): number {
  return clamp(
    TUNING.defaultCalibrationOffsetMs ?? 0,
    TUNING_BOUNDS.calibrationMs.min,
    TUNING_BOUNDS.calibrationMs.max,
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
