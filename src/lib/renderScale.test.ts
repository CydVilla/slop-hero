import { describe, expect, it } from "vitest";

import { initialRenderScale, nextRenderScale } from "./renderScale";

describe("initialRenderScale", () => {
  it("uses native density up to 3×", () => {
    expect(initialRenderScale(3)).toBe(3);
    expect(initialRenderScale(2)).toBe(2);
    expect(initialRenderScale(3.5)).toBe(3);
    expect(initialRenderScale(1.25)).toBe(1.25);
  });

  it("falls back to 1× for nonsense", () => {
    expect(initialRenderScale(0)).toBe(1);
    expect(initialRenderScale(Number.NaN)).toBe(1);
  });
});

const frames = (ms: number) => Array.from({ length: 90 }, (_, i) => ms + (i % 3) - 1);

describe("nextRenderScale", () => {
  it("keeps the scale while frames are fast (60 and 120 Hz)", () => {
    expect(nextRenderScale(3, frames(16.7))).toBe(3);
    expect(nextRenderScale(3, frames(8.3))).toBe(3);
  });

  it("steps down one notch at a time when frames are slow", () => {
    expect(nextRenderScale(3, frames(28))).toBe(2);
    expect(nextRenderScale(2, frames(28))).toBe(1.5);
    expect(nextRenderScale(1.5, frames(28))).toBe(1);
    expect(nextRenderScale(1, frames(28))).toBe(1);
  });

  it("judges the median, so a few hitches don't count", () => {
    const mostlyFast = [...frames(8.3).slice(0, 80), ...Array<number>(10).fill(60)];
    expect(nextRenderScale(3, mostlyFast)).toBe(3);
  });

  it("steps from an in-between native density to the next lower notch", () => {
    expect(nextRenderScale(2.625, frames(30))).toBe(2);
  });
});
