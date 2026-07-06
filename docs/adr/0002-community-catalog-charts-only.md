# 0002 — Community catalog shares charts, never audio

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

With Postgres attached (Neon via Vercel, `DATABASE_URL`), users can finally
share their custom-made songs with everyone — the shared catalog previously
contained only the royalty-free tracks committed to the repo. The question is
what exactly gets shared.

Constraints:

- **Copyright.** Most uploads are commercial music. Hosting or redistributing
  those files is not an option (the repo's standing rule for `/public/tracks`
  applies even more strongly to a server we operate). YouTube playback is
  different: the video streams from YouTube's own embed under its licensing,
  and we only store the video id.
- **Size.** Audio is 3–10 MB+ per song; the Neon tier is small. A chart is
  JSON — a few KB to a few hundred KB, bounded.
- **Abuse surface.** Anything user-submitted that the server stores and other
  clients download must be validated; arbitrary binary blobs are much harder
  to sanitize than a typed note list.

## Decision

The community catalog (`community_charts` table, `/api/charts`) stores **chart
data only**: title/artist/contributor metadata, difficulty, BPM, duration, an
optional **YouTube video id**, and the note list as `jsonb`. Audio files are
never accepted, transmitted, or stored.

Playback for community entries: with a YouTube id, the song plays through the
existing embedded-player engine; without one, it plays in the existing silent
mode (labeled "chart only" in the catalog).

Every submission is rebuilt server-side by a pure sanitizer
(`src/lib/community/sanitizeChart.ts`, unit-tested) that clamps counts, times,
lanes, text lengths, and body size — nothing from the request object is stored
as-is. This mirrors the metrics ingestion design (`sanitizeEvent`).

There is no authentication (the app has no accounts, by design); contributor
credit is a free-text name, and the note cap plus body-size cap bound each
row. Moderation/deletion is manual (SQL) for now — acceptable at the current
scale, revisit if the catalog grows.

## Consequences

- Users can publish and everyone can play their charts — with music whenever
  the chart is YouTube-backed, silently otherwise.
- We never hold copyrighted audio, and a database row costs KBs, not MBs.
- A chart made against an uploaded audio file plays silently for others; the
  editor says so before publishing. A future improvement could prompt for a
  matching YouTube link at publish time.
- No accounts means no edit/delete-your-own-chart flow yet; that would come
  with whatever identity approach a future ADR picks.
