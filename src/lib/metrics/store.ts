/**
 * Server-side metrics store.
 *
 * Automatically selects a backend:
 * - `DATABASE_URL` set → Heroku Postgres (durable, shared across dynos)
 * - otherwise → JSON Lines file under `.data/metrics.jsonl` (local dev)
 *
 * Writes fail softly everywhere: telemetry must never crash the app.
 *
 * Node runtime only — imported exclusively by API route handlers.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { isPostgresConfigured } from "./db";
import {
  appendEventPostgres,
  isPostgresPersistenceHealthy,
  readEventsPostgres,
} from "./postgresStore";
import { METRICS_SCHEMA_VERSION, METRICS_MAX_EVENTS, type PlaySessionEvent } from "./types";

/** Absolute path to the JSONL store. Override with the METRICS_FILE env var. */
function storePath(): string {
  const fromEnv = process.env.METRICS_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return path.join(process.cwd(), ".data", "metrics.jsonl");
}

/** Cap how many events we keep in memory when reading, newest kept. */
const MAX_EVENTS = METRICS_MAX_EVENTS;

let warnedWriteFailure = false;

export async function appendEvent(event: PlaySessionEvent): Promise<boolean> {
  if (isPostgresConfigured()) {
    return appendEventPostgres(event);
  }
  return appendEventFile(event);
}

export async function readEvents(): Promise<PlaySessionEvent[]> {
  if (isPostgresConfigured()) {
    return readEventsPostgres();
  }
  return readEventsFile();
}

/** Whether server persistence appears to be available (best-effort). */
export function isPersistenceConfigured(): boolean {
  if (isPostgresConfigured()) {
    return isPostgresPersistenceHealthy();
  }
  return !warnedWriteFailure;
}

async function appendEventFile(event: PlaySessionEvent): Promise<boolean> {
  const file = storePath();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
    return true;
  } catch (err) {
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      console.warn(
        `[metrics] Could not persist events to ${file} (filesystem may be read-only). ` +
          `Server-wide metrics disabled; per-device dashboards still work.`,
        err,
      );
    }
    return false;
  }
}

async function readEventsFile(): Promise<PlaySessionEvent[]> {
  const file = storePath();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    // Missing file (nothing recorded yet) or unreadable: treat as empty.
    return [];
  }

  const events: PlaySessionEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PlaySessionEvent;
      if (isValidEvent(parsed)) {
        events.push(parsed);
        if (events.length > MAX_EVENTS) events.shift();
      }
    } catch {
      // Skip malformed lines rather than failing the whole read.
    }
  }

  return events;
}

const DIFFICULTIES = new Set(["easy", "medium", "hard", "expert"]);

/**
 * Validate and coerce an incoming event to a stored `PlaySessionEvent`. Returns
 * null for anything that doesn't look like a real session, so untrusted POST
 * bodies can't poison the aggregates.
 */
export function sanitizeEvent(
  input: unknown,
  clientId: string,
): PlaySessionEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;

  const num = (v: unknown, min = -Infinity, max = Infinity): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
  };
  const str = (v: unknown, max = 200): string | null =>
    typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

  const difficulty = typeof o.difficulty === "string" ? o.difficulty : "";
  if (!DIFFICULTIES.has(difficulty)) return null;

  const totalNotes = num(o.totalNotes, 0, 100_000);
  const accuracy = num(o.accuracy, 0, 100);
  if (totalNotes === null || accuracy === null) return null;

  const title = str(o.title) ?? "Untitled";
  const chartId = str(o.chartId, 120) ?? "unknown";
  const source =
    o.source === "built-in" ||
    o.source === "session" ||
    o.source === "youtube"
      ? o.source
      : "unknown";

  return {
    id: str(o.id, 80) ?? cryptoRandomId(),
    clientId,
    schemaVersion: METRICS_SCHEMA_VERSION,
    chartId,
    title,
    artist: str(o.artist) ?? undefined,
    difficulty: difficulty as PlaySessionEvent["difficulty"],
    source,
    bpm: num(o.bpm, 0, 1000) ?? undefined,
    totalNotes,
    score: num(o.score, 0) ?? 0,
    maxCombo: num(o.maxCombo, 0) ?? 0,
    accuracy,
    perfect: num(o.perfect, 0) ?? 0,
    great: num(o.great, 0) ?? 0,
    good: num(o.good, 0) ?? 0,
    miss: num(o.miss, 0) ?? 0,
    calibrationOffsetMs: num(o.calibrationOffsetMs, -1000, 1000) ?? 0,
    completed: Boolean(o.completed),
    durationMs: num(o.durationMs, 0) ?? 0,
    finishedAt: str(o.finishedAt, 40) ?? new Date().toISOString(),
  };
}

function isValidEvent(e: unknown): e is PlaySessionEvent {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.chartId === "string" &&
    typeof o.difficulty === "string" &&
    typeof o.accuracy === "number" &&
    typeof o.totalNotes === "number"
  );
}

function cryptoRandomId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
