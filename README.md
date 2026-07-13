# Slop Hero 🎵

A touchscreen rhythm game for the **Tesla in-car browser**. It is a Clone Hero /
Rock Band–style game adapted for a large touchscreen: **tap-only**, five big
lanes, a vertical falling-note highway, and a hit zone at the bottom. Upload any
song and get an instantly playable chart.

Open source under the [MIT License](./LICENSE) — contributions (especially new
catalog tracks!) are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Features

- 🎮 Playable vertical slice: works with zero setup.
- 🎲 **Play random** picks a track from the catalog each time.
- 🗂️ **Track catalog** (`/catalog`) lists every track and who contributed it.
- 🎼 Upload audio → auto-generated chart. Two generators: **Auto-analyze**
  (real onset/tempo detection in a Web Worker) or a **Simple BPM grid**.
- 🔎 **Search YouTube** from inside the app (optional — needs an API key, see
  below) and pick a result instead of pasting a link. Falls back to pasting a
  link when search isn't configured.
- 🎸 **Clone Hero import**: drop a `.sng`, a `.zip` song folder, an unzipped
  **song folder** (drag-and-drop or "Choose folder"), or a bare `.chart` /
  `.mid` and play it on the touchscreen.
- 💾 **Your songs stick around** — uploads, imports, and YouTube picks are
  saved on your device (IndexedDB, audio included) and restored into the
  catalog on every visit. No re-uploading, no re-searching.
- ✏️ **Chart editor** (`/editor`) — start from the current song, a saved song,
  or a blank grid; tap beat-snapped cells to place notes and paint ★
  star-power phrases with the star brush; test-play, save to your device, or
  publish (authored phrases ship with the chart).
- 🌐 **Community charts** — publish your chart to the shared catalog for
  everyone (notes + optional YouTube link only, never audio files). Backed by
  the same Postgres database as the metrics.
- ⏱️ Web Audio API as the timing source (precise, monotonic clock).
- 🛣️ **3D perspective highway** — a Guitar Hero-style fretboard receding to a
  horizon: lanes converge on a vanishing point and notes pop over the horizon
  small and slow, then swell and accelerate into the hit line.
- 🎯 Five lanes (green/red/yellow/blue/orange), large touch targets.
- 🎸 **Hold notes (sustains)** — Guitar Hero / Rock Band style: tap the head, then
  keep the lane pressed through the tail for a length-scaled bonus. Releasing
  early drops the sustain and breaks your combo. Works with multi-touch, so you
  can hold one lane while tapping others.
- ⭐ **Star power** — hit every note of a ★ phrase to bank a quarter of the
  meter; at half a bar, tap the meter (or press Enter) to double all scoring
  while it drains, up to ×8 with the combo multiplier. Clone Hero imports keep
  their authored `S 2` phrases; every other chart gets phrases auto-marked.
- 🤘 **HOPOs (hammer-ons / pull-offs)**, touch-adapted: ring-marked notes
  auto-hit when they cross the line with their lane already held — rest or
  slide a finger across lanes and fast runs play themselves, as long as the
  previous note was hit. `.chart` imports keep authored forced/tap flags.
- 🎚️ **Whammy** — wiggle the finger holding a ★ sustain (desktop: key
  auto-repeat) to squeeze bonus star-power meter out of the tail.
- ❤️ **Rock meter** — hits push the crowd gauge up, misses drag it down twice
  as hard; let it hit empty and you're booed off the stage (song fail).
- 🌟 **Star rating** (0–5), live during play and on the results screen, based
  on the average multiplier you sustain across the song.
- 🔇 Missing a note plays a synthesized fret-buzz sting, GH style.
- 🟢 Hit windows: Perfect ±50ms, Great ±95ms, Good ±140ms (touch-tuned).
- 🔢 Score, combo, max combo, accuracy, and per-rating counts with combo
  multipliers (×1 / ×2 / ×3 / ×4).
- 🎚️ Calibration offset control for audio/input sync (−10 / +10 / reset).
- 🖱️⌨️📱 Mouse, touch (Pointer Events), and keyboard (A/S/D/F/G, Space,
  Enter/Shift for star power).
- 📊 **Metrics dashboard** (`/dashboard`) — anonymous, gameplay-only telemetry
  (accuracy, miss rates, calibration, per-track stats) with an "all players" vs
  "this device" view and privacy controls (opt-out / clear).
- 🤖 **Autonomous self-improvement loop** — the app analyzes aggregated play data
  and opens PRs that nudge bounded tuning (default calibration + note density)
  toward what real players do. See
  [`docs/metricsAndSelfImprovement.md`](./docs/metricsAndSelfImprovement.md).

## Getting started

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

### Optional: enable in-app YouTube search

The Upload screen can search YouTube directly so users don't have to paste a
link. This uses the **YouTube Data API v3**, which needs an API key. The key is
kept server-side (it's never shipped to the browser) and used by the
`/api/youtube/search` route.

1. Create an API key in the [Google Cloud Console](https://console.cloud.google.com/)
   and enable the **YouTube Data API v3**.
2. Add it to `.env.local` (or your deployment's environment variables):

   ```bash
   YOUTUBE_API_KEY=your_key_here
   ```

Without a key, search is disabled gracefully and the UI falls back to the
paste-a-link flow — nothing breaks.

- `/` — landing page (Play random / Browse catalog / Upload song).
- `/play` — the game (falls back to a random catalog track in silent mode).
- `/catalog` — browse all tracks and their contributors; play any of them.
- `/upload` — upload audio, pick difficulty + BPM, credit yourself, generate a chart.
- `/editor` — read-only chart viewer (full editor is a future iteration).
- `/dashboard` — anonymous metrics + autonomous tuning recommendations.

### Scripts

```bash
npm run dev             # start dev server
npm run build           # production build
npm run start           # serve production build
npm run typecheck       # tsc --noEmit
npm run lint            # next lint
npm test                # run the pure-logic unit tests (Vitest, one-shot)
npm run test:watch      # run Vitest in watch mode
npm run analyze:metrics # run the self-improvement analyzer (see below)
```

### Dependencies & automated updates

Dependencies are kept current automatically:

- **[Dependabot](.github/dependabot.yml)** opens PRs weekly for npm packages and
  GitHub Actions. Minor/patch bumps are grouped into a single "non-major" PR;
  majors get their own PR.
- **[CI](.github/workflows/ci.yml)** runs `npm ci`, `npm run typecheck`,
  `npm test`, and `npm run build` on every PR. This is the gate that decides
  whether an update "breaks something".
- **[Auto-merge](.github/workflows/dependabot-auto-merge.yml)** approves and
  enables auto-merge for non-breaking (minor/patch) Dependabot PRs. GitHub then
  merges them **only after CI passes**. **Major** updates are left open with a
  comment so a human can review the breaking change.

One-time repo settings a maintainer must enable for auto-merge to work:

1. **Settings → General → Pull Requests → "Allow auto-merge"**.
2. A **branch protection rule on `main`** that requires the `Typecheck & build`
   status check. Without a required check, GitHub merges as soon as the PR is
   mergeable instead of waiting for CI.

To update everything manually at any time:

```bash
npx npm-check-updates -u   # bump package.json to latest
npm install
npm run typecheck && npm run build
```

## Metrics & self-improvement

The game keeps a data-driven feedback loop that improves itself over time:

1. **Collect** — when a song finishes, an anonymous `PlaySessionEvent` (score,
   accuracy, per-rating counts, calibration, difficulty, track) is stored in the
   browser and (opt-out) posted to `POST /api/metrics/session`. There are no
   accounts and nothing links data to a person.
2. **Visualize** — `/dashboard` renders the aggregates: accuracy distribution,
   per-difficulty miss rates, per-track stats, and calibration — for **all
   players** (server) or **this device** (local, works offline).
3. **Decide** — a pure engine (`src/lib/metrics/insights.ts`) turns the
   aggregates into small, **bounded** tuning changes: the default calibration
   drifts toward the median players dial in; per-difficulty note density adapts
   to real miss rates.
4. **Ship safely** — a scheduled workflow (`.github/workflows/self-improve.yml`)
   runs the analyzer, and if a change is recommended, opens a PR editing only
   `src/game/tuning.json` (+ a report). The existing **CI** gate must pass before
   it can merge, so a bad tune can't land unreviewed.

Full write-up (privacy, storage, Vercel deploy, how to enable the loop, how to
extend it): [`docs/metricsAndSelfImprovement.md`](./docs/metricsAndSelfImprovement.md).

**Deploying:** the app runs on Vercel with Neon Postgres — attach a Neon
database to the Vercel project and `DATABASE_URL` switches the metrics store
from the local JSONL file to Postgres. See the doc for exact steps and GitHub
secrets.

## How to play

1. Open `/play` (or pick a track from `/catalog`, or upload a song first).
2. Press **Start** (or **Space**).
3. **Tap the note itself** — touch its lane on the highway the moment the gem
   reaches the hit line. Each finger taps its own note, so chords work.
   - Desktop: keys **A S D F G** map to the five lanes.
4. **Hold the long notes** — some gems have a glowing tail. Tap the head like a
   normal note, then keep holding (finger down / key held) until the tail clears
   the hit line. Hold all the way for a bonus; let go early and the sustain
   drops (and your combo breaks).
5. **Let the hammer-ons play themselves** — gems with a white ring are HOPOs.
   If the previous note was hit and a finger is already resting on (or slid
   onto) their lane when they cross the line, they fire automatically —
   that's how you survive fast runs: keep fingers down and walk them across
   the lanes instead of tapping every gem.
6. **Watch the rock meter** (the gauge in the score panel) — hits fill it,
   misses drain it twice as fast. If it empties, you're booed off the stage
   and have to retry.
7. **Bank star power** — some gems carry a white ★: they come in short
   phrases, and hitting *every* note of a phrase adds a quarter to the meter
   at the bottom of the highway. Wiggle your finger on a held ★ sustain
   (desktop: the held key's auto-repeat) to whammy extra meter out of it.
   Once it's at least half full, **tap the meter** (desktop: **Enter** or
   **Shift**) to double all scoring while it drains — stacked with the combo
   multiplier that's up to ×8. Completing another phrase while it's blazing
   extends the run, and misses hurt the rock meter only half as much.
8. Chase the **stars** — the 0–5 rating next to your score grades the run by
   the average multiplier you sustain; 5★ takes a near-full combo.
9. If notes feel early/late, nudge the **Calibration** offset.

## How upload & auto-charting works

The whole pipeline runs **in your browser** — nothing is uploaded to a server:

1. You pick an audio file. We create a `blob:` object URL for playback and read
   its metadata (name, size, MIME type), then probe its **duration** with a
   hidden `<audio>` element.
2. You choose a **chart source**, **difficulty**, and **BPM** (default 120), and
   optionally your name for the catalog.
3. The chart is generated as a `RhythmChart`:
   - **Auto-analyze audio (beta)** — decodes the file with `decodeAudioData`,
     downmixes to mono, and runs real DSP in a **Web Worker**
     (`src/game/audioAnalysis.ts`): a Hann-windowed FFT → **spectral-flux onset
     detection** → adaptive peak picking → **tempo estimate** (autocorrelation) →
     difficulty-aware selection and brightness-based lane assignment. Notes land
     on actual musical onsets. A progress bar shows analysis status. If decoding
     fails or too few onsets are found, it **falls back to the grid**.
   - **Simple BPM grid** — the deterministic `src/game/autoMapper.ts`: walks
     beats at a per-difficulty step, places notes with a per-difficulty fill
     probability, avoids same-lane repeats / awkward jumps, and adds occasional
     chords on harder difficulties. Seeded from duration + difficulty + BPM.
4. The track is added to the **catalog** for this session (with your name) and
   `/play` opens, syncing the chart to the audio via `AudioContext.currentTime`.

Auto-analyze is the first step of the real pipeline. Heavier server-side
analysis and stem separation are planned; see `docs/aiChartGenerationPlan.md`.

### Importing Clone Hero charts

Clone Hero import **is supported**. On `/upload`, drop a **`.sng`** package, a
song-folder **`.zip`** (containing `song.ini` + `notes.chart`/`notes.mid` +
audio), an **unzipped song folder** (drag the folder onto the dropzone, or use
**Choose folder**), or a bare **`.chart`** / **`.mid`** file. The app:

1. Unpacks in the browser — `fflate` for `.zip`, a built-in SNGPKG reader for
   `.sng` (`src/game/sngParser.ts`, including the XOR de-masking), or direct
   reads for a dropped folder — and finds the metadata, chart, and audio. For
   folders it scopes to the directory holding `notes.chart`/`notes.mid`, so
   dragging a parent folder still resolves to one song + its matching audio.
2. Parses metadata + which difficulties exist (`src/game/cloneHeroParser.ts`).
3. Lets you pick a difficulty, then converts the 5 frets → 5 lanes into a
   `RhythmChart`. If the song has audio (incl. `song.opus`) it plays with sound;
   otherwise it plays in silent mode.

Adaptations for touch: sustains import as **playable holds** (their length is
preserved and long-enough sustains must be held), chords are capped at 2 notes,
star-power phrases (`S 2`) import as real ★ phrases, and HOPOs import for real
too — natural spacing plus authored forced (`N 5`) / tap (`N 6`) flags. Details
and remaining work: `docs/cloneHeroImportPlan.md`.

## Architecture

The codebase keeps **pure game logic separate from React** so the rules are
testable and the UI stays thin.

```
src/
  app/                 # Next.js App Router pages
    page.tsx           # landing
    play/page.tsx      # game screen (random-track fallback)
    catalog/page.tsx   # track catalog + contributors + community charts
    upload/page.tsx    # upload + chart generation + Clone Hero / YouTube intake
    editor/page.tsx    # beat-grid chart editor (test-play, save, publish)
    dashboard/         # metrics dashboard + self-improvement recommendations
    api/metrics/       # POST session, GET summary, GET insights (Node routes)
    api/charts/        # community chart catalog (list/get/publish)
  components/          # React UI (rendering + panels)
    GameScreen.tsx     # composition root for a play session
    GameCanvas.tsx     # perspective-highway Canvas renderer + rAF loop + touch input
    PlayRandomButton.tsx # picks a random track → /play
    ScorePanel.tsx     # score, combo/multiplier, stars, rock meter, ratings
    CalibrationPanel.tsx
    UploadPanel.tsx
  game/                # PURE TypeScript engine — no React, no DOM
    types.ts           # domain types (Lane, ChartNote, RhythmChart, ScoreState…)
    constants.ts       # hit windows, lane count, scroll speed, scoring, star power
    tuning.ts/.json    # auto-tunable params the self-improvement loop may rewrite
    timing.ts          # offset/calibration math, note travel progress
    scoring.ts         # hit detection, rating, combo, misses, accuracy, holds, stars
    starPower.ts       # star phrases (authored + auto-marked), meter machine, whammy
    hopo.ts            # hammer-ons: natural marking + held-lane auto-hit finder
    rockMeter.ts       # crowd gauge: gains/losses, zones, song-fail check
    chartUtils.ts      # ids, sorting, validation, runtime-state construction
    demoChart.ts       # built-in demo chart
    autoMapper.ts      # deterministic BPM-grid automapper (+ fallback)
    audioAnalysis.ts   # pure DSP: FFT, spectral-flux onsets, tempo, charting
    cloneHeroParser.ts # Clone Hero .chart / .mid / song.ini → RhythmChart (incl. S 2 star phrases)
    sngParser.ts       # Clone Hero .sng (SNGPKG) container reader + de-masking
  data/
    tracks.ts          # the open-source track catalog (add tracks here)
  hooks/
    useAudioEngine.ts  # Web Audio wrapper = the clock + playback
    useYouTubeEngine.ts # YouTube IFrame player as the clock, same interface
    useRhythmGame.ts   # orchestrates rules + React state transitions
  lib/
    activeSong.ts      # in-memory hand-off between routes → /play
    analyzeClient.ts   # decode + drive the analysis worker (main thread)
    cloneHeroClient.ts # unzip + inspect/import Clone Hero songs in-browser
    songLibrary.ts     # IndexedDB persistence for the user's songs
    community/         # community catalog client + server-side chart sanitizer
    sfx.ts             # synthesized sound effects (miss fret-buzz)
    metrics/           # analytics: types, aggregate, insights, store (Postgres/JSONL), client
  workers/
    analyzeWorker.ts   # runs audioAnalysis off the main thread
scripts/
  apply-tuning.mjs     # self-improvement analyzer → rewrites tuning.json + report
docs/                  # future-work plans + references
.github/               # issue forms + PR template + CI / auto-merge / self-improve
```

### Design principles

- **Timing source of truth** is `AudioContext.currentTime` (see
  `useAudioEngine`). Works in both audio mode and silent/demo mode.
- **No React re-renders in the animation loop.** The canvas reads per-note
  state, feedback, and lane flashes from **refs**; React state is reserved for
  low-frequency UI (score, phase, calibration). Continuous values are
  *derived*, not ticked: the star-power meter stores `(level, activatedAt)`
  and the renderer computes the smooth drain each frame from a ref snapshot.
- **Pure rules.** `scoring.ts`, `timing.ts`, `starPower.ts`, and
  `rockMeter.ts` are deterministic functions of their inputs — easy to unit
  test (find hittable note, rating for error, mark missed notes, apply
  hit/miss, accuracy, the hold/sustain lifecycle, star phrases + meter, crowd
  gauge + song fail). See `src/game/*.test.ts` (run with `npm test`).
- **Perspective is presentation.** The 3D highway is a pure mapping inside the
  renderer (progress → depth → y/x/scale) with an exact inverse for touch
  input; chart data, timing, and hit windows are untouched
  ([ADR-0004](./docs/adr/0004-guitar-feel-gameplay.md)).
- **Stable output contract.** The grid automapper, the audio analyzer, and the
  (future) Clone Hero importer all produce the same `RhythmChart` JSON the game
  consumes — so generators can be swapped without touching gameplay.
- **Heavy work off the main thread.** Audio analysis (FFT/onset detection) runs
  in a Web Worker; PCM is *transferred* (not copied) to keep the UI responsive.

## Calibration explained

`effectiveNoteTime = note.timeMs + chart.offsetMs − calibrationOffsetMs`

A **positive** calibration offset judges notes *later* (compensates for tapping
early / audio output latency). The calibration panel shows live song time vs.
the offset-adjusted chart time for debugging.

## Contributing

This project is open source (MIT). The most welcome contribution is **adding a
track to the catalog** — no audio file needed. Edit `src/data/tracks.ts`, run the
dev server, check `/catalog`, and open a PR.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, conventions, and the track
  data model (also documented in `docs/trackCatalog.md`).
- File issues with the **Bug report**, **Feature request**, or **Track
  submission** forms under `.github/ISSUE_TEMPLATE/`.
- Please don't commit copyrighted audio — built-in tracks play in silent/demo
  mode.

## Not built yet (intentionally)

Server-side ML audio analysis, stem separation, multi-stem mixing, accounts,
payments, copyrighted-song hosting, and native Tesla integration. (Anonymous,
gameplay-only metrics **and** an autonomous self-improvement loop that PRs
bounded tuning changes **are** built — see `docs/metricsAndSelfImprovement.md`.)
(Client-side onset/tempo analysis, Clone Hero import — `.sng` / `.zip` /
`.chart` / `.mid` —, a persistent device song library, the chart editor, and a
shared community chart catalog **are** built; see above.) See `docs/` for the
plans:

- `docs/aiChartGenerationPlan.md` — real chart generation pipeline.
- `docs/serverSideAudioAnalysis.md` — where heavy DSP/ML should run.
- `docs/cloneHeroImportPlan.md` — Clone Hero import (incl. current behavior).
- `docs/trackCatalog.md` — catalog data model & how to add tracks.
- `docs/adr/` — architecture decision records (why things are built this way).
- `CHANGELOG.md` — what changed, when.

## Tech stack

Next.js (App Router) · React · TypeScript (strict) · Canvas 2D · Web Audio API ·
CSS Modules. Local-first dev; Neon Postgres (via Vercel) for durable server metrics in production.
