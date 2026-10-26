"use client";

/**
 * useFoldLayout
 *
 * Feeds live browser values into the pure foldable rules (`@/lib/foldable`):
 * viewport segments, device posture, the viewport size, and the stage's rect.
 * Returns how the play stage should be split, plus the coarse screen form so
 * the game can pause when the player folds, unfolds, or rotates mid-song.
 *
 * Every API here is feature-detected — on browsers without them (most of them,
 * today) this reports a single flat surface and the game looks exactly as it
 * did before.
 */

import { useEffect, useState } from "react";

import {
  SINGLE,
  splitForSegments,
  synthesizeSegments,
  type FoldSplit,
  type Posture,
  type Rect,
  type ScreenForm,
} from "@/lib/foldable";

interface DevicePostureLike extends EventTarget {
  type?: string;
}

interface FoldWindow {
  viewport?: { segments?: readonly DOMRectReadOnly[] | null };
}

const POSTURE_QUERY = "(device-posture: folded)";

export interface FoldLayout {
  split: FoldSplit;
  form: ScreenForm;
  /** The play stage's own size (CSS px). */
  stage: { width: number; height: number };
}

const INITIAL: FoldLayout = {
  split: SINGLE,
  form: { width: 0, height: 0, segments: 1, posture: "continuous" },
  stage: { width: 0, height: 0 },
};

function readPosture(): Posture {
  const posture = (navigator as Navigator & { devicePosture?: DevicePostureLike }).devicePosture;
  if (posture?.type === "folded") return "folded";
  try {
    if (window.matchMedia(POSTURE_QUERY).matches) return "folded";
  } catch {
    // Unknown media feature — treat as flat.
  }
  return "continuous";
}

function readSegments(viewport: Rect, posture: Posture): Rect[] {
  const raw = (window as Window & FoldWindow).viewport?.segments;
  if (raw && raw.length > 1) {
    return raw.map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }));
  }
  // No segments, or just one while the posture says folded (some browsers
  // ship posture before segments): fall back to the hinge heuristic.
  return synthesizeSegments(viewport, posture);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameLayout(a: FoldLayout, b: FoldLayout): boolean {
  const fa = a.form;
  const fb = b.form;
  if (
    fa.width !== fb.width ||
    fa.height !== fb.height ||
    fa.segments !== fb.segments ||
    fa.posture !== fb.posture ||
    a.stage.width !== b.stage.width ||
    a.stage.height !== b.stage.height
  ) {
    return false;
  }
  if (a.split.kind !== b.split.kind) return false;
  if (a.split.kind === "single" || b.split.kind === "single") return true;
  return sameRect(a.split.highway, b.split.highway) && sameRect(a.split.hud, b.split.hud);
}

export function useFoldLayout(
  stageRef: React.RefObject<HTMLElement | null>,
  /** Book posture: which half gets the highway (see splitForSegments). */
  highwaySide: "start" | "end" = "end",
): FoldLayout {
  const [layout, setLayout] = useState<FoldLayout>(INITIAL);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const measure = () => {
      const viewport: Rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      const posture = readPosture();
      const segments = readSegments(viewport, posture);
      const r = stage.getBoundingClientRect();
      const stageRect = { x: r.left, y: r.top, width: r.width, height: r.height };
      const next: FoldLayout = {
        split: splitForSegments(segments, stageRect, highwaySide),
        form: { width: viewport.width, height: viewport.height, segments: segments.length, posture },
        stage: { width: r.width, height: r.height },
      };
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    };

    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(stage);

    const posture = (navigator as Navigator & { devicePosture?: DevicePostureLike }).devicePosture;
    posture?.addEventListener("change", measure);
    let query: MediaQueryList | null = null;
    try {
      query = window.matchMedia(POSTURE_QUERY);
      query.addEventListener("change", measure);
    } catch {
      query = null;
    }

    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
      posture?.removeEventListener("change", measure);
      query?.removeEventListener("change", measure);
    };
  }, [stageRef, highwaySide]);

  return layout;
}
