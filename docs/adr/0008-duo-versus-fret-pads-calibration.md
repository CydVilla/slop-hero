# 0008 — Two-player versus, tabletop fret pads, device calibration

- **Status:** Accepted (amends the tabletop layout of
  [0007](./0007-foldable-iphone-duo-support.md))
- **Date:** 2026-10-24

## Context

ADR-0007 made the game work on the iPhone Duo. The follow-up research
(`docs/iphoneDuoSupport.md`) listed what would make it *good* there:

- A posture-aware way to play in tabletop.
- A use for the open screen's room.
- Calibration that can cope with Bluetooth headphones (150–250 ms late).
- Full-screen play, a screen that stays on, and crisper rendering.
- HUD sizing that doesn't misfire on foldables.
- Automated coverage of all of the above.

## Decision

### Tabletop: fret pads by default

0007 put the highway on the flat bottom half. Now **fret-pad mode** is the
default: the highway goes on the upright top half and five pads go on the flat
half. This follows the foldable guidance of glanceable content up and touch
controls down, and it's closer to a guitar controller. The pads reuse the
highway's touch semantics: press/anchor, slide = positional hold for HOPOs,
wiggle = whammy. 0007's layout stays one tap away ("Tap highway instead"), and
the choice is remembered in `playPrefs`, alongside the book-posture **swap
sides** choice.

### Two players: two game hooks, one clock

Two-player mode instantiates `useRhythmGame` twice rather than generalizing
the hook to N players. The hook is the most intricate code in the app, and a
second copy needs no changes to its rules. Both copies run through a **shared
transport** (`src/lib/sharedTransport.ts`), which works like this:

- Duplicate play requests for the same position within 60 ms collapse into
  one.
- The song stops only when every active player has stopped.
- With one player, every call passes straight through.

The arbitration state lives in a ref, so it survives the engine object being
rebuilt on play/pause. Versus rules are pure (`src/game/versus.ts`): highest
score wins, and getting booed off forfeits. Versus runs aren't recorded in
metrics or leaderboards, same as practice.

Two players are offered only where each half is at least 300 × 300, and never
in tabletop, where the hinge would cut both highways.

### Calibration: measured, seeded, and remembered per device

- **Tap test.** It plays an audio-only metronome on the game's own clock type.
  The median tap lag (outliers dropped, at least 6 taps) becomes the
  calibration: `calibration = −median(lag)`. That's the sign `timing.ts`
  actually uses. Its prose and the README had it backwards, and both were
  corrected.
- **Latency seed.** It's used only when nothing is saved and the browser
  reports `outputLatency`. Only the latency beyond typical speakers is
  applied. The seed isn't saved until the player confirms it.
- **Calibration is saved on the device** (localStorage), because it belongs
  to the audio route, not the song. The range is widened to ±350 ms for
  computed values.

### Platform polish

- **Screen Wake Lock** during count-in and play.
- **Web app manifest + Apple web-app metadata** with generated icons, plus an
  install hint on the landing page.
- **Canvas backing store at native density up to 3×**, stepping down when the
  median frame time exceeds 20 ms.
- **CSS container queries** for the HUD, panels, and cards, instead of
  viewport media queries. The header keeps its viewport queries.
- **A Playwright smoke suite** (`e2e/foldables.spec.ts`) at the Duo's widths
  and postures, run as its own CI job. It's kept out of the required
  "Typecheck & build" gate so a browser-install failure can't block merges.

## Consequences

- **Two hook instances means player 2 always exists.** It's inert in solo
  play, and the cost is one extra runtime map per chart. Leaving versus mode
  calls the new `reset()` on both games so player 2 never lingers mid-run.
- **The tap test sets the `playback` audio session**, which interrupts other
  audio while it runs. That's intended: it should hear what the game will.
- **The render scale only ever steps down within a session.** A device that
  stutters once, such as in Low Power Mode, stays at the lower scale until
  reload.
- **Postures are emulated in Chromium, not tested in Safari.** The e2e suite
  can't cover Safari's flagged fold APIs; that still needs the Xcode simulator
  or hardware.
