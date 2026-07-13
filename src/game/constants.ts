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
 * Minimum sustain length (ms) for a note to be treated as a hold. Shorter
 * "durations" (e.g. imported dust from a chart) play as plain taps so a stray
 * few-ms sustain never demands an awkward micro-hold on a touchscreen.
 */
export const MIN_HOLD_MS = 160;

/**
 * Sustain bonus rate: extra points earned per second the tail is held, before
 * the combo multiplier. A 1s hold at ×1 is worth 500; the head hit is scored
 * separately with the usual SCORE_VALUES.
 */
export const SUSTAIN_POINTS_PER_MS = 0.5;

/**
 * Release grace for sustains (ms). Lifting the finger within this window of the
 * tail's end still counts as a completed hold — fingers leave a touchscreen a
 * hair early, so a small amount of slack keeps completions from feeling unfair.
 * Symmetric: the tail is also considered "held through" once song time reaches
 * `sustainEnd - grace`, so a held note auto-completes without a late release.
 */
export const HOLD_RELEASE_GRACE_MS = 120;

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
 * Star power (Guitar Hero's signature mechanic, "Overdrive" in Rock Band).
 * Hitting every note of a star phrase banks meter; once at least half a bar is
 * stored the player can unleash it for a temporary score-multiplier boost.
 */
export const STAR_POWER = {
  /** Meter fraction gained for completing one star phrase (GH: a quarter bar). */
  phraseGain: 0.25,
  /** Minimum stored meter required to activate (GH: half a bar). */
  activationMin: 0.5,
  /** How long a completely full bar lasts once activated, in ms. */
  fullBarDrainMs: 12_000,
  /** Extra score multiplier while active — stacks with the combo multiplier. */
  scoreMultiplier: 2,
} as const;

/**
 * Hammer-ons / pull-offs, adapted for touch: a HOPO note auto-hits when it
 * crosses the line while its lane is already held (finger resting or slid
 * there) and the previous note was hit — fast runs play by sliding instead of
 * re-tapping every gem.
 */
export const HOPO = {
  /**
   * Natural-HOPO spacing as a fraction of a beat (Clone Hero's 65/192): a
   * non-chord note this close to the previous note, on a different lane,
   * plays as a HOPO.
   */
  beatFraction: 65 / 192,
  /** Spacing threshold (ms) when a chart doesn't know its BPM. */
  fallbackGapMs: 170,
} as const;

/**
 * Whammy, adapted for touch: wiggling the finger that's holding a star-phrase
 * sustain (or mashing the held lane key via key-repeat on desktop) squeezes
 * extra star-power meter out of the tail, GH style.
 */
export const WHAMMY = {
  /** Meter gained per ms of actively-whammied sustain (a quarter bar per 4s). */
  gainPerMs: 0.25 / 4000,
  /** A wiggle within this window (ms) counts as "still whammying". */
  activityWindowMs: 180,
} as const;

/**
 * Rock meter (the green/yellow/red crowd gauge). Hits nudge it up, misses drag
 * it down harder — let it hit empty and the crowd boos you off stage (song
 * fail). Values are fractions of the full gauge.
 */
export const ROCK_METER = {
  start: 0.5,
  /** Gain per successful hit, by judgement quality. */
  gain: { perfect: 0.02, great: 0.015, good: 0.008 },
  /** Loss per missed note. Misses hurt ~2× more than a perfect helps. */
  missLoss: 0.04,
  /** Loss for dropping a sustain early (gentler than a full miss). */
  dropLoss: 0.02,
  /** Meter level at/below which the run fails. */
  failAt: 0,
  /** Zone boundaries for the gauge colour (red below, green above). */
  redBelow: 0.25,
  greenAbove: 0.6,
} as const;

/**
 * Star-rating thresholds, GH-style: the run's score divided by the chart's
 * base (multiplier-less) score — i.e. the average multiplier sustained across
 * the song. Index i = minimum ratio for (i+1) stars. 5 stars ≈ a near-full
 * combo; the theoretical ceiling with star power is 8×.
 */
export const STAR_RATING_THRESHOLDS = [0.4, 1.0, 1.8, 2.6, 3.4] as const;

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

/** Electric blue used for star notes and the star-power-active highway. */
export const STAR_POWER_COLOR = "#38bdf8";

/** Keyboard bindings for desktop testing (A/S/D/F/G -> lanes 0..4). */
export const KEYBOARD_LANE_MAP: Record<string, Lane> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  g: 4,
};
