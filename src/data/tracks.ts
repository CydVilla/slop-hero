/**
 * Track catalog.
 *
 * This is the open-source "song library". Contributors add new playable tracks
 * by appending an entry to `builtInTracks` below (see CONTRIBUTING.md and
 * docs/trackCatalog.md). Because we do not host copyrighted audio, built-in
 * tracks ship WITHOUT audio and play in silent/demo mode — the chart scrolls on
 * the internal clock. A track may optionally carry an `audioUrl` (e.g. a
 * user-uploaded blob URL added at runtime).
 *
 * Each track exposes a `build()` that returns the internal RhythmChart. Built-in
 * tracks build their chart lazily (via the demo chart or the deterministic
 * automapper) so we don't hold dozens of charts in memory up front.
 */

import { generateAutoChart } from "@/game/autoMapper";
import { chartDurationMs } from "@/game/chartUtils";
import { createDemoChart } from "@/game/demoChart";
import type { Difficulty, RhythmChart } from "@/game/types";
import type { ActiveSong } from "@/lib/activeSong";

export type TrackSource = "built-in" | "session";

export interface CatalogTrack {
  id: string;
  title: string;
  artist: string;
  /** Who added this track (name or GitHub handle). Shown in the catalog. */
  contributor: string;
  contributorUrl?: string;
  difficulty: Difficulty;
  bpm: number;
  durationSeconds: number;
  /** ISO date (YYYY-MM-DD) the track was added/updated. */
  addedAt: string;
  source: TrackSource;
  /** Optional playable audio. Undefined => silent/demo mode. */
  audioUrl?: string;
  /** Lazily construct the playable chart. */
  build: () => RhythmChart;
}

/** Metadata for an auto-generated built-in track (no hand-authored chart). */
type AutoTrackMeta = Omit<CatalogTrack, "source" | "build" | "audioUrl">;

function autoTrack(meta: AutoTrackMeta): CatalogTrack {
  return {
    ...meta,
    source: "built-in",
    build: () =>
      generateAutoChart({
        durationSeconds: meta.durationSeconds,
        difficulty: meta.difficulty,
        bpm: meta.bpm,
        title: meta.title,
        artist: meta.artist,
      }),
  };
}

/**
 * The curated, open-source track list. Add new tracks here via a PR.
 * Keep them silent/demo (no audioUrl) unless you have the rights to host audio.
 */
const builtInTracks: CatalogTrack[] = [
  {
    id: "highway-demo",
    title: "Highway Demo",
    artist: "Slop Hero",
    contributor: "Slop Hero Team",
    contributorUrl: "https://github.com/",
    difficulty: "medium",
    bpm: 120,
    durationSeconds: 22,
    addedAt: "2026-06-24",
    source: "built-in",
    build: () => createDemoChart(),
  },
  autoTrack({
    id: "first-lap",
    title: "First Lap",
    artist: "Generated",
    contributor: "Slop Hero Team",
    difficulty: "easy",
    bpm: 100,
    durationSeconds: 60,
    addedAt: "2026-06-24",
  }),
  autoTrack({
    id: "midnight-grid",
    title: "Midnight Grid",
    artist: "Generated",
    contributor: "Slop Hero Team",
    difficulty: "medium",
    bpm: 124,
    durationSeconds: 80,
    addedAt: "2026-06-24",
  }),
  autoTrack({
    id: "neon-drift",
    title: "Neon Drift",
    artist: "Generated",
    contributor: "Slop Hero Team",
    difficulty: "hard",
    bpm: 140,
    durationSeconds: 95,
    addedAt: "2026-06-24",
  }),
  autoTrack({
    id: "solar-flare",
    title: "Solar Flare",
    artist: "Generated",
    contributor: "Slop Hero Team",
    difficulty: "expert",
    bpm: 160,
    durationSeconds: 70,
    addedAt: "2026-06-24",
  }),
];

/**
 * Tracks the user uploaded during this browser session. In-memory only: they
 * are lost on reload because their audio is a session-scoped blob URL.
 */
let sessionTracks: CatalogTrack[] = [];

export function addSessionTrack(track: CatalogTrack): void {
  // Newest first; de-dupe by id.
  sessionTracks = [track, ...sessionTracks.filter((t) => t.id !== track.id)];
}

export function getSessionTracks(): readonly CatalogTrack[] {
  return sessionTracks;
}

/** The full catalog: session uploads first, then the built-in library. */
export function getCatalog(): CatalogTrack[] {
  return [...sessionTracks, ...builtInTracks];
}

export function getTrackById(id: string): CatalogTrack | undefined {
  return getCatalog().find((t) => t.id === id);
}

/** Pick a random track for the "Play" button. */
export function pickRandomTrack(): CatalogTrack {
  const catalog = getCatalog();
  const index = Math.floor(Math.random() * catalog.length);
  // catalog always has the built-in tracks, so index is always valid.
  return catalog[index] ?? catalog[0]!;
}

/** Convert a catalog track into the active-song hand-off shape for /play. */
export function trackToActiveSong(track: CatalogTrack): ActiveSong {
  return {
    chart: track.build(),
    audioUrl: track.audioUrl,
    title: track.title,
    subtitle: `${track.artist} · added by ${track.contributor}`,
  };
}

/** Note count without keeping the chart around (used by the catalog UI). */
export function trackNoteCount(track: CatalogTrack): number {
  return track.build().notes.length;
}

/** Duration helper kept here so callers don't import chartUtils directly. */
export function trackDurationSeconds(track: CatalogTrack): number {
  if (track.durationSeconds) return track.durationSeconds;
  return Math.round(chartDurationMs(track.build()) / 1000);
}
