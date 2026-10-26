import { describe, expect, it } from "vitest";

import {
  CALIBRATION_RANGE_MS,
  TAP_TEST,
  calibrationFromTapErrors,
  latencySeedMs,
  median,
  tapErrorsMs,
} from "./calibration";
import { timingErrorMs } from "./timing";

const BEAT = 60000 / TAP_TEST.bpm;
const CLICKS = Array.from(
  { length: TAP_TEST.leadInClicks + TAP_TEST.measuredClicks },
  (_, i) => 1000 + i * BEAT,
);

describe("median", () => {
  it("handles odd, even, and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("tapErrorsMs", () => {
  it("measures each tap against its nearest scored click", () => {
    const taps = CLICKS.slice(TAP_TEST.leadInClicks).map((c) => c + 180);
    const errors = tapErrorsMs(taps, CLICKS);
    expect(errors).toHaveLength(TAP_TEST.measuredClicks);
    for (const e of errors) expect(e).toBeCloseTo(180);
  });

  it("ignores count-in taps, double taps, and taps past the end", () => {
    const lead = CLICKS[0] as number;
    const scored = CLICKS[TAP_TEST.leadInClicks] as number;
    const last = CLICKS[CLICKS.length - 1] as number;
    const errors = tapErrorsMs([lead + 10, scored + 20, scored + 40, last + BEAT * 2], CLICKS);
    expect(errors).toEqual([20]);
  });
});

describe("calibrationFromTapErrors", () => {
  it("cancels Bluetooth-style late taps with a negative calibration", () => {
    const errors = [190, 200, 210, 205, 195, 200, 198];
    expect(calibrationFromTapErrors(errors)).toBe(-200);
  });

  it("zeroes the in-game timing error once applied", () => {
    const errors = [-30, -25, -35, -28, -32, -30];
    const cal = calibrationFromTapErrors(errors) as number;
    // A note at 2000ms, tapped 30ms early on the audio clock:
    expect(timingErrorMs({ timeMs: 2000 }, 1970, 0, cal)).toBe(0);
  });

  it("drops stumbles instead of letting them drag the result", () => {
    const errors = [100, 102, 98, 101, 99, 100, 450, -300];
    expect(calibrationFromTapErrors(errors)).toBe(-100);
  });

  it("refuses too few steady taps", () => {
    expect(calibrationFromTapErrors([100, 110, 90])).toBeNull();
  });

  it("clamps to the supported range", () => {
    expect(calibrationFromTapErrors([900, 900, 900, 900, 900, 900])).toBe(
      CALIBRATION_RANGE_MS.min,
    );
  });
});

describe("latencySeedMs", () => {
  it("leaves ordinary speakers alone", () => {
    expect(latencySeedMs(0.02, 10)).toBeNull();
    expect(latencySeedMs(null, 10)).toBeNull();
    expect(latencySeedMs(Number.NaN, 10)).toBeNull();
  });

  it("subtracts Bluetooth latency beyond typical speakers from the default", () => {
    // 205ms reported, 25ms typical already in the default → shift by −180.
    expect(latencySeedMs(0.205, 10)).toBe(-170);
  });
});
