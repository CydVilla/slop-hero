/**
 * Validation for community chart submissions.
 *
 * Pure and framework-free (no React, no Node) so the same rules run in unit
 * tests and in the API route. Follows the metrics-store philosophy: untrusted
 * POST bodies are clamped and shape-checked so junk can't poison the shared
 * catalog (src/lib/metrics/store.ts sanitizeEvent is the sibling of this).
 *
 * The community catalog stores chart DATA only — notes, timing, metadata, and
 * an optional YouTube video id. Audio files are never accepted; see
 * docs/adr/0002-community-catalog-charts-only.md for why.
 */

import type { ChartNote, Difficulty, Lane, RhythmChart } from "@/game/types";

export const COMMUNITY_MAX_NOTES = 5000;
export const COMMUNITY_MIN_NOTES = 4;
/** 15 minutes — longer than any sane song, short enough to bound storage. */
export const COMMUNITY_MAX_TIME_MS = 15 * 60_000;
/** Longest single sustain we accept. */
export const COMMUNITY_MAX_HOLD_MS = 30_000;

const DIFFICULTIES = new Set(["easy", "medium", "hard", "expert"]);
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LANE_COUNT = 5;

/** What a client submits to POST /api/charts. */
export interface CommunitySubmission {
  title: string;
  artist?: string;
  contributor: string;
  difficulty: Difficulty;
  bpm?: number;
  durationSeconds: number;
  youtubeId?: string;
  chart: RhythmChart;
}

export type SanitizeResult =
  | { ok: true; value: CommunitySubmission }
  | { ok: false; error: string };

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

function num(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function sanitizeNote(input: unknown, index: number): ChartNote | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;

  const timeMs = num(o.timeMs, 0, COMMUNITY_MAX_TIME_MS);
  if (timeMs === undefined) return null;

  const laneRaw = typeof o.lane === "number" ? o.lane : Number(o.lane);
  if (!Number.isInteger(laneRaw) || laneRaw < 0 || laneRaw >= LANE_COUNT) {
    return null;
  }

  const durationMs = num(o.durationMs, 0, COMMUNITY_MAX_HOLD_MS);
  const isHold = durationMs !== undefined && durationMs > 0;

  return {
    // Server-assigned ids: deterministic, bounded, and impossible to spoof.
    id: `c_${index.toString(36)}`,
    timeMs: Math.round(timeMs),
    lane: laneRaw as Lane,
    durationMs: isHold ? Math.round(durationMs) : undefined,
    type: isHold ? "hold" : "tap",
  };
}

/**
 * Validate an untrusted submission body. Returns a fully rebuilt, clamped
 * value on success — nothing from the input object is passed through as-is.
 */
export function sanitizeCommunitySubmission(input: unknown): SanitizeResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const o = input as Record<string, unknown>;

  const title = str(o.title, 80);
  if (!title) return { ok: false, error: "A title is required." };

  const contributor = str(o.contributor, 40) ?? "Anonymous";
  const artist = str(o.artist, 80);

  const difficulty = typeof o.difficulty === "string" ? o.difficulty : "";
  if (!DIFFICULTIES.has(difficulty)) {
    return { ok: false, error: "Difficulty must be easy, medium, hard, or expert." };
  }

  const youtubeId = str(o.youtubeId, 20);
  if (youtubeId !== undefined && !YOUTUBE_ID_RE.test(youtubeId)) {
    return { ok: false, error: "That YouTube video id doesn't look right." };
  }

  const bpm = num(o.bpm, 40, 300);

  const chartInput = o.chart;
  if (typeof chartInput !== "object" || chartInput === null) {
    return { ok: false, error: "A chart is required." };
  }
  const chartObj = chartInput as Record<string, unknown>;
  const notesInput = chartObj.notes;
  if (!Array.isArray(notesInput)) {
    return { ok: false, error: "chart.notes must be an array." };
  }
  if (notesInput.length > COMMUNITY_MAX_NOTES) {
    return {
      ok: false,
      error: `Too many notes (max ${COMMUNITY_MAX_NOTES}).`,
    };
  }

  const notes: ChartNote[] = [];
  for (const [i, n] of notesInput.entries()) {
    const note = sanitizeNote(n, i);
    if (note) notes.push(note);
  }
  if (notes.length < COMMUNITY_MIN_NOTES) {
    return {
      ok: false,
      error: `A shareable chart needs at least ${COMMUNITY_MIN_NOTES} valid notes.`,
    };
  }
  notes.sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);

  const offsetMs = num(chartObj.offsetMs, -5000, 5000) ?? 0;

  let lastEndMs = 0;
  for (const n of notes) {
    lastEndMs = Math.max(lastEndMs, n.timeMs + (n.durationMs ?? 0));
  }
  const durationSeconds =
    num(o.durationSeconds, 1, COMMUNITY_MAX_TIME_MS / 1000) ??
    Math.max(1, Math.ceil(lastEndMs / 1000));

  const chart: RhythmChart = {
    id: "community", // replaced with the stored row id on read
    title,
    artist,
    bpm,
    offsetMs: Math.round(offsetMs),
    difficulty: difficulty as Difficulty,
    notes,
  };

  return {
    ok: true,
    value: {
      title,
      artist,
      contributor,
      difficulty: difficulty as Difficulty,
      bpm,
      durationSeconds: Math.round(durationSeconds),
      youtubeId,
      chart,
    },
  };
}
