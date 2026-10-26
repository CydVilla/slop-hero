# 0007 — Foldable (iPhone Duo) support: feature-detect the fold, never the device

- **Status:** Accepted (tabletop layout amended by
  [0008](./0008-duo-versus-fret-pads-calibration.md): fret pads by default)
- **Date:** 2026-10-24

## Context

The iPhone Duo (October 2026) gives the game a second big touchscreen. Its
open inner display is about 890 × 626 CSS px, wider than tall, with a vertical
hinge down the middle. Its outer display is a narrow phone, about 466 × 678.
Three problems showed up:

- In half-folded (book) posture, a full-width highway bends across the hinge,
  and the center lane sits right on the fold.
- Folding, unfolding, or rotating mid-song re-lays out the highway under the
  player's fingers.
- On every iPhone, Web Audio is muted by the silent switch, so uploaded songs
  can play with no sound.

Safari reports the Duo as an ordinary iPhone. Fold APIs are standard in Chrome
(138+), but their status in Safari is unclear: reportedly behind flags in 27.1.

## Decision

- **Detect capabilities, not the device.** There is no User-Agent check. The
  stage split comes from `window.viewport.segments` when the browser reports
  two or more. Otherwise, a narrow heuristic applies: a centered vertical hinge
  when `(device-posture: folded)` matches on a viewport at least 760 px wide
  with an aspect ratio of 1.2 or more. These rules live in
  `src/lib/foldable.ts` (pure, unit-tested) and `src/hooks/useFoldLayout.ts`
  (browser glue). Android foldables get the same behavior for free.
- **Split the stage, not the renderer.** In book or tabletop posture, the
  canvas layer is positioned over one segment, and the score and calibration
  panels move to the other. Book posture puts the highway on the trailing
  half; tabletop puts it on the flat bottom half. Modals sit over the highway
  pane. Perspective, timing, and input are untouched, because touch already
  maps through the canvas's own rect.
- **Pause on screen-form changes.** The game pauses on a width change of more
  than 15%, an orientation flip, a posture change, or a segment-count change
  mid-song. Height-only changes (toolbar collapse) are ignored.
- **Use the `playback` audio session for real songs.** Set it via
  `navigator.audioSession` where it exists; silent/demo mode returns to `auto`.

## Consequences

- With no fold APIs, the Duo still gets the short-landscape layout,
  auto-pause, silent-switch fix, and long-press hardening. It just doesn't
  split in book posture. That's acceptable: a split with the fold in the
  wrong place would be worse.
- The heuristic is a stopgap. Revisit or delete it once WebKit ships viewport
  segments unflagged.
- The `playback` session interrupts other audio, such as the player's music
  app, while a real song is loaded. That's intended for a rhythm game, and
  demo mode doesn't do it.
- Details, testing recipes, and follow-up ideas are in
  [`docs/iphoneDuoSupport.md`](../iphoneDuoSupport.md).
