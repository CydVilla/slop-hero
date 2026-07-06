# 0003 — Chart editor v1: beat-grid taps, no timeline audio

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

`/editor` was a read-only JSON viewer. Users asked for an approachable way to
make and share their own charts. Full charting suites (Moonscraper, feedback
editors) center on a scrolling audio timeline with waveform, scrubbing, and
hotkeys — powerful, but a big build and intimidating for the touch-first,
casual audience this game targets (large controls, Tesla browser, no keyboard
assumed).

## Decision

Ship an intentionally small, friendly editor built around a **beat grid**:

- Three starting points: the current song, a saved library song, or a blank
  grid — no empty-state dead ends.
- Notes are placed/removed by tapping cells on a grid snapped to 1, 1/2, or
  1/4 beat, paged 32 beats at a time (works with fingers, cheap to render, no
  virtualization needed).
- Metadata editing (title, artist, BPM, difficulty), test-play in the real
  game, save to the device library (ADR-0001), publish to the community
  catalog (ADR-0002).

Deliberately **out** of v1: hold-note authoring (existing holds render and can
be deleted), waveform/audio scrubbing, undo/redo (toggling a cell is its own
undo), per-note fine offsets, and BPM-change re-timing of existing notes
(changing BPM moves the grid, not placed notes — stated in the UI).

## Consequences

- A newcomer can go from blank grid to a published community chart in a
  couple of minutes, entirely by tapping.
- Precision charting against off-grid onsets isn't possible in the editor yet;
  auto-analyzed charts remain the way to match audio exactly. The grid model
  (notes stored as absolute ms, grid as a view) leaves room for a timeline
  view later without a data migration.
- The paged grid caps DOM size (≤ 128 rows × 5 lanes per page), keeping the
  editor responsive on modest hardware.
