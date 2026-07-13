# 0004 — Guitar-feel gameplay: star power, rock meter, perspective highway

- **Status:** Accepted — the "sanitizer does not carry `starPhrase`" point is
  amended by [0005](./0005-hopo-whammy-star-authoring.md)
- **Date:** 2026-07-13
- **PR:** [#19](https://github.com/CydVilla/slop-hero/pull/19)

## Context

The game had the *skeleton* of Guitar Hero — five lanes, taps, sustains, combo
multipliers — but none of the systems that make GH/Clone Hero feel like GH:
no risk/reward mechanic, no way to fail, a flat 2D highway, and no
at-a-glance "how good was that run" grade. We wanted the signature mechanics
without breaking the project's boundary rules (pure rules in `src/game/*`,
zero re-renders in the canvas loop) or the touch-first input model.

## Decision

### Star power

- Charts carry **star phrases** as an optional `starPhrase?: number` on
  `ChartNote` (phrase id; all notes sharing an id form one phrase). Optional
  field ⇒ every previously stored chart (IndexedDB library, community
  catalog, editor drafts) remains valid.
- **Authored phrases win**: the `.chart` parser now reads `S 2` special
  events and tags covered notes. Sources without phrases (auto-mapper, audio
  analysis, editor, MIDI — our minimal SMF reader has no note-offs, so MIDI
  SP is unreadable) get **deterministic auto-marking** at play time
  (`ensureStarPhrases`): after a short intro, ~6 consecutive notes form a
  phrase, then a ~10s gap; chords are never split. Deterministic so replays
  of the same chart always star the same notes.
- **Rules** (matching GH): hitting *every* note of a phrase banks 25% of the
  meter (one miss voids that phrase); activation needs ≥ 50% stored; while
  active, scoring is doubled (stacks with combo ×4 → ×8 ceiling) and a full
  bar drains in 12s; completing a phrase mid-run tops up and extends.
- **No per-frame state**: the meter is stored as `(meter, activatedAtMs)`
  and the current level is *derived* (`starPowerMeterAt(state, songTime)`).
  The gameplay hook keeps an authoritative ref plus a low-frequency React
  mirror written only on discrete events; the canvas derives the smooth
  drain each frame from the ref. Activation is a tap on the on-highway
  meter (bottom center, generous hitbox) or Enter/Shift on desktop.
- The community-catalog sanitizer intentionally does **not** carry
  `starPhrase` (its whitelist stays minimal); published charts are
  auto-marked on the player's device instead.

### Rock meter + song fail

- A 0..1 crowd gauge starting at 0.5: hits add by judgement quality
  (perfect +0.02), misses subtract ~2× a perfect (−0.04), dropped sustains
  −0.02; star power halves losses (the classic "pop SP to survive" move).
- Empty gauge ⇒ new `GamePhase` value **`"failed"`**: audio stops, a fail
  overlay offers retry, and the run **is recorded** in metrics with
  `completed: false` so the self-improvement loop can see charts that boo
  players off stage (previously abandoned runs were simply never recorded).

### Perspective highway

- The 3D look is **renderer-only**: pure mapping helpers turn linear note
  progress into depth (`t = p^1.55`), lane x (converging on a vanishing
  point, board narrows to 36% at the horizon) and gem scale. Chart data,
  timing math, and hit windows are untouched — a note still judges at the
  same millisecond; only where it *draws* changed.
- Touch input uses the **exact inverse mapping** (`laneAtPoint`), so the
  lane under the finger is the lane on screen at any depth.

### Star rating

- 0–5 stars from `score ÷ baseChartScore` (the run's average multiplier),
  thresholds `[0.4, 1.0, 1.8, 2.6, 3.4]` — 5★ ≈ near-full combo. Shown live
  and on results. Base score = all-perfect, all-sustains, ×1.

### Miss sound

- A synthesized fret-buzz (filtered noise + low thunk, `src/lib/sfx.ts`)
  with its own lazy `AudioContext`, so it works identically in Web Audio,
  YouTube, and silent modes. Throttled, best-effort, no audio assets.

## Options considered

- **Meter as per-frame React state** — rejected: violates the zero-re-render
  loop; the derived-drain design keeps writes to discrete events.
- **Per-star-note meter gain** (simpler than phrase tracking) — rejected:
  all-or-nothing phrases are the GH mechanic and reward clean play.
- **Real 3D (WebGL/three.js)** — rejected for v1: a dependency and a
  renderer rewrite; Canvas 2D with a perspective mapping gets the look while
  keeping the existing draw pipeline and input model.
- **Failing without recording the run** — rejected: failed runs are exactly
  the signal the tuning loop needs for over-hard charts.

## Consequences

- `ChartNote.starPhrase` and `GamePhase: "failed"` are additive API changes;
  all existing charts and stored data keep working.
- Auto-marked phrases are heuristic — imported `.chart` songs feel canonical,
  generated charts get "reasonable" phrase placement that may not match a
  human charter's choices. Acceptable for v1; the editor could gain phrase
  authoring later.
- The renderer and input share perspective helpers inside `GameCanvas`; if a
  second consumer ever needs them, they should move to `src/game/`.
- Song fail makes difficulty tuning higher-stakes: `difficultyDensityScale`
  (ADR-worthy on its own if changed) now interacts with the rock meter. The
  metrics dashboard sees failed runs as `completed: false`.
