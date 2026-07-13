# 0006 — Practice mode, local leaderboards, hold authoring

- **Status:** Accepted (lifts the "no hold authoring" limit of
  [0003](./0003-chart-editor-v1-scope.md))
- **Date:** 2026-07-13

## Context

With the core mechanics complete (ADR-0004/0005), three quality-of-loop gaps
remained: no way to rehearse a hard section without replaying the whole song
(and getting booed off while learning), no memory of your best runs, and the
editor's v1 "taps only" limit — sustains could be imported and deleted but
never authored.

## Decision

### Practice mode (Rock Band-style rehearsal)

- **Sections, not free A/B marks:** the chart splits into 8-bar sections
  (~15s windows when the tempo is unknown); empty sections are dropped and
  bar labels are derived from the *musical* position so they stay truthful
  across gaps. A picker on the ready screen lists them with note counts.
- **The loop is a fresh pass:** each wrap rebuilds the runtime with notes
  outside the section *pre-resolved* (judged silently — never drawn, never
  missed, not counted), resets the loop's score, seeks to a 2s lead-in, and
  keeps playing. No countdown between loops.
- **No fail, no records:** the rock meter still moves but can never end the
  run; practice runs are excluded from metrics and leaderboards.
- **Speed control (0.5/0.75/1×):** `AudioEngine` gains `setRate`. The Web
  Audio engine scales its clock math (`startOffset + elapsed × rate`, source
  `playbackRate`, re-anchoring on change); the YouTube engine multiplies its
  interpolation by the rate and calls `setPlaybackRate` (its 250ms drift
  corrector guards the rest). Since every game system runs on song time,
  slowing the clock slows note travel and judging coherently for free.
  Pitch shifts with rate — accepted (classic practice-mode trade-off).

### Local leaderboards

- A **top-5 board per chart + difficulty** in localStorage (same
  device-local privacy stance as the metrics client), keyed by
  `trackId::difficulty`. The ranking core (`rankScore`) is pure: sorted by
  score, ties by accuracy; equal score is *not* a new best.
- The ready screen shows the device's best; the results card shows a NEW
  BEST banner (with the previous best) and the top-5 board with this run's
  row highlighted. Only **completed** runs are submitted — failed runs and
  practice loops don't rank.
- Storage fails soft: a blocked/full localStorage disables boards, never
  gameplay.

### Hold authoring in the editor

- A **▮ brush** with a two-tap interaction: tap a note to anchor (pulsing
  highlight), tap a later cell in the same lane to set where the tail ends;
  tapping the anchor again reverts it to a tap; tapping another note
  re-anchors. Tail cells render along the span so sustain extents are
  visible on the grid.
- Durations shorter than `MIN_HOLD_MS` are stored but play as taps —
  consistent with import semantics.
- Found and fixed in review-by-browser: the brush logic originally lived
  inside a `setState` updater, whose StrictMode double-invocation made the
  anchor toggle itself off within one tap. Rule reinforced: **no side
  effects in updaters** — the editor now computes the next chart outside
  `setLoaded`.

## Options considered

- **Free A/B loop markers** — rejected for v1: setting precise marks on a
  touchscreen mid-song is fiddly; fixed musical sections are one tap and
  match how players think ("that fast part in bars 17–24").
- **Time-stretch without pitch shift** — rejected: needs a DSP dependency
  (phase vocoder) or `preservesPitch` audio elements; `playbackRate` on the
  existing engines is a few lines and matches the classic feel.
- **IndexedDB for scores** — rejected: boards are tiny (5 rows × charts);
  localStorage read/write simplicity wins, and the metrics client already
  set the precedent.
- **Drag-to-extend holds** — deferred: drag conflicts with scroll on the
  grid; the two-tap flow reuses the existing tap interaction and undo model.

## Consequences

- `AudioEngine.setRate` is part of the engine contract now (optional on
  `GameAudioControls`, so tests/stubs without it keep working).
- Practice pre-resolution means phrases/HOPO chains crossing a section
  boundary can't complete inside the loop (their outside notes never count)
  — acceptable: rehearsal targets the section's own runs.
- The leaderboard key uses the session's `trackId`; editor test-plays share
  the `editor-preview` id, so different drafts pool one board — acceptable
  for a preview surface.
- ADR-0003's "existing holds render and can be deleted, not authored" limit
  is lifted; its other limits (no waveform, no undo stack) stand.
