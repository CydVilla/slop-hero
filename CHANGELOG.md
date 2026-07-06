# Changelog

All notable changes to Slop Hero are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project doesn't cut versioned releases — every merge to `main` deploys —
so entries are grouped by date instead of version. Architectural decisions
behind these changes live in [`docs/adr/`](./docs/adr/).

## Unreleased

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

## 2026-07-06

### Changed

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
