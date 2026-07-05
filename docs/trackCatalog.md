# Track Catalog

The catalog is the open-source song library, defined in `src/data/tracks.ts` and
surfaced at the `/catalog` route. It powers:

- the landing page **"Play random track"** button,
- the **/catalog** browse page (with contributor attribution),
- the **/play** fallback when no song was explicitly chosen.

## Why no audio?

We do **not** host copyrighted audio. Built-in tracks therefore ship **without**
an `audioUrl` and play in **silent/demo mode** — the chart scrolls on the
internal audio clock so the gameplay is identical, just without sound. Users can
still upload their own audio at `/upload`, which is added to the catalog for the
current browser session only (in-memory; lost on reload, since the audio is a
session-scoped `blob:` URL).

## Data model

```ts
export interface CatalogTrack {
  id: string;            // unique, kebab-case
  title: string;
  artist: string;
  contributor: string;   // shown publicly as "added by …"
  contributorUrl?: string;
  difficulty: Difficulty;        // "easy" | "medium" | "hard" | "expert"
  bpm: number;
  durationSeconds: number;
  addedAt: string;       // YYYY-MM-DD
  source: "built-in" | "session";
  audioUrl?: string;     // omit for built-in (silent/demo) tracks
  build: () => RhythmChart;  // lazily construct the playable chart
}
```

## Adding a built-in track

### Option A — generated chart (easiest)

Use the `autoTrack` helper, which builds the chart from the deterministic
automapper:

```ts
autoTrack({
  id: "neon-drift",
  title: "Neon Drift",
  artist: "Generated",
  contributor: "your-handle",
  contributorUrl: "https://github.com/your-handle",
  difficulty: "hard",
  bpm: 140,
  durationSeconds: 95,
  addedAt: "2026-06-24",
}),
```

### Option B — hand-authored chart

Provide a full `CatalogTrack` with a custom `build()` returning a `RhythmChart`.
See `createDemoChart()` in `src/game/demoChart.ts` for a pattern that composes
small reusable phrases. Keep it playable on a touchscreen:

- avoid rapid same-lane repeats,
- cap simultaneous notes at 2,
- scale density to the stated difficulty.

## Runtime API (for contributors touching code)

`src/data/tracks.ts` exports:

- `getCatalog()` — session uploads first, then built-ins.
- `getTrackById(id)`
- `pickRandomTrack()`
- `addSessionTrack(track)` — used by the upload flow.
- `trackToActiveSong(track)` — converts to the `/play` hand-off shape.
- `trackNoteCount(track)` / `trackDurationSeconds(track)` — UI helpers.

## Automated rot audit

CI proves the code builds; it cannot prove the catalog is still **playable** — a
track's YouTube video can be deleted/privated/blocked from embedding, and a
bundled audio file can go missing, without any commit. A scheduled workflow
(`.github/workflows/catalog-audit.yml`, weekly, also runnable via
`npm run audit:catalog`) probes every external dependency of the built-in list:

- `audioUrl` → the file must exist under `/public`,
- `youtubeId` → YouTube's oEmbed endpoint must know the video **and** allow
  embedding (the game plays via the IFrame API).

Definitive failures land in `src/data/unavailableTracks.json` (machine-written,
like `src/game/tuning.json`), which the catalog filters against at runtime —
flagged tracks disappear from `/catalog` and the random pick until an audit sees
them recover. When the flagged set changes, the workflow opens a PR (with a
per-track report in `docs/catalog/audit-report.md`) for normal human review;
inconclusive checks (network blips, rate limits) never change state.

## Future

When real server-side analysis lands (see `aiChartGenerationPlan.md`), generated
tracks can be replaced by analyzed charts without changing this data model — the
`build()` function just sources a better `RhythmChart`.
