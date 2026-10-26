/**
 * Adaptive canvas resolution.
 *
 * The highway canvas used to cap its backing store at 2× device pixels. 3×
 * screens (every recent iPhone, the iPhone Duo) render visibly crisper gems at
 * their native density, and an A-series chip can usually afford it at 120 Hz —
 * but not every device can. So start at the native density (capped at 3×),
 * watch real frame times, and step the resolution down a notch whenever the
 * median frame is slower than 50 fps. Only ever down, never back up, so the
 * scale can't oscillate mid-song.
 */

import { median } from "@/game/calibration";

export const RENDER_SCALE = {
  max: 3,
  /** Frames per measurement window. */
  sampleFrames: 90,
  /** Median frame time above this (ms) means "too slow" (< 50 fps). */
  slowFrameMs: 20,
  /** Frame gaps longer than this are hiccups (tab hidden, GC), not load. */
  ignoreFrameMs: 100,
} as const;

const STEPS = [3, 2, 1.5, 1] as const;

export function initialRenderScale(deviceDpr: number): number {
  const dpr = Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
  return Math.min(RENDER_SCALE.max, Math.max(1, dpr));
}

/** The scale after a measurement window of frame times (ms). */
export function nextRenderScale(current: number, frameTimesMs: readonly number[]): number {
  if (median(frameTimesMs) <= RENDER_SCALE.slowFrameMs) return current;
  return STEPS.find((s) => s < current) ?? current;
}
