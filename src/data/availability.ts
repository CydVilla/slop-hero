/**
 * Track availability.
 *
 * Like `src/game/tuning.json`, `unavailableTracks.json` is a tiny, validated,
 * MACHINE-WRITABLE surface: the scheduled catalog audit
 * (`scripts/audit-catalog.mjs`, run by `.github/workflows/catalog-audit.yml`)
 * rewrites it when a track's external dependency rots — a YouTube video that
 * was deleted/privated/blocked from embedding, or a bundled audio file that
 * went missing. The catalog filters these tracks out at runtime, so merging the
 * audit's PR immediately stops players from landing on a broken song.
 *
 * The audit also removes entries when a track recovers, so the list is
 * self-healing in both directions. Humans normally never edit the file, but a
 * hand-added entry works fine as a "force-hide" switch.
 */

import unavailableData from "./unavailableTracks.json";

/** Why the audit hid a track. Kept broad so new checks don't break parsing. */
export type UnavailableReason =
  | "youtube-unavailable"
  | "youtube-not-embeddable"
  | "missing-audio-file"
  | string;

export interface UnavailableTrack {
  /** CatalogTrack.id of the hidden track. */
  trackId: string;
  reason: UnavailableReason;
  /** Human-readable detail from the audit (status code, path, …). */
  detail?: string;
  /** ISO date (YYYY-MM-DD) the audit first flagged the track. */
  since?: string;
}

interface UnavailableFile {
  version: number;
  updatedAt: string;
  notes?: string;
  tracks: UnavailableTrack[];
}

const FILE = unavailableData as UnavailableFile;

/**
 * The set of track ids the audit has flagged. Defensive about shape: a
 * malformed machine-written file should degrade to "hide nothing", never crash
 * the catalog.
 */
export function unavailableTrackIds(
  file: Pick<UnavailableFile, "tracks"> = FILE,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (Array.isArray(file.tracks)) {
    for (const entry of file.tracks) {
      if (entry && typeof entry.trackId === "string" && entry.trackId) {
        ids.add(entry.trackId);
      }
    }
  }
  return ids;
}

/**
 * Filter a track list down to the playable ones. Pure so it can be unit-tested
 * with arbitrary lists and id sets; `tracks.ts` applies it to the built-ins.
 */
export function filterAvailable<T extends { id: string }>(
  tracks: readonly T[],
  unavailableIds: ReadonlySet<string> = unavailableTrackIds(),
): T[] {
  if (unavailableIds.size === 0) return [...tracks];
  return tracks.filter((t) => !unavailableIds.has(t.id));
}
