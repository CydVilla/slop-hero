/**
 * Tunable constants for gameplay. Centralised so balancing changes happen in
 * one place and so pure logic modules share the exact same numbers the
 * renderer uses.
 */

import type { HitJudgement, Lane } from "./types";

export const LANE_COUNT = 5 as const;

export const LANES: readonly Lane[] = [0, 1, 2, 3, 4] as const;

/**
 * Hit windows in milliseconds (absolute timing error, +/-).
 *
 * Widened from the original keyboard-tuned values (35/70/110) because the player
 * now taps the falling notes directly on a touchscreen — fingers are less
 * precise and have more input latency than key presses, so the judged band is
 * more forgiving. (A wider window also means a taller, easier-to-hit gem zone.)
 */
export const HIT_WINDOWS = {
  perfect: 50,
  great: 95,
  good: 140,
} as const;

/**
 * A note is considered missed once it has scrolled past the hit line by more
 * than the good window. Kept equal to the good window so judgement and visual
 * pass-through agree.
 */
export const MISS_THRESHOLD_MS = HIT_WINDOWS.good;

/** Points awarded per judgement (before combo multiplier). */
export const SCORE_VALUES: Record<HitJudgement, number> = {
  perfect: 1000,
  great: 700,
  good: 400,
};

/**
 * Combo multiplier tiers. Each entry is [minCombo, multiplier], sorted
 * descending so we can return the first match.
 */
export const COMBO_MULTIPLIERS: ReadonlyArray<readonly [number, number]> = [
  [50, 4],
  [25, 3],
  [10, 2],
  [0, 1],
] as const;

/**
 * How long notes take to travel from spawn (top of highway) to the hit line.
 * Lower = faster scroll = harder to read. This is the single source of truth
 * for converting note time into screen position.
 *
 * Tuned slow for touchscreen play: because the player taps each falling gem
 * directly (the finger has to travel to the gem), a calmer approach speed gives
 * much more time to read the lane and reach it. Density (in the auto-mappers) is
 * the other half of "can a human keep up" and is tuned alongside this.
 */
export const NOTE_TRAVEL_MS = 2300;

/** How long hit/miss feedback stays visible. */
export const FEEDBACK_DURATION_MS = 450;

/** How long a lane pad shows its "pressed" glow after a tap. */
export const LANE_FLASH_MS = 120;

/** Countdown before the song starts, in ms. */
export const COUNTDOWN_MS = 3000;

/** Lane visual colours, indexed by lane. */
export const LANE_COLORS: Record<Lane, string> = {
  0: "#22c55e", // green
  1: "#ef4444", // red
  2: "#eab308", // yellow
  3: "#3b82f6", // blue
  4: "#f97316", // orange
};

/** Brighter variants used for glows / active feedback. */
export const LANE_GLOW_COLORS: Record<Lane, string> = {
  0: "#4ade80",
  1: "#f87171",
  2: "#facc15",
  3: "#60a5fa",
  4: "#fb923c",
};

/** Keyboard bindings for desktop testing (A/S/D/F/G -> lanes 0..4). */
export const KEYBOARD_LANE_MAP: Record<string, Lane> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  g: 4,
};
