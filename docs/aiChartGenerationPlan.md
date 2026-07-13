# AI Chart Generation Plan

This document describes the real chart-generation pipeline that replaces (and
will keep improving on) the placeholder automapper in `src/game/autoMapper.ts`.

There are now **two** generators, both emitting the same `RhythmChart`:

1. **Grid automapper** (`src/game/autoMapper.ts`) — deterministic notes on a
   fixed BPM grid. Playable but musically naive. Still used for the demo/catalog
   tracks (which have no audio) and as a fallback.
2. **Audio analyzer** (`src/game/audioAnalysis.ts`) — **implemented**. Decodes
   the uploaded audio and places notes on *detected musical onsets* with a
   detected tempo. Runs entirely client-side in a Web Worker. This is step 1 of
   the incremental path below.

The goal of the remaining steps is to keep improving chart musicality (stems,
melodic lane motion, server-grade models) behind the same output contract.

## Implemented: client-side analysis (Phase 1)

`src/game/audioAnalysis.ts` is pure, dependency-free DSP so it is testable and
runs in a worker on the Tesla browser with nothing to ship/break:

- compact radix-2 **FFT** + Hann-windowed STFT,
- **spectral-flux** onset-strength envelope,
- **adaptive peak picking** (local-mean threshold + min spacing) → onset times,
  strengths, and per-onset brightness (spectral centroid),
- **tempo estimate** via autocorrelation of the onset envelope (informational),
- difficulty-aware selection (strength percentile + min gap) and **lane
  assignment** from range-normalized brightness, avoiding same-lane repeats.

Orchestration:

- `src/lib/analyzeClient.ts` — main thread: `decodeAudioData` → downmix to mono
  → transfer PCM to the worker → resolve a `RhythmChart` (with progress).
- `src/workers/analyzeWorker.ts` — runs the DSP off the main thread.
- `UploadPanel` exposes a "Chart source" toggle (Auto-analyze / Simple BPM grid)
  and transparently falls back to the grid if decoding fails or too few onsets
  are found.

## Output contract (stable)

Whatever the backend does, it must emit the existing internal format so the
client never changes:

```ts
RhythmChart // see src/game/types.ts
```

Keeping this contract stable means we can swap the generator (client grid →
server ML) without touching gameplay, scoring, or rendering.

Generators don't need to emit star-power phrases: any chart whose notes have
no `starPhrase` gets deterministic phrases auto-marked at play time
(`ensureStarPhrases`, see
[ADR-0004](./adr/0004-guitar-feel-gameplay.md)). A future generator *may* set
`starPhrase` itself (e.g. to star the most interesting sections) and the game
will use those instead.

## Pipeline

```
audio file
  -> duration / metadata extraction
  -> BPM estimation
  -> beat grid generation
  -> onset detection
  -> optional stem separation
  -> lane assignment
  -> difficulty scaling
  -> playability cleanup
  -> RhythmChart JSON
```

### 1. Duration / metadata extraction
Decode the file, read sample rate, channel count, and exact duration. (Today the
client does this with an `<audio>` element + Web Audio `decodeAudioData`.)

### 2. BPM estimation
Estimate tempo from an onset-strength envelope + autocorrelation / tempogram.
Allow a manual override (the upload UI already collects a BPM). Detect and
handle tempo drift later; assume constant tempo first.

### 3. Beat grid generation
From BPM + downbeat phase, generate a quantization grid (1/4, 1/8, 1/16). Notes
will snap to this grid for a tight, readable feel.

### 4. Onset detection
Compute onsets via spectral flux / superflux. These are the candidate note
times. Snap each onset to the nearest grid slot and de-duplicate.

### 5. Optional stem separation
Use a source separator (e.g. Demucs / Spleeter) to split drums / bass / vocals /
other. This enables mapping different instruments to different lanes and far more
musical charts (kick → one lane, snare → another, etc.).

### 6. Lane assignment
Map onsets to the 5 lanes. Strategies, in increasing sophistication:
- pitch/frequency band → lane (low freq = left, high = right)
- per-stem → lane group
- melodic contour → stepwise lane motion (avoid random jumps)

### 7. Difficulty scaling
Thin or thicken the note set per difficulty by filtering on onset strength,
grid resolution, and chord frequency — mirroring the placeholder's density
profiles but driven by real signal.

### 8. Playability cleanup
Critical for a *touchscreen*: remove physically awkward patterns (rapid same-lane
repeats, too-dense bursts, more than 2 simultaneous notes), enforce a minimum
spacing, and cap notes-per-second per difficulty.

### 9. Emit `RhythmChart` JSON
Assemble metadata + cleaned notes and return.

## Where this runs

See `serverSideAudioAnalysis.md`. Short version: heavy DSP/ML belongs on a
server (or a WASM/Web Worker for lighter analysis). The client should remain a
thin consumer of `RhythmChart` JSON.

## Incremental path

1. ✅ **Done** — Client-side BPM + onset detection in a Web Worker (no ML).
   See "Implemented: client-side analysis" above.
2. Beat-grid snapping of detected onsets (tighter, more readable charts) +
   onset-latency compensation.
3. Server endpoint `POST /api/analyze` returning `RhythmChart` (for heavier
   models / longer tracks). See `serverSideAudioAnalysis.md`.
4. Add stem separation (Demucs/Spleeter) behind the same endpoint.
5. Train/tune lane-assignment heuristics; add per-difficulty cleanup passes.
