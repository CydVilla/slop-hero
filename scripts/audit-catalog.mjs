#!/usr/bin/env node
/**
 * Scheduled catalog rot audit.
 *
 * CI can prove the code compiles, but it cannot prove the catalog is still
 * PLAYABLE: a track's YouTube video can be deleted, made private, or have
 * embedding disabled, and a bundled audio file can be moved without any commit
 * touching the code. This script checks every external dependency of the
 * built-in track list and maintains `src/data/unavailableTracks.json` — the
 * machine-writable list the app uses to hide broken tracks (mirroring how
 * `apply-tuning.mjs` owns `src/game/tuning.json`).
 *
 * Checks per track:
 *   - `audioUrl` starting with "/"  → the file must exist under /public.
 *   - `youtubeId`                   → YouTube's oEmbed endpoint must know the
 *     video AND allow embedding (the game plays via the IFrame API, so a
 *     non-embeddable video is just as broken as a deleted one).
 *
 * Failure discipline (avoid false-positive PRs):
 *   - Only DEFINITIVE bad answers (HTTP 400/404 → gone, 401/403 → not
 *     embeddable, missing file) flag a track, and only after a retry.
 *   - Network errors / 429 / 5xx are INCONCLUSIVE: the track keeps whatever
 *     state it already had, flagged or not.
 *   - A previously-flagged track that now checks out healthy is un-flagged
 *     (the list self-heals in both directions).
 *
 * The JSON and the report are only rewritten when the flagged set actually
 * changes, so the weekly workflow opens a PR exactly when something rotted or
 * recovered — never a noise PR. `changed=true|false` is emitted to
 * $GITHUB_OUTPUT for the workflow to gate on.
 *
 * Zero dependencies — Node 18+ (global fetch, fs/promises).
 */

import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TRACKS_PATH = path.join(ROOT, "src", "data", "tracks.ts");
const UNAVAILABLE_PATH = path.join(ROOT, "src", "data", "unavailableTracks.json");
const REPORT_PATH = path.join(ROOT, "docs", "catalog", "audit-report.md");

function log(msg) {
  console.log(`[catalog-audit] ${msg}`);
}

/** Today as YYYY-MM-DD; AUDIT_DATE overrides for reproducible runs/tests. */
function today() {
  const forced = process.env.AUDIT_DATE?.trim();
  if (forced) return forced;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Extract built-in track entries from tracks.ts without executing TypeScript.
 * Track object literals are flat and their `id`/`audioUrl`/`youtubeId` values
 * are always string literals (enforced by review), so slicing the source at
 * each `id:` and scanning the slice for the two URL fields is reliable. If the
 * file's shape ever changes enough to break this, the audit fails loudly in CI
 * rather than silently auditing nothing (see the sanity check in main()).
 */
export function extractTracks(source) {
  const tracks = [];
  const idRe = /\bid:\s*"([^"]+)"/g;
  const matches = [...source.matchAll(idRe)];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? source.length : source.length;
    const chunk = source.slice(start, end);
    const audioUrl = chunk.match(/\baudioUrl:\s*"([^"]+)"/)?.[1];
    const youtubeId = chunk.match(/\byoutubeId:\s*"([^"]+)"/)?.[1];
    tracks.push({ id: m[1], audioUrl, youtubeId });
  }
  return tracks;
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe a YouTube video via oEmbed (no API key needed).
 * Returns { verdict: "alive" | "unavailable" | "not-embeddable" | "inconclusive", detail }.
 */
async function checkYouTube(videoId, attempts = 2) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}&format=json`;

  let last = { verdict: "inconclusive", detail: "no attempt completed" };
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return { verdict: "alive", detail: `HTTP ${res.status}` };
      if (res.status === 400 || res.status === 404) {
        last = { verdict: "unavailable", detail: `oEmbed HTTP ${res.status}` };
        continue; // confirm on the retry before condemning
      }
      if (res.status === 401 || res.status === 403) {
        last = { verdict: "not-embeddable", detail: `oEmbed HTTP ${res.status}` };
        continue;
      }
      // 429 / 5xx / anything else: can't tell.
      return { verdict: "inconclusive", detail: `oEmbed HTTP ${res.status}` };
    } catch (err) {
      last = { verdict: "inconclusive", detail: `network error: ${err?.message ?? err}` };
    }
  }
  return last;
}

/** Audit one track → { status: "ok" | "bad" | "inconclusive", reason?, detail? }. */
async function auditTrack(track) {
  if (track.audioUrl?.startsWith("/")) {
    const abs = path.join(ROOT, "public", track.audioUrl);
    if (!(await fileExists(abs))) {
      return {
        status: "bad",
        reason: "missing-audio-file",
        detail: `public${track.audioUrl} not found`,
      };
    }
  }

  if (track.youtubeId) {
    const { verdict, detail } = await checkYouTube(track.youtubeId);
    if (verdict === "unavailable") {
      return { status: "bad", reason: "youtube-unavailable", detail };
    }
    if (verdict === "not-embeddable") {
      return { status: "bad", reason: "youtube-not-embeddable", detail };
    }
    if (verdict === "inconclusive") {
      return { status: "inconclusive", detail };
    }
  }

  return { status: "ok" };
}

function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    return writeFile(out, `${name}=${value}\n`, { flag: "a" });
  }
  log(`(output) ${name}=${value}`);
  return Promise.resolve();
}

function renderReport(date, results, flagged) {
  const lines = [
    "# Catalog audit report",
    "",
    `- **Date:** ${date}`,
    `- **Tracks checked:** ${results.length}`,
    `- **Flagged as unavailable:** ${flagged.length}`,
    "",
    "| Track | Result | Detail |",
    "| :--- | :--- | :--- |",
  ];
  for (const r of results) {
    const status =
      r.outcome.status === "ok"
        ? "✅ ok"
        : r.outcome.status === "bad"
          ? `❌ ${r.outcome.reason}`
          : "⚠️ inconclusive (state kept)";
    lines.push(`| \`${r.track.id}\` | ${status} | ${r.outcome.detail ?? ""} |`);
  }
  lines.push(
    "",
    "Flagged tracks are hidden from the catalog via `src/data/unavailableTracks.json`",
    "until a later audit sees them recover. Generated by `scripts/audit-catalog.mjs`.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const source = await readFile(TRACKS_PATH, "utf8");
  const tracks = extractTracks(source);
  // Sanity check: an empty extraction from a non-trivial file means the parser
  // and the file drifted apart — fail loudly instead of "auditing" nothing.
  if (tracks.length === 0) {
    throw new Error(`No tracks extracted from ${TRACKS_PATH}; extractor needs updating.`);
  }
  log(`Auditing ${tracks.length} built-in track(s)…`);

  const previous = JSON.parse(await readFile(UNAVAILABLE_PATH, "utf8"));
  const prevById = new Map((previous.tracks ?? []).map((t) => [t.trackId, t]));

  const date = today();
  const results = [];
  const nextFlags = new Map();

  for (const track of tracks) {
    const outcome = await auditTrack(track);
    results.push({ track, outcome });

    if (outcome.status === "bad") {
      const prev = prevById.get(track.id);
      nextFlags.set(track.id, {
        trackId: track.id,
        reason: outcome.reason,
        detail: outcome.detail,
        // Preserve the original flag date so an unchanged state stays
        // byte-identical and never produces a diff/PR.
        since: prev?.since ?? date,
      });
      log(`  ${track.id}: BAD (${outcome.reason} — ${outcome.detail})`);
    } else if (outcome.status === "inconclusive") {
      const prev = prevById.get(track.id);
      if (prev) nextFlags.set(track.id, prev); // keep prior state, don't heal on a shrug
      log(`  ${track.id}: inconclusive (${outcome.detail}) — keeping previous state`);
    } else {
      log(`  ${track.id}: ok`);
    }
  }

  const nextTracks = [...nextFlags.values()].sort((a, b) =>
    a.trackId.localeCompare(b.trackId),
  );
  const prevTracks = [...(previous.tracks ?? [])].sort((a, b) =>
    a.trackId.localeCompare(b.trackId),
  );
  const changed = JSON.stringify(nextTracks) !== JSON.stringify(prevTracks);

  if (changed) {
    const next = { ...previous, updatedAt: date, tracks: nextTracks };
    await writeFile(UNAVAILABLE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, renderReport(date, results, nextTracks));
    log(`Flag set changed → wrote ${path.relative(ROOT, UNAVAILABLE_PATH)} and report.`);
  } else {
    log("No change in the flagged set; nothing written.");
  }

  await setOutput("changed", changed ? "true" : "false");
}

// Allow `import { extractTracks }` without running the audit (future tests).
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[catalog-audit] FAILED: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
