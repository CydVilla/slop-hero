/**
 * Server-side store for the community chart catalog.
 *
 * Reuses the shared Postgres pool (src/lib/metrics/db.ts — the Neon database
 * attached to the Vercel project). Charts are rows of metadata + a jsonb notes
 * payload; audio is never stored (docs/adr/0002-community-catalog-charts-only.md).
 *
 * Node runtime only — imported exclusively by API route handlers.
 */

import { getPool, isPostgresConfigured } from "@/lib/metrics/db";
import type { CommunitySubmission } from "@/lib/community/sanitizeChart";
import type { RhythmChart } from "@/game/types";

/** A stored community chart, as returned to clients. */
export interface CommunityChartRecord {
  id: string;
  title: string;
  artist?: string;
  contributor: string;
  difficulty: CommunitySubmission["difficulty"];
  bpm?: number;
  durationSeconds: number;
  youtubeId?: string;
  noteCount: number;
  createdAt: string;
  /** Present only when fetching a single chart (not in list responses). */
  chart?: RhythmChart;
}

/** Newest-first page size for the catalog listing. */
export const COMMUNITY_LIST_LIMIT = 100;

export function isCommunityConfigured(): boolean {
  return isPostgresConfigured();
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS community_charts (
  id text primary key,
  title text not null,
  artist text,
  contributor text not null,
  difficulty text not null,
  bpm double precision,
  duration_seconds int not null,
  youtube_id text,
  note_count int not null,
  chart jsonb not null,
  created_at timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS community_charts_created_at_idx
  ON community_charts (created_at DESC);
`;

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  if (!schemaReady) {
    schemaReady = pool.query(CREATE_TABLE).then(() => undefined);
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  await schemaReady;
}

interface Row {
  id: string;
  title: string;
  artist: string | null;
  contributor: string;
  difficulty: string;
  bpm: number | null;
  duration_seconds: number;
  youtube_id: string | null;
  note_count: number;
  created_at: Date;
  chart?: RhythmChart;
}

function rowToRecord(row: Row): CommunityChartRecord {
  const record: CommunityChartRecord = {
    id: row.id,
    title: row.title,
    artist: row.artist ?? undefined,
    contributor: row.contributor,
    difficulty: row.difficulty as CommunityChartRecord["difficulty"],
    bpm: row.bpm ?? undefined,
    durationSeconds: row.duration_seconds,
    youtubeId: row.youtube_id ?? undefined,
    noteCount: row.note_count,
    createdAt: row.created_at.toISOString(),
  };
  if (row.chart) {
    // The chart's id mirrors the row id so play sessions attribute correctly.
    record.chart = { ...row.chart, id: row.id };
  }
  return record;
}

/** Insert a sanitized submission; returns the new record's id. */
export async function insertCommunityChart(
  submission: CommunitySubmission,
): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  await ensureSchema();

  const id = `community-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO community_charts
      (id, title, artist, contributor, difficulty, bpm, duration_seconds,
       youtube_id, note_count, chart)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      submission.title,
      submission.artist ?? null,
      submission.contributor,
      submission.difficulty,
      submission.bpm ?? null,
      submission.durationSeconds,
      submission.youtubeId ?? null,
      submission.chart.notes.length,
      JSON.stringify(submission.chart),
    ],
  );
  return id;
}

/** Newest community charts, metadata only (no note payloads). */
export async function listCommunityCharts(): Promise<CommunityChartRecord[]> {
  const pool = getPool();
  if (!pool) return [];
  await ensureSchema();

  const res = await pool.query<Row>(
    `SELECT id, title, artist, contributor, difficulty, bpm, duration_seconds,
            youtube_id, note_count, created_at
     FROM community_charts
     ORDER BY created_at DESC
     LIMIT $1`,
    [COMMUNITY_LIST_LIMIT],
  );
  return res.rows.map(rowToRecord);
}

/** One community chart including its full note payload. */
export async function getCommunityChart(
  id: string,
): Promise<CommunityChartRecord | null> {
  const pool = getPool();
  if (!pool) return null;
  await ensureSchema();

  const res = await pool.query<Row>(
    `SELECT id, title, artist, contributor, difficulty, bpm, duration_seconds,
            youtube_id, note_count, created_at, chart
     FROM community_charts
     WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}
