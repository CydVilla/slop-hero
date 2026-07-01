/**
 * Shared Postgres pool for the metrics store.
 *
 * Node runtime only — never import from client components.
 */

import { Pool, type PoolConfig, type QueryResultRow } from "pg";

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function connectionString(): string | undefined {
  const url = process.env.DATABASE_URL;
  return url && url.trim().length > 0 ? url.trim() : undefined;
}

function sslFor(url: string): PoolConfig["ssl"] {
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  return isLocal ? undefined : { rejectUnauthorized: false };
}

export function isPostgresConfigured(): boolean {
  return connectionString() !== undefined;
}

export function getPool(): Pool | null {
  const url = connectionString();
  if (!url) return null;

  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: 10,
    });
  }
  return pool;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS play_sessions (
  id text primary key,
  client_id text not null,
  schema_version int not null,
  chart_id text not null,
  title text not null,
  artist text,
  difficulty text not null,
  source text not null,
  bpm double precision,
  total_notes int not null,
  score bigint not null,
  max_combo int not null,
  accuracy double precision not null,
  perfect int not null,
  great int not null,
  good int not null,
  miss int not null,
  calibration_offset_ms int not null,
  completed boolean not null,
  duration_ms int not null,
  finished_at timestamptz not null,
  created_at timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS play_sessions_finished_at_idx ON play_sessions (finished_at);
CREATE INDEX IF NOT EXISTS play_sessions_chart_id_idx ON play_sessions (chart_id);
`;

export async function ensureSchema(): Promise<void> {
  const p = getPool();
  if (!p) return;

  if (!schemaReady) {
    schemaReady = p.query(CREATE_TABLE).then(() => undefined);
  }
  await schemaReady;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asBoolean(value: unknown): boolean {
  return value === true || value === "t" || value === 1;
}

export type PlaySessionRow = QueryResultRow & {
  id: string;
  client_id: string;
  schema_version: number;
  chart_id: string;
  title: string;
  artist: string | null;
  difficulty: string;
  source: string;
  bpm: number | null;
  total_notes: number;
  score: string | number;
  max_combo: number;
  accuracy: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  calibration_offset_ms: number;
  completed: boolean;
  duration_ms: number;
  finished_at: Date | string;
};
