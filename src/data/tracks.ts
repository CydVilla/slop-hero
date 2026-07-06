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

import { filterAvailable } from "@/data/availability";
import { generateAutoChart } from "@/game/autoMapper";
import { chartDurationMs } from "@/game/chartUtils";
import type { Difficulty, RhythmChart } from "@/game/types";
import type { ActiveSong } from "@/lib/activeSong";
import { listSongs, type StoredSong } from "@/lib/songLibrary";

/**
 * - "built-in": ships with the repo (royalty-free audio in /public/tracks).
 * - "session":  added this browser session; may hold a live blob: audio URL.
 * - "library":  restored from the device's persistent IndexedDB library.
 */
export type TrackSource = "built-in" | "session" | "library";

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
 * Tracks the user added during this browser session. Kept in memory for
 * instant catalog updates; the durable copy lives in the IndexedDB library
 * (src/lib/songLibrary.ts) and is merged in via refreshLibraryTracks().
 */
let sessionTracks: CatalogTrack[] = [];

export function addSessionTrack(track: CatalogTrack): void {
  // Newest first; de-dupe by id.
  sessionTracks = [track, ...sessionTracks.filter((t) => t.id !== track.id)];
}

export function getSessionTracks(): readonly CatalogTrack[] {
  return sessionTracks;
}

/**
 * Library tracks restored from IndexedDB. Refreshed on demand (catalog mount);
 * audio blobs get a fresh object URL each refresh, and the previous URLs are
 * revoked so repeated visits don't leak.
 */
let libraryTracks: CatalogTrack[] = [];
let libraryUrls: string[] = [];

/** Convert a persisted song into a catalog entry. */
function storedSongToTrack(song: StoredSong): CatalogTrack {
  let audioUrl: string | undefined;
  if (song.audio) {
    audioUrl = URL.createObjectURL(song.audio);
    libraryUrls.push(audioUrl);
  }
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    contributor: song.contributor,
    difficulty: song.difficulty,
    bpm: song.bpm,
    durationSeconds: song.durationSeconds,
    addedAt: song.addedAt,
    source: "library",
    audioUrl,
    youtubeId: song.youtubeId,
    build: () => song.chart,
  };
}

/**
 * Reload the persistent library into the in-memory catalog. Call from client
 * components (an effect) before reading getCatalog() when the saved songs
 * should be visible. Safe to call repeatedly.
 */
export async function refreshLibraryTracks(): Promise<readonly CatalogTrack[]> {
  const songs = await listSongs();
  for (const url of libraryUrls) URL.revokeObjectURL(url);
  libraryUrls = [];
  libraryTracks = songs.map(storedSongToTrack);
  return libraryTracks;
}

export function getLibraryTracks(): readonly CatalogTrack[] {
  return libraryTracks;
}

/**
 * Built-ins minus any the scheduled catalog audit has flagged as broken (dead
 * YouTube video, missing audio file — see src/data/availability.ts). Computed
 * once at module load; the underlying JSON only changes via audited PRs.
 * If the audit somehow flagged everything, fall back to the unfiltered list —
 * a possibly-broken track beats an empty catalog (pickRandomTrack assumes at
 * least one entry exists).
 */
const availableBuiltInTracks: CatalogTrack[] = ((): CatalogTrack[] => {
  const available = filterAvailable(builtInTracks);
  return available.length > 0 ? available : builtInTracks;
})();

/**
 * The full catalog: this session's additions first, then persisted library
 * songs (minus any already present this session — a fresh upload exists in
 * both), then the built-in library.
 */
export function getCatalog(): CatalogTrack[] {
  const sessionIds = new Set(sessionTracks.map((t) => t.id));
  const restored = libraryTracks.filter((t) => !sessionIds.has(t.id));
  return [...sessionTracks, ...restored, ...availableBuiltInTracks];
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
      // Metrics keep their original source vocabulary: user-added tracks
      // (session or restored library) both report "session".
      source: track.youtubeId
        ? "youtube"
        : track.source === "built-in"
          ? "built-in"
          : "session",
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
