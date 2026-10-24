/**
 * Foldable-screen layout rules (tuned for the iPhone Duo, generic for any
 * foldable that reports viewport segments).
 *
 * The iPhone Duo has two displays: a 5.4" outer screen (~466×678 CSS px,
 * portrait) and a 7.6" inner screen (~890×626 CSS px when open, wider than tall)
 * whose hinge runs vertically down the middle. Safari reports it as a plain
 * iPhone, so we never branch on the device — only on what the browser tells us
 * about the viewport:
 *
 *  - Viewport Segments API (`window.viewport.segments`, Chrome 138+; flagged in
 *    Safari 27.1) — when the screen is half-folded it reports one rect per side
 *    of the hinge, so the highway can live entirely on one side instead of
 *    bending across the fold.
 *  - Device Posture API (`(device-posture: folded)`) — tells us the screen is
 *    bent even when segments aren't exposed. On a wide, full-screen viewport we
 *    then assume a centered vertical hinge (the Duo's book posture).
 *
 * Everything here is pure (no DOM) so the rules are unit-testable;
 * `useFoldLayout` feeds it live browser values.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Posture = "continuous" | "folded";

/** The coarse shape of the screen, used to notice folds/unfolds/rotations. */
export interface ScreenForm {
  width: number;
  height: number;
  /** Number of viewport segments (1 = one flat surface). */
  segments: number;
  posture: Posture;
}

/** Approximate iPhone Duo Safari viewports (3× DPR), for docs and tests. */
export const IPHONE_DUO_VIEWPORT = {
  folded: { width: 466, height: 678 },
  unfolded: { width: 890, height: 626 },
} as const;

/**
 * How the play stage is divided:
 *  - `single`   — one flat surface; the highway fills the stage.
 *  - `book`     — vertical hinge (segments side by side): highway on one half,
 *                 score/calibration HUD on the other.
 *  - `tabletop` — horizontal hinge (segments stacked): highway on the bottom
 *                 half (resting flat, easiest to tap), HUD on the top half.
 * Pane rects are relative to the stage's top-left corner.
 */
export type FoldSplit =
  | { kind: "single" }
  | { kind: "book" | "tabletop"; highway: Rect; hud: Rect };

export const SINGLE: FoldSplit = { kind: "single" };

/** A pane narrower/shorter than this can't hold a playable 5-lane highway. */
const MIN_HIGHWAY_WIDTH = 240;
const MIN_HIGHWAY_HEIGHT = 240;

/**
 * Only guess a hinge from posture alone on a viewport this big and this wide —
 * i.e. the whole inner display, not Split View or the outer screen.
 */
const SYNTH_MIN_WIDTH = 760;
const SYNTH_MIN_ASPECT = 1.2;

/** Width change (fraction) that counts as a new screen, not toolbar jitter. */
const FORM_WIDTH_CHANGE = 0.15;

/**
 * Best-effort segments when the browser reports a folded posture but no
 * segment rects: a landscape, full-inner-display viewport is split down the
 * middle (the iPhone Duo's vertical hinge). Anything else stays one segment —
 * a wrong guess would put the fold through the highway, which is worse than
 * not splitting at all.
 */
export function synthesizeSegments(viewport: Rect, posture: Posture): Rect[] {
  const { x, y, width, height } = viewport;
  const wideEnough = width >= SYNTH_MIN_WIDTH && width / Math.max(height, 1) >= SYNTH_MIN_ASPECT;
  if (posture !== "folded" || !wideEnough) return [viewport];
  const half = width / 2;
  return [
    { x, y, width: half, height },
    { x: x + half, y, width: half, height },
  ];
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function toLocal(r: Rect, origin: Rect): Rect {
  return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height };
}

/**
 * Decide the stage layout from viewport segments (viewport coordinates) and the
 * stage's own rect (also viewport coordinates — it sits below the header).
 *
 * `highwaySide` picks which half of a book-posture split gets the highway:
 * `end` (right, the default — the trailing side, where iOS puts alerts in book
 * posture) or `start` (left).
 */
export function splitForSegments(
  segments: readonly Rect[],
  stage: Rect,
  highwaySide: "start" | "end" = "end",
): FoldSplit {
  const [a, b] = segments;
  if (segments.length !== 2 || !a || !b) return SINGLE;
  const sideBySide = Math.abs(a.y - b.y) < 1 && Math.abs(a.x - b.x) >= 1;
  const stacked = Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) >= 1;
  if (!sideBySide && !stacked) return SINGLE;

  // Order leading → trailing (left → right, or top → bottom), then clip each
  // to the stage so the header (and any toolbar) is excluded.
  const aFirst = sideBySide ? a.x < b.x : a.y < b.y;
  const first = intersect(aFirst ? a : b, stage);
  const second = intersect(aFirst ? b : a, stage);
  if (!first || !second) return SINGLE;

  let highway: Rect;
  let hud: Rect;
  if (sideBySide) {
    [highway, hud] = highwaySide === "end" ? [second, first] : [first, second];
  } else {
    // Tabletop: the lower half rests on the table under the player's hands.
    [highway, hud] = [second, first];
  }
  if (highway.width < MIN_HIGHWAY_WIDTH || highway.height < MIN_HIGHWAY_HEIGHT) return SINGLE;

  return {
    kind: sideBySide ? "book" : "tabletop",
    highway: toLocal(highway, stage),
    hud: toLocal(hud, stage),
  };
}

/**
 * Did the screen turn into a different screen? True on fold/unfold (the Duo
 * swaps between ~466 and ~890 px wide), rotation, posture or segment changes,
 * and entering/leaving Split View. False for height-only jitter like Safari's
 * toolbar collapsing, so scrolling chrome never pauses a song.
 */
export function screenFormChanged(prev: ScreenForm, next: ScreenForm): boolean {
  if (prev.width <= 0 || prev.height <= 0) return false; // first measurement
  if (prev.segments !== next.segments || prev.posture !== next.posture) return true;
  if (prev.width > prev.height !== next.width > next.height) return true;
  return Math.abs(next.width - prev.width) / prev.width > FORM_WIDTH_CHANGE;
}
