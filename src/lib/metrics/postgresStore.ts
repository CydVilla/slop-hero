/**
 * Postgres-backed metrics persistence.
 *
 * Node runtime only — imported by store.ts when DATABASE_URL is set.
 */

import type { PlaySessionEvent } from "./types";
import { METRICS_MAX_EVENTS } from "./types";
import {
  asBoolean,
  asNumber,
  asString,
  ensureSchema,
  getPool,
  type PlaySessionRow,
} from "./db";

/** Cap how many events we keep in memory when reading, newest kept. */
const MAX_EVENTS = METRICS_MAX_EVENTS;

let warnedWriteFailure = false;

export function isPostgresPersistenceHealthy(): boolean {
  return !warnedWriteFailure;
}

export async function appendEventPostgres(
  event: PlaySessionEvent,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO play_sessions (
        id, client_id, schema_version, chart_id, title, artist, difficulty, source,
        bpm, total_notes, score, max_combo, accuracy, perfect, great, good, miss,
        calibration_offset_ms, completed, duration_ms, finished_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21
      ) ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.clientId,
        event.schemaVersion,
        event.chartId,
        event.title,
        event.artist ?? null,
        event.difficulty,
        event.source,
        event.bpm ?? null,
        event.totalNotes,
        event.score,
        event.maxCombo,
        event.accuracy,
        event.perfect,
        event.great,
        event.good,
        event.miss,
        event.calibrationOffsetMs,
        event.completed,
        event.durationMs,
        event.finishedAt,
      ],
    );
    return true;
  } catch (err) {
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      console.warn(
        "[metrics] Could not persist events to Postgres. " +
          "Server-wide metrics disabled; per-device dashboards still work.",
        err,
      );
    }
    return false;
  }
}

export async function readEventsPostgres(): Promise<PlaySessionEvent[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    await ensureSchema();
    const result = await pool.query<PlaySessionRow>(
      `SELECT
        id, client_id, schema_version, chart_id, title, artist, difficulty, source,
        bpm, total_notes, score, max_combo, accuracy, perfect, great, good, miss,
        calibration_offset_ms, completed, duration_ms, finished_at
      FROM play_sessions
      ORDER BY finished_at DESC
      LIMIT $1`,
      [MAX_EVENTS],
    );

    const events: PlaySessionEvent[] = [];
    for (const row of result.rows) {
      const mapped = rowToEvent(row);
      if (mapped) events.push(mapped);
    }

    // Aggregator expects chronological order (oldest first), matching file store.
    return events.reverse();
  } catch (err) {
    console.warn("[metrics] Could not read events from Postgres.", err);
    return [];
  }
}

function rowToEvent(row: PlaySessionRow): PlaySessionEvent | null {
  const id = asString(row.id);
  const clientId = asString(row.client_id);
  const chartId = asString(row.chart_id);
  const title = asString(row.title);
  const difficulty = asString(row.difficulty);
  const source = asString(row.source);
  const totalNotes = asNumber(row.total_notes);
  const accuracy = asNumber(row.accuracy);

  if (
    !id ||
    !clientId ||
    !chartId ||
    !title ||
    !difficulty ||
    !source ||
    totalNotes === undefined ||
    accuracy === undefined
  ) {
    return null;
  }

  const schemaVersion = asNumber(row.schema_version) ?? 1;
  const score = asNumber(row.score) ?? 0;
  const maxCombo = asNumber(row.max_combo) ?? 0;
  const perfect = asNumber(row.perfect) ?? 0;
  const great = asNumber(row.great) ?? 0;
  const good = asNumber(row.good) ?? 0;
  const miss = asNumber(row.miss) ?? 0;
  const calibrationOffsetMs = asNumber(row.calibration_offset_ms) ?? 0;
  const durationMs = asNumber(row.duration_ms) ?? 0;

  const finishedAtRaw = row.finished_at;
  const finishedAt =
    finishedAtRaw instanceof Date
      ? finishedAtRaw.toISOString()
      : asString(finishedAtRaw) ?? new Date().toISOString();

  const artist = asString(row.artist);
  const bpm = asNumber(row.bpm);

  return {
    id,
    clientId,
    schemaVersion,
    chartId,
    title,
    artist: artist ?? undefined,
    difficulty: difficulty as PlaySessionEvent["difficulty"],
    source: source as PlaySessionEvent["source"],
    bpm: bpm ?? undefined,
    totalNotes,
    score,
    maxCombo,
    accuracy,
    perfect,
    great,
    good,
    miss,
    calibrationOffsetMs,
    completed: asBoolean(row.completed),
    durationMs,
    finishedAt,
  };
}
