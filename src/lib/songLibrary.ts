/**
 * Persistent, device-local song library (IndexedDB).
 *
 * Uploaded audio, Clone Hero imports, and YouTube picks used to live only in
 * an in-memory list (src/data/tracks.ts sessionTracks) and were lost on every
 * reload, forcing players to re-upload or re-search each session. This module
 * stores them durably in the browser:
 *
 *  - Audio is kept as a Blob (IndexedDB stores Blobs natively), so uploaded
 *    files and Clone Hero audio replay without re-picking the file.
 *  - YouTube tracks store just the video id + chart (tiny).
 *  - Charts are stored as plain RhythmChart JSON.
 *
 * Nothing here touches the network: the library is local-first and private,
 * mirroring the metrics design (see docs/adr/0001-local-song-library.md).
 * Sharing a chart with everyone is a separate, explicit act — see the
 * community catalog (src/lib/community/).
 *
 * Every function degrades gracefully when IndexedDB is unavailable (private
 * browsing, ancient webviews): reads resolve to empty, writes to no-ops.
 */

import type { Difficulty, RhythmChart } from "@/game/types";

const DB_NAME = "slop-hero";
const DB_VERSION = 1;
const STORE = "songs";

/** One saved song: catalog metadata + playable chart + optional audio blob. */
export interface StoredSong {
  id: string;
  title: string;
  artist: string;
  contributor: string;
  difficulty: Difficulty;
  bpm: number;
  durationSeconds: number;
  /** ISO date (YYYY-MM-DD) shown in the catalog. */
  addedAt: string;
  /** Epoch ms, used to sort the library newest-first. */
  savedAt: number;
  /** YouTube video id when the song plays from an embedded video. */
  youtubeId?: string;
  /** Uploaded / imported audio. Undefined for YouTube or silent charts. */
  audio?: Blob;
  chart: RhythmChart;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    // Let a later call retry after a failure instead of caching the rejection.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Persist (insert or replace) a song. Resolves false when storage is unavailable. */
export async function saveSong(song: StoredSong): Promise<boolean> {
  if (!idbAvailable()) return false;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    await requestToPromise(tx.objectStore(STORE).put(song));
    return true;
  } catch {
    return false;
  }
}

/** All saved songs, newest first. Empty when unavailable. */
export async function listSongs(): Promise<StoredSong[]> {
  if (!idbAvailable()) return [];
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const all = await requestToPromise(
      tx.objectStore(STORE).getAll() as IDBRequest<StoredSong[]>,
    );
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function getSong(id: string): Promise<StoredSong | undefined> {
  if (!idbAvailable()) return undefined;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const song = await requestToPromise(
      tx.objectStore(STORE).get(id) as IDBRequest<StoredSong | undefined>,
    );
    return song ?? undefined;
  } catch {
    return undefined;
  }
}

export async function deleteSong(id: string): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    await requestToPromise(tx.objectStore(STORE).delete(id));
  } catch {
    /* best-effort */
  }
}

/**
 * Recover the underlying Blob from a same-document object URL (blob:). Used to
 * persist uploaded audio without threading the File through every layer.
 */
export async function blobFromObjectUrl(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}
