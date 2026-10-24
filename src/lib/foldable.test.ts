import { describe, expect, it } from "vitest";

import {
  IPHONE_DUO_VIEWPORT,
  screenFormChanged,
  splitForSegments,
  synthesizeSegments,
  type Rect,
  type ScreenForm,
} from "./foldable";

const HEADER = 56;
const { folded, unfolded } = IPHONE_DUO_VIEWPORT;
const unfoldedViewport: Rect = { x: 0, y: 0, ...unfolded };
const unfoldedStage: Rect = { x: 0, y: HEADER, width: unfolded.width, height: unfolded.height - HEADER };

function form(width: number, height: number, extra: Partial<ScreenForm> = {}): ScreenForm {
  return { width, height, segments: 1, posture: "continuous", ...extra };
}

describe("synthesizeSegments", () => {
  it("keeps a flat screen as one segment", () => {
    expect(synthesizeSegments(unfoldedViewport, "continuous")).toEqual([unfoldedViewport]);
  });

  it("splits the open iPhone Duo down its vertical hinge when folded", () => {
    const segs = synthesizeSegments(unfoldedViewport, "folded");
    expect(segs).toEqual([
      { x: 0, y: 0, width: 445, height: 626 },
      { x: 445, y: 0, width: 445, height: 626 },
    ]);
  });

  it("never guesses a hinge for the outer screen, portrait, or Split View", () => {
    const outer: Rect = { x: 0, y: 0, ...folded };
    const portrait: Rect = { x: 0, y: 0, width: 626, height: 890 };
    const splitView: Rect = { x: 0, y: 0, width: 445, height: 626 };
    for (const r of [outer, portrait, splitView]) {
      expect(synthesizeSegments(r, "folded")).toEqual([r]);
    }
  });
});

describe("splitForSegments", () => {
  it("is single for one segment", () => {
    expect(splitForSegments([unfoldedViewport], unfoldedStage)).toEqual({ kind: "single" });
  });

  it("puts the highway on the trailing half in book posture, clipped below the header", () => {
    const split = splitForSegments(synthesizeSegments(unfoldedViewport, "folded"), unfoldedStage);
    expect(split).toEqual({
      kind: "book",
      highway: { x: 445, y: 0, width: 445, height: 570 },
      hud: { x: 0, y: 0, width: 445, height: 570 },
    });
  });

  it("can put the highway on the leading half instead", () => {
    const split = splitForSegments(
      synthesizeSegments(unfoldedViewport, "folded"),
      unfoldedStage,
      "start",
    );
    expect(split.kind === "book" && split.highway.x).toBe(0);
  });

  it("is order-independent", () => {
    const segs = synthesizeSegments(unfoldedViewport, "folded");
    expect(splitForSegments([...segs].reverse(), unfoldedStage)).toEqual(
      splitForSegments(segs, unfoldedStage),
    );
  });

  it("puts the highway on the bottom half in tabletop posture", () => {
    const top: Rect = { x: 0, y: 0, width: 626, height: 445 };
    const bottom: Rect = { x: 0, y: 445, width: 626, height: 445 };
    const stage: Rect = { x: 0, y: HEADER, width: 626, height: 890 - HEADER };
    expect(splitForSegments([bottom, top], stage)).toEqual({
      kind: "tabletop",
      highway: { x: 0, y: 445 - HEADER, width: 626, height: 445 },
      hud: { x: 0, y: 0, width: 626, height: 445 - HEADER },
    });
  });

  it("falls back to single when the highway half is too small to play", () => {
    const top: Rect = { x: 0, y: 0, width: 300, height: 500 };
    const bottom: Rect = { x: 0, y: 500, width: 300, height: 150 };
    const stage: Rect = { x: 0, y: 0, width: 300, height: 650 };
    expect(splitForSegments([top, bottom], stage).kind).toBe("single");
  });

  it("ignores diagonal / malformed segment pairs", () => {
    const a: Rect = { x: 0, y: 0, width: 400, height: 400 };
    const b: Rect = { x: 400, y: 400, width: 400, height: 400 };
    expect(splitForSegments([a, b], { x: 0, y: 0, width: 800, height: 800 }).kind).toBe(
      "single",
    );
  });
});

describe("screenFormChanged", () => {
  it("ignores the first measurement", () => {
    expect(screenFormChanged(form(0, 0), form(unfolded.width, unfolded.height))).toBe(false);
  });

  it("fires on unfold and fold", () => {
    const outer = form(folded.width, folded.height);
    const inner = form(unfolded.width, unfolded.height);
    expect(screenFormChanged(outer, inner)).toBe(true);
    expect(screenFormChanged(inner, outer)).toBe(true);
  });

  it("fires on rotation", () => {
    expect(screenFormChanged(form(626, 890), form(890, 626))).toBe(true);
  });

  it("fires on posture or segment changes at the same size", () => {
    const flat = form(890, 626);
    expect(screenFormChanged(flat, form(890, 626, { posture: "folded" }))).toBe(true);
    expect(screenFormChanged(flat, form(890, 626, { segments: 2 }))).toBe(true);
  });

  it("fires on entering Split View", () => {
    expect(screenFormChanged(form(890, 626), form(445, 626))).toBe(true);
  });

  it("ignores Safari's toolbar collapsing (height-only change)", () => {
    expect(screenFormChanged(form(466, 600), form(466, 678))).toBe(false);
    expect(screenFormChanged(form(890, 540), form(890, 626))).toBe(false);
  });
});
