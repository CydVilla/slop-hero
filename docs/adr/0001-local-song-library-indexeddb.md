# 0001 — Persist user songs locally in IndexedDB

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

Songs a player added (audio upload, Clone Hero import, YouTube pick) lived in
an in-memory module singleton (`sessionTracks` in `src/data/tracks.ts`) whose
audio was a `blob:` object URL. A hard reload lost everything, so players had
to re-upload or re-search for every play session.

Where should user songs persist?

1. **Server-side** (Postgres/blob storage): survives across devices, but
   uploads are potentially copyrighted audio we must not host or distribute
   (the repo's standing rule: only royalty-free audio in the shared catalog),
   files are large (3–10 MB+ per song) against a small Neon tier, and the app's
   privacy stance is local-first (see the metrics design).
2. **localStorage**: simple, but it stores strings only (base64 would balloon
   memory and hit the ~5 MB quota after one song).
3. **IndexedDB**: stores Blobs natively via structured clone, has large quotas
   (typically ≥ hundreds of MB), and is available in every target browser,
   including the Tesla browser.

## Decision

Persist user songs in **IndexedDB on the device** (`src/lib/songLibrary.ts`):
one `songs` object store holding catalog metadata, the `RhythmChart` JSON, an
optional YouTube video id, and the audio **Blob** itself. The catalog merges
these back in at load (`refreshLibraryTracks()` in `src/data/tracks.ts`) with a
fresh object URL per session. Every operation degrades to a no-op/empty result
when IndexedDB is unavailable (private browsing), reproducing the old
session-only behavior.

Uploaded audio never leaves the device. Sharing a chart with other players is
a separate explicit act with different rules — see ADR-0002.

## Consequences

- Players keep their songs across reloads with zero setup; "Remove" in the
  catalog deletes the stored copy.
- Library is per-browser-per-device by design: no accounts, nothing to leak.
  Clearing site data clears the library — acceptable and consistent with the
  metrics privacy stance.
- Object URLs must be created/revoked on each load (handled in
  `refreshLibraryTracks`); leaking them would pin Blobs in memory.
- Metrics vocabulary is unchanged: restored library tracks report the existing
  `"session"` source, so the analytics pipeline and its Postgres schema are
  untouched.
