# Changelog

All notable changes to Slop Hero are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project doesn't cut versioned releases — every merge to `main` deploys —
so entries are grouped by date instead of version. Architectural decisions
behind these changes live in [`docs/adr/`](./docs/adr/).

## 2026-07-13

### Added

- **Practice mode** — Rock Band-style rehearsal: pick one of the chart's
  8-bar sections (with note counts), loop it with a 2s lead-in, and slow
  playback to 0.5× or 0.75×. The rock meter still moves but can never boo
  you off, and practice loops are excluded from metrics and leaderboards.
  ([ADR-0006](./docs/adr/0006-practice-leaderboards-hold-authoring.md))
- **Local leaderboards** — a top-5 board per chart + difficulty, stored on
  your device. The ready screen shows your best; finishing a run shows a
  NEW BEST banner (with the previous record) and the board with your run
  highlighted. Only completed runs rank.
- **Hold authoring in the editor** — the new ▮ brush: tap a note to anchor
  it, tap a later cell in the same lane to set where the sustain ends, tap
  the anchor again to revert it to a tap. Tail cells render along the span.
  Lifts the "taps only" limit of ADR-0003.
- **HOPO notes (hammer-ons / pull-offs)**, adapted for touch: ring-marked
  notes auto-hit when they cross the line with their lane already held — rest
  or slide a finger (slides never count as stray taps or drop sustains), and
  fast runs play themselves as long as the chain stays unbroken. Clone Hero
  `.chart` imports keep authored forced (`N 5`) / tap (`N 6`) flags on top of
  the natural 65/192-beat spacing rule; every other chart gets naturals
  auto-marked. ([ADR-0005](./docs/adr/0005-hopo-whammy-star-authoring.md))
- **Whammy** — wiggle the finger holding a ★ star-phrase sustain (desktop:
  key auto-repeat) to squeeze extra star-power meter out of the tail (a
  quarter bar per 4s), with a wobbling, brighter tail while it lasts.
- **Star-phrase authoring in the editor** — a ★ brush paints phrase
  membership onto existing notes; touching starred notes group into one
  phrase on build. Authored phrases (editor or import) now also survive
  publishing to the community catalog (sanitized and bounded), instead of
  being re-marked on other players' devices.

- **Star power** — Guitar Hero's signature mechanic. Charts now carry star
  phrases (Clone Hero `.chart` imports keep their authored `S 2` phrases;
  every other source gets deterministic auto-marked ones). Hitting every note
  of a phrase banks a quarter of the meter; with at least half a bar stored,
  tap the on-highway meter (or press Enter/Shift) to double all scoring while
  it drains — up to ×8 stacked with the combo multiplier. Activating floods
  the highway electric blue, and completing phrases mid-run extends it.
  ([ADR-0004](./docs/adr/0004-guitar-feel-gameplay.md))
- **Rock meter with song fail** — the classic crowd gauge. Hits nudge it up,
  misses drag it down about twice as hard (star power halves the sting), and
  an empty gauge boos you off the stage: the song stops, a fail screen offers
  a retry, and the run is recorded as not completed.
- **3D perspective highway** — the note highway is now a GH-style fretboard
  receding to a horizon: lanes converge on a vanishing point, notes pop over
  the horizon small and slow then swell and accelerate into the hit line, with
  glowing side rails and perspective-mapped beat bars. Touch input uses the
  exact inverse mapping, so what you see is what you tap.
- **Star rating (0–5)** — live in the score panel and on the results screen,
  derived from the average multiplier sustained across the song (score ÷ base
  chart score), GH style.
- **Miss fret-buzz** — missing a note (or dropping a sustain) plays a short
  synthesized muted-string flub, so misses sting audibly in every playback
  mode (uploaded audio, YouTube, silent).

### Docs

- [ADR-0004](./docs/adr/0004-guitar-feel-gameplay.md) records the gameplay
  decisions above; README (features, how-to-play, architecture) and the Clone
  Hero import doc updated to match.

## 2026-07-06

### Added

- **Persistent song library** — songs you upload, import from Clone Hero, or
  pick from YouTube search are now saved on your device (IndexedDB, audio
  included) and restored into the catalog on every visit. No more re-uploading
  or re-searching each session. Saved songs show a "saved on this device"
  badge in the catalog and can be removed there.
  ([ADR-0001](./docs/adr/0001-local-song-library-indexeddb.md))
- **Community shared catalog** — publish your custom charts to everyone.
  Charts (notes + timing + optional YouTube link — never audio files) are
  stored in the shared Postgres database and appear in a new "Community
  charts" section of the catalog. Submissions are sanitized and clamped
  server-side. ([ADR-0002](./docs/adr/0002-community-catalog-charts-only.md))
- **Real chart editor** at `/editor`, replacing the read-only preview. Start
  from the current song, a saved song, or a blank grid; tap cells on a
  beat-snapped grid (1, 1/2, or 1/4 beat) to place and remove notes; edit
  title/artist/BPM/difficulty; then test-play in the real game, save to your
  device, or publish to the community catalog. When a chart has no video of
  its own, publishing prompts for a matching YouTube link so other players
  hear music instead of silent mode.
  ([ADR-0003](./docs/adr/0003-chart-editor-v1-scope.md))
- `CHANGELOG.md` (this file) and `docs/adr/` for architecture decision
  records.

### Changed

- Catalog and upload copy now explain local persistence and the community
  section.
- Deployment docs migrated from Heroku to the real setup: **Vercel + Neon
  Postgres** (`DATABASE_URL` via the Neon integration). Removed the unused
  `Procfile`.
- Node **22 → 24** in `package.json` engines and all GitHub workflows, to
  match the Vercel project settings.
- Dependency bumps via Dependabot: Next.js 16.2.10, vitest 4, @types/node
  26.1.0, and GitHub Actions majors (checkout v7, setup-node v6,
  create-pull-request v8).

## 2026-06-24 — 2026-07-05

Initial public build: five-lane touch rhythm game (taps + holds), catalog with
royalty-free built-ins, audio upload with onset auto-charting, Clone Hero
import (`.sng`/`.zip`/folder/`.chart`/`.mid`), YouTube search/link playback,
calibration, anonymous metrics dashboard, and the autonomous self-improvement
loop that PRs bounded tuning changes.
