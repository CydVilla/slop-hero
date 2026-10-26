/**
 * Calibration math: turning measurements into a calibration offset.
 *
 * Sign convention (see timing.ts): a note is judged at
 * `note.timeMs + chart.offsetMs − calibrationOffsetMs` on the audio clock, so a
 * tap that lands `e` ms after a note's clock time scores an error of
 * `e + calibration`. Zeroing that error means `calibration = −e`:
 *
 *  - Audio that reaches the ear late (Bluetooth headphones add 150–250 ms)
 *    makes players tap late → a NEGATIVE calibration.
 *  - Players who habitually tap ahead of the beat → a POSITIVE calibration.
 *
 * Both measurements here — tap-along errors and the browser's reported output
 * latency — are on the same AudioContext clock the game judges with.
 */

/** Hard limits for any calibration we compute (wide enough for Bluetooth). */
export const CALIBRATION_RANGE_MS = { min: -350, max: 350 } as const;

/** Tap-along test shape: a metronome count-in, then clicks the player taps. */
export const TAP_TEST = {
  bpm: 100,
  /** Clicks played before measuring starts (find the groove, not scored). */
  leadInClicks: 4,
  /** Clicks the player taps along to. */
  measuredClicks: 12,
  /** Fewest usable taps for a trustworthy result. */
  minTaps: 6,
  /** Taps further than this from the median are stumbles, not latency. */
  outlierMs: 120,
} as const;

/**
 * Output latency at or below this is ordinary speakers/wired audio — already
 * covered by the auto-tuned default calibration, so nothing to seed.
 */
const SEED_MIN_LATENCY_MS = 60;
/** Typical speaker latency the default calibration already absorbs. */
const TYPICAL_LATENCY_MS = 25;

export function clampCalibration(ms: number): number {
  return Math.round(
    Math.min(CALIBRATION_RANGE_MS.max, Math.max(CALIBRATION_RANGE_MS.min, ms)),
  );
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Signed error (ms, positive = late) of each tap against its nearest measured
 * click. Taps nearest a count-in click or outside the run are ignored, and only
 * the first tap per click counts (a double-tap isn't two measurements).
 * `clickTimesMs` must be evenly spaced and ascending.
 */
export function tapErrorsMs(
  tapTimesMs: readonly number[],
  clickTimesMs: readonly number[],
  leadInClicks: number = TAP_TEST.leadInClicks,
): number[] {
  const first = clickTimesMs[0];
  const second = clickTimesMs[1];
  if (first === undefined || second === undefined) return [];
  const beatMs = second - first;
  const seen = new Set<number>();
  const errors: number[] = [];
  for (const tap of tapTimesMs) {
    const index = Math.round((tap - first) / beatMs);
    const click = clickTimesMs[index];
    if (index < leadInClicks || click === undefined || seen.has(index)) continue;
    seen.add(index);
    errors.push(tap - click);
  }
  return errors;
}

/**
 * The calibration that zeroes the player's typical tap error, or null when the
 * taps are too few or too scattered to trust.
 */
export function calibrationFromTapErrors(errorsMs: readonly number[]): number | null {
  const center = median(errorsMs);
  const steady = errorsMs.filter((e) => Math.abs(e - center) <= TAP_TEST.outlierMs);
  if (steady.length < TAP_TEST.minTaps) return null;
  return clampCalibration(-median(steady));
}

/**
 * A starting calibration from the browser's reported output latency
 * (`AudioContext.outputLatency + baseLatency`, in seconds), or null when the
 * latency is unknown or ordinary. Only the latency beyond typical speakers is
 * applied on top of the default, which already reflects what players dial in.
 */
export function latencySeedMs(
  outputLatencySec: number | null | undefined,
  defaultCalibrationMs: number,
): number | null {
  if (typeof outputLatencySec !== "number" || !Number.isFinite(outputLatencySec)) return null;
  const latencyMs = outputLatencySec * 1000;
  if (latencyMs < SEED_MIN_LATENCY_MS) return null;
  return clampCalibration(defaultCalibrationMs - (latencyMs - TYPICAL_LATENCY_MS));
}
