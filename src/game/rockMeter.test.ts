/**
 * Tests for the rock meter (crowd gauge): gains, losses, the star-power
 * mercy rule, fail detection, and gauge zones.
 */

import { describe, expect, it } from "vitest";

import { ROCK_METER } from "./constants";
import {
  createRockMeter,
  isRockMeterFailed,
  rockMeterOnDrop,
  rockMeterOnHit,
  rockMeterOnMiss,
  rockMeterZone,
} from "./rockMeter";

describe("rock meter", () => {
  it("starts at the neutral middle and is not failed", () => {
    const meter = createRockMeter();
    expect(meter).toBe(ROCK_METER.start);
    expect(isRockMeterFailed(meter)).toBe(false);
  });

  it("hits push it up by judgement quality, clamped at full", () => {
    const meter = createRockMeter();
    expect(rockMeterOnHit(meter, "perfect")).toBeCloseTo(
      ROCK_METER.start + ROCK_METER.gain.perfect,
    );
    expect(rockMeterOnHit(meter, "good")).toBeLessThan(
      rockMeterOnHit(meter, "perfect"),
    );
    expect(rockMeterOnHit(0.999, "perfect")).toBe(1);
  });

  it("a miss costs about twice what a perfect earns", () => {
    expect(ROCK_METER.missLoss).toBeGreaterThanOrEqual(2 * ROCK_METER.gain.perfect);
    expect(rockMeterOnMiss(createRockMeter())).toBeCloseTo(
      ROCK_METER.start - ROCK_METER.missLoss,
    );
  });

  it("star power halves the sting of misses and drops", () => {
    const meter = createRockMeter();
    expect(rockMeterOnMiss(meter, true)).toBeCloseTo(
      ROCK_METER.start - ROCK_METER.missLoss / 2,
    );
    expect(rockMeterOnDrop(meter, true)).toBeCloseTo(
      ROCK_METER.start - ROCK_METER.dropLoss / 2,
    );
  });

  it("dropping a sustain stings less than a full miss", () => {
    expect(ROCK_METER.dropLoss).toBeLessThan(ROCK_METER.missLoss);
  });

  it("fails exactly when the gauge empties (and never goes negative)", () => {
    let meter = ROCK_METER.missLoss * 1.5; // survives one miss, not two
    meter = rockMeterOnMiss(meter);
    expect(isRockMeterFailed(meter)).toBe(false);
    meter = rockMeterOnMiss(meter);
    expect(meter).toBe(0);
    expect(isRockMeterFailed(meter)).toBe(true);
  });

  it("zones colour the gauge red / yellow / green", () => {
    expect(rockMeterZone(0.1)).toBe("red");
    expect(rockMeterZone(ROCK_METER.redBelow)).toBe("yellow");
    expect(rockMeterZone(0.5)).toBe("yellow");
    expect(rockMeterZone(ROCK_METER.greenAbove)).toBe("green");
    expect(rockMeterZone(1)).toBe("green");
  });
});
