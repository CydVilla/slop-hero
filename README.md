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
- 🎸 **Clone Hero import**: drop a `.sng`, a `.zip` song folder, an unzipped
  **song folder** (drag-and-drop or "Choose folder"), or a bare `.chart` /
  `.mid` and play it on the touchscreen.
- ⏱️ Web Audio API as the timing source (precise, monotonic clock).
- 🎯 Five lanes (green/red/yellow/blue/orange), large touch targets.
- 🟢 Hit windows: Perfect ±35ms, Great ±70ms, Good ±110ms.
- 🔢 Score, combo, max combo, accuracy, and per-rating counts with combo
  multipliers (×1 / ×2 / ×3 / ×4).
- 🎚️ Calibration offset control for audio/input sync (−10 / +10 / reset).
- 🖱️⌨️📱 Mouse, touch (Pointer Events), and keyboard (A/S/D/F/G + Space).

## Getting started

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

- `/` — landing page (Play random / Browse catalog / Upload song).
- `/play` — the game (falls back to a random catalog track in silent mode).
- `/catalog` — browse all tracks and their contributors; play any of them.
- `/upload` — upload audio, pick difficulty + BPM, credit yourself, generate a chart.
- `/editor` — read-only chart viewer (full editor is a future iteration).

### Scripts

```bash
npm run dev        # start dev server
npm run build      # production build
npm run start      # serve production build
npm run typecheck  # tsc --noEmit
npm run lint       # next lint
```

### Dependencies & automated updates

Dependencies are kept current automatically:

- **[Dependabot](.github/dependabot.yml)** opens PRs weekly for npm packages and
  GitHub Actions. Minor/patch bumps are grouped into a single "non-major" PR;
  majors get their own PR.
- **[CI](.github/workflows/ci.yml)** runs `npm ci`, `npm run typecheck`, and
  `npm run build` on every PR. This is the gate that decides whether an update
  "breaks something".
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

## How to play

1. Open `/play` (or pick a track from `/catalog`, or upload a song first).
2. Press **Start** (or **Space**).
3. **Tap the note itself** — touch its lane on the highway the moment the gem
   reaches the hit line. Each finger taps its own note, so chords work.
   - Desktop: keys **A S D F G** map to the five lanes.
4. If notes feel early/late, nudge the **Calibration** offset.

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

Adaptations for touch: sustains import as taps, chords are capped at 2 notes, and
HOPO/forced/tap/star-power flags are dropped. Details and remaining work:
`docs/cloneHeroImportPlan.md`.

## Architecture

The codebase keeps **pure game logic separate from React** so the rules are
testable and the UI stays thin.

```
src/
  app/                 # Next.js App Router pages
    page.tsx           # landing
    play/page.tsx      # game screen (random-track fallback)
    catalog/page.tsx   # track catalog + contributors
    upload/page.tsx    # upload + chart generation
    editor/page.tsx    # chart viewer placeholder
  components/          # React UI (rendering + panels)
    GameScreen.tsx     # composition root for a play session
    GameCanvas.tsx     # Canvas renderer + rAF loop + tap-the-note input
    PlayRandomButton.tsx # picks a random track → /play
    ScorePanel.tsx
    CalibrationPanel.tsx
    UploadPanel.tsx
  game/                # PURE TypeScript engine — no React, no DOM
    types.ts           # domain types (Lane, ChartNote, RhythmChart, ScoreState…)
    constants.ts       # hit windows, lane count, scroll speed, scoring values
    timing.ts          # offset/calibration math, note travel progress
    scoring.ts         # hit detection, rating, combo, miss marking, accuracy
    chartUtils.ts      # ids, sorting, validation, runtime-state construction
    demoChart.ts       # built-in demo chart
    autoMapper.ts      # deterministic BPM-grid automapper (+ fallback)
    audioAnalysis.ts   # pure DSP: FFT, spectral-flux onsets, tempo, charting
    cloneHeroParser.ts # Clone Hero .chart / .mid / song.ini → RhythmChart
    sngParser.ts       # Clone Hero .sng (SNGPKG) container reader + de-masking
  data/
    tracks.ts          # the open-source track catalog (add tracks here)
  hooks/
    useAudioEngine.ts  # Web Audio wrapper = the clock + playback
    useRhythmGame.ts   # orchestrates rules + React state transitions
  lib/
    activeSong.ts      # in-memory hand-off between routes → /play
    analyzeClient.ts   # decode + drive the analysis worker (main thread)
    cloneHeroClient.ts # unzip + inspect/import Clone Hero songs in-browser
  workers/
    analyzeWorker.ts   # runs audioAnalysis off the main thread
docs/                  # future-work plans + references
.github/               # issue forms (bug / feature / track) + PR template
```

### Design principles

- **Timing source of truth** is `AudioContext.currentTime` (see
  `useAudioEngine`). Works in both audio mode and silent/demo mode.
- **No React re-renders in the animation loop.** The canvas reads per-note
  state, feedback, and lane flashes from **refs**; React state is reserved for
  low-frequency UI (score, phase, calibration).
- **Pure rules.** `scoring.ts` and `timing.ts` are deterministic functions of
  their inputs — easy to unit test (find hittable note, rating for error, mark
  missed notes, apply hit/miss, accuracy).
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
payments, a persistent online song library, copyrighted-song hosting, and native
Tesla integration. (Client-side onset/tempo analysis **and** Clone Hero import —
`.sng` / `.zip` / `.chart` / `.mid` — **are** built; see above.) See `docs/` for
the plans:

- `docs/aiChartGenerationPlan.md` — real chart generation pipeline.
- `docs/serverSideAudioAnalysis.md` — where heavy DSP/ML should run.
- `docs/cloneHeroImportPlan.md` — Clone Hero import (incl. current behavior).
- `docs/trackCatalog.md` — catalog data model & how to add tracks.

## Tech stack

Next.js (App Router) · React · TypeScript (strict) · Canvas 2D · Web Audio API ·
CSS Modules. Local-first; no database.
