/**
 * Rock meter — the Guitar Hero crowd gauge, pure logic only.
 *
 * The meter is a 0..1 fraction. Successful hits nudge it up, misses drag it
 * down about twice as hard, and dropping a sustain stings a little. If it ever
 * reaches empty the crowd boos the player off stage and the run fails.
 *
 * While star power is active the crowd is forgiving: misses cost half. (This
 * mirrors GH, where popping star power is the classic way to survive a rough
 * section.)
 */

import { ROCK_METER } from "./constants";
import { clamp } from "./timing";
import type { HitJudgement } from "./types";

export type RockZone = "red" | "yellow" | "green";

export function createRockMeter(): number {
  return ROCK_METER.start;
}

/** Apply a successful hit of the given quality. */
export function rockMeterOnHit(meter: number, rating: HitJudgement): number {
  return clamp(meter + ROCK_METER.gain[rating], 0, 1);
}

/** Apply a missed note. Misses cost half while star power is active. */
export function rockMeterOnMiss(meter: number, starPowerActive = false): number {
  const loss = starPowerActive ? ROCK_METER.missLoss / 2 : ROCK_METER.missLoss;
  return clamp(meter - loss, 0, 1);
}

/** Apply an early sustain release (gentler than a full miss). */
export function rockMeterOnDrop(meter: number, starPowerActive = false): number {
  const loss = starPowerActive ? ROCK_METER.dropLoss / 2 : ROCK_METER.dropLoss;
  return clamp(meter - loss, 0, 1);
}

/** Whether the crowd has had enough — the run fails at (or below) empty. */
export function isRockMeterFailed(meter: number): boolean {
  return meter <= ROCK_METER.failAt;
}

/** Gauge zone for colouring: red (danger), yellow, green (comfortable). */
export function rockMeterZone(meter: number): RockZone {
  if (meter < ROCK_METER.redBelow) return "red";
  if (meter < ROCK_METER.greenAbove) return "yellow";
  return "green";
}
