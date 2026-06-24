# Contributing to Slop Hero

Thanks for your interest in contributing! Slop Hero is an open-source,
touchscreen rhythm game for the parked Tesla browser (and any landscape
touchscreen). This guide covers how to get set up, the project conventions, and
the easiest ways to contribute — including **adding a track to the catalog**.

> ⚠️ Reminder: this is a parked-use game. Keep that framing in features and copy.

## Code of conduct

Be kind and constructive. Assume good intent. Harassment of any kind is not
welcome.

## Getting started

Requirements: **Node 18+** (Node 22 recommended) and npm.

```bash
git clone <your-fork-url>
cd slop-hero
npm install
npm run dev        # http://localhost:3000
```

Useful scripts:

```bash
npm run typecheck  # tsc --noEmit (strict)
npm run build      # production build
npm run lint       # next lint
```

Please make sure `npm run typecheck` and `npm run build` pass before opening a PR.

## Project structure & conventions

The golden rule: **keep gameplay rules pure and out of React.**

```
src/
  app/         # Next.js App Router pages (routing + layout only)
  components/  # React UI: rendering + panels (thin)
  game/        # PURE TypeScript engine — NO React, NO DOM. Testable.
  hooks/       # React glue (audio engine, game orchestration)
  data/        # tracks.ts — the open-source track catalog
  lib/         # small app utilities (active-song hand-off)
docs/          # design + roadmap docs
```

- **Strict TypeScript.** No `any`. Prefer explicit domain types and discriminated
  unions. Make illegal states hard to represent where it's cheap to do so.
- **Pure logic in `src/game/*`.** Scoring, timing, hit detection, chart utilities
  must be deterministic functions of their inputs (no DOM/audio/React). This is
  what keeps them testable and reusable.
- **No React re-renders in the animation loop.** High-frequency state (note
  runtime, feedback, lane flashes) lives in refs; React state is for
  low-frequency UI (score, phase, calibration).
- **Constants over magic numbers.** Hit windows, lane count, scroll speed, and
  scoring values live in `src/game/constants.ts`.
- **Comments explain *why*, not *what*.** Especially around timing/calibration.

## Adding a track to the catalog 🎵

This is the most welcome kind of contribution and needs no audio file.

1. Open `src/data/tracks.ts`.
2. Add an entry to `builtInTracks`. For a procedurally-generated chart, use the
   `autoTrack({ ... })` helper:

   ```ts
   autoTrack({
     id: "my-track",            // unique, kebab-case
     title: "My Track",
     artist: "Generated",
     contributor: "your-name",  // your name or GitHub handle (shown publicly)
     contributorUrl: "https://github.com/your-name", // optional
     difficulty: "hard",        // easy | medium | hard | expert
     bpm: 138,
     durationSeconds: 90,
     addedAt: "2026-06-24",     // YYYY-MM-DD
   }),
   ```

   For a hand-authored chart, add a full `CatalogTrack` with a custom `build()`
   that returns a `RhythmChart` (see `highway-demo` for the pattern).
3. Run `npm run dev`, open `/catalog`, and play your track to sanity-check it.
4. Open a PR using the **Track submission** issue/PR flow.

See `docs/trackCatalog.md` for the full data-model reference.

### Please do NOT commit copyrighted audio

Built-in tracks ship **without audio** and play in silent/demo mode. Do not add
audio files you don't have the rights to distribute. Hosting copyrighted audio is
explicitly out of scope (see the README's "Not built yet" section).

## Reporting bugs / requesting features

Use the issue templates (Bug report / Feature request / Track submission). Please
include reproduction steps, browser/device, and screenshots where useful.

## Pull requests

- Branch from `main`, keep PRs focused and reasonably small.
- Fill out the PR template (summary + test plan).
- Make sure `typecheck` and `build` pass.
- Reference any related issue (e.g. `Closes #123`).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
