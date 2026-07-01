/**
 * Track catalog.
 *
 * This is the open-source "song library". Contributors add new playable tracks
 * by appending an entry to `builtInTracks` below (see CONTRIBUTING.md and
 * docs/trackCatalog.md). The built-in tracks ship with royalty-free audio served
 * from /public/tracks, so the catalog is immediately playable WITH music. Their
 * charts are derived from the audio (onset analysis) at play time; the `build()`
 * here returns a quick BPM-grid chart that is used as an immediate fallback.
 *
 * A track may also carry a runtime `audioUrl` (a user-uploaded blob URL) or a
 * `youtubeId` (embedded YouTube video).
 */

import { generateAutoChart } from "@/game/autoMapper";
import { chartDurationMs } from "@/game/chartUtils";
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
  /** YouTube video id when the track plays from an embedded YouTube video. */
  youtubeId?: string;
  /** Lazily construct the playable chart. */
  build: () => RhythmChart;
}

/** Metadata for a built-in royalty-free audio track. */
type BuiltInMeta = Omit<CatalogTrack, "source" | "build">;

function builtInTrack(meta: BuiltInMeta): CatalogTrack {
  return {
    ...meta,
    source: "built-in",
    // Immediate grid fallback; /play upgrades this to an onset-matched chart.
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
 * The curated, open-source track list. These ship with royalty-free audio.
 * Add new tracks here via a PR (drop the audio in /public/tracks). Only add
 * audio you have the rights to host.
 */
const builtInTracks: CatalogTrack[] = [
  builtInTrack({
    id: "galactic-rap",
    title: "Galactic Rap",
    artist: "Royalty-free",
    contributor: "Slop Hero Team",
    difficulty: "medium",
    bpm: 90,
    durationSeconds: 142,
    addedAt: "2026-06-24",
    audioUrl: "/tracks/galactic-rap.mp3",
  }),
  builtInTrack({
    id: "mesmerizing-galaxy-loop",
    title: "Mesmerizing Galaxy Loop",
    artist: "Royalty-free",
    contributor: "Slop Hero Team",
    difficulty: "easy",
    bpm: 120,
    durationSeconds: 93,
    addedAt: "2026-06-24",
    audioUrl: "/tracks/mesmerizing-galaxy-loop.mp3",
  }),
  builtInTrack({
    id: "pleasant-porridge",
    title: "Pleasant Porridge",
    artist: "Royalty-free",
    contributor: "Slop Hero Team",
    difficulty: "hard",
    bpm: 110,
    durationSeconds: 171,
    addedAt: "2026-06-24",
    audioUrl: "/tracks/pleasant-porridge.mp3",
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
  // Built-in audio tracks ask /play to derive the chart from the audio so notes
  // match the music. Uploads were already analyzed, so they skip this.
  const analyze =
    track.source === "built-in" && track.audioUrl
      ? { difficulty: track.difficulty, bpmHint: track.bpm, artist: track.artist }
      : undefined;

  return {
    chart: track.build(),
    audioUrl: track.audioUrl,
    youtubeId: track.youtubeId,
    title: track.title,
    subtitle: `${track.artist} · added by ${track.contributor}`,
    meta: {
      trackId: track.id,
      source: track.youtubeId ? "youtube" : track.source,
      difficulty: track.difficulty,
      bpm: track.bpm,
      artist: track.artist,
    },
    analyze,
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
