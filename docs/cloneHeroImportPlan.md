# Clone Hero Import

Goal: let users import existing Clone Hero song folders/ZIPs and play them with
the touchscreen tap-only mechanics.

## Current behavior (what happens today)

Clone Hero import is **implemented** for `.sng`, `.zip`, and bare `.chart` /
`.mid` files:

- The `/upload` screen accepts audio **and** Clone Hero files. Drop a `.sng`, a
  `.zip` song folder, or a bare `.chart` / `.mid` and the UI reads it, shows the
  song metadata + which difficulties exist, lets you pick one, and imports it.
- Parsing lives in `src/game/cloneHeroParser.ts` (pure, no DOM):
  - `parseSongIni` — INI metadata.
  - `parseNotesChart` — full `.chart` parser (resolution + tempo map →
    tick-to-ms, `[XxxSingle]` note sections).
  - `parseNotesMidi` — a minimal Standard MIDI File reader (tempo track + the
    guitar track's note-on events per difficulty).
  - `importCloneHeroSong` — orchestrates the above into a `RhythmChart`.
- `.sng` (SNGPKG) parsing lives in `src/game/sngParser.ts` (pure): reads the
  header + 16-byte XOR mask, the metadata section (song.ini fields live here),
  and the file index, then un-masks each packed file
  (`byte ^= xorMask[i % 16] ^ (i & 0xFF)`). Opus/Ogg audio decodes natively.
- ZIP/`.sng` intake + audio object URLs live in `src/lib/cloneHeroClient.ts`
  (`inspectCloneHeroFile` / `importCloneHeroPackage`), using `fflate` to unzip
  in the browser. If the song includes audio (`song.opus`, `song.ogg`, …) it
  plays with sound; otherwise the chart plays in silent mode.

### Known limitations / not yet done

- Multi-stem audio is not mixed; we pick `song.*` (else `guitar.*`, else the
  first audio file).
- Sustains import as **playable holds**: their `durationMs` is preserved and
  sustains at/over `MIN_HOLD_MS` are tagged `type: "hold"`, so the player taps
  the head and holds the tail. HOPO/forced/tap/star-power flags are dropped;
  chords are capped at 2 notes.
- No automatic onset-latency/offset reconciliation beyond `song.ini`/`.chart`
  offset — use the in-game calibration if timing feels off.

The rest of this document is the original spec, kept for reference.

## A Clone Hero song folder

```
song-folder/
  song.ini        # metadata
  notes.chart     # text chart format  (OR)
  notes.mid       # Standard MIDI File chart
  song.ogg        # audio (may be split: guitar.ogg, drums.ogg, ...)
  album.png       # optional art
```

## Conversion target

Everything converts to our internal `RhythmChart` (see `src/game/types.ts`).

## Parsing tasks

### `song.ini` → `CloneHeroSongMetadata`
INI-style `key = value` lines. Relevant keys: `name`, `artist`, `charter`,
`year`, `delay`/`offset`. Map `delay`/`offset` to `RhythmChart.offsetMs`.

### `notes.chart` → `RhythmChart`
The `.chart` format is sectioned text:
- `[Song]` — resolution (ticks per beat), offset.
- `[SyncTrack]` — `B`(PM) and `TS` (time signature) events on a tick timeline.
- `[ExpertSingle]` / `[HardSingle]` / ... — note events:
  `tick = N fret length`, where fret 0–4 are the colored frets (5 = forced,
  6 = tap, 7 = open).

Steps:
1. Parse resolution + tempo map from `[SyncTrack]`.
2. Convert each note's tick → ms using the tempo map (handle tempo changes).
3. Map frets 0–4 → lanes 0–4. Drop/forced flags and open notes need a policy
   (e.g. open note → a default lane or a special marker — TBD).
4. Emit `ChartNote[]` for the selected difficulty section.

### `notes.mid` → `RhythmChart`
Parse the SMF. Guitar notes live on specific MIDI note numbers per difficulty
(e.g. Expert green = 96). Convert ticks → ms via the tempo track; map note
numbers → lanes. (A small MIDI parser or a dependency like `@tonejs/midi`.)

## Touchscreen adaptation

Because v1 is **tap-only**, when importing:
- Convert sustains to taps (or keep `durationMs` but ignore it for scoring).
- Optionally thin extremely dense Expert charts so they stay playable by finger.
- Star power / HOPO / forced-strum flags are dropped for now.

## File intake

- Accept a `.zip`; unzip in-browser (e.g. with a zip library) or on the server.
- Locate `song.ini` + a chart file + an audio file, parse, build `RhythmChart`,
  and create an object URL for the audio (same hand-off as the upload flow).

## Status

Implemented for `.sng`, `.zip`, `.chart`, and `.mid` via
`src/game/cloneHeroParser.ts`, `src/game/sngParser.ts`, and
`src/lib/cloneHeroClient.ts`. Remaining work: multi-stem audio mixing,
sustain/HOPO modeling, and smarter difficulty thinning for very dense Expert
charts on touch.
