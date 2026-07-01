/**
 * Analytics domain types.
 *
 * These describe the anonymous, gameplay-only telemetry that powers the metrics
 * dashboard and the autonomous self-improvement loop. Nothing here is tied to a
 * real identity: `clientId` is a random per-device id that lives only in the
 * browser's localStorage and can be cleared at any time from the dashboard.
 *
 * Framework-agnostic on purpose (no React / DOM / Node imports) so the same
 * types are shared by the client capture code, the API routes, the dashboard,
 * and the offline analysis script.
 */

import type { Difficulty } from "@/game/types";

/** Where the played track came from. */
export type SessionSource = "built-in" | "session" | "youtube" | "unknown";

/** Current schema version for stored events, so we can migrate later. */
export const METRICS_SCHEMA_VERSION = 1 as const;

/** Max play-session events kept when reading the server store. */
export const METRICS_MAX_EVENTS = 50_000 as const;

/**
 * One completed (or abandoned-at-the-end) play-through. Emitted by the client
 * when a song finishes and appended to the server store.
 */
export interface PlaySessionEvent {
  /** Unique event id (client-generated). */
  id: string;
  /** Anonymous per-device id. */
  clientId: string;
  schemaVersion: number;

  chartId: string;
  title: string;
  artist?: string;
  difficulty: Difficulty;
  source: SessionSource;
  bpm?: number;

  totalNotes: number;
  score: number;
  maxCombo: number;
  /** Weighted accuracy, 0..100. */
  accuracy: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;

  /** Calibration offset the player had dialed in (ms). */
  calibrationOffsetMs: number;
  /** True when every note was judged (as opposed to the song timing out). */
  completed: boolean;
  /** Chart duration in ms. */
  durationMs: number;

  /** ISO timestamp the session finished. */
  finishedAt: string;
}

/** Aggregated stats for a single difficulty tier. */
export interface DifficultyStat {
  difficulty: Difficulty;
  plays: number;
  avgAccuracy: number;
  /** Average fraction of notes missed, 0..1. */
  avgMissRate: number;
  /** Fraction of plays that reached the end, 0..1. */
  completionRate: number;
}

/** Aggregated stats for a single track/chart. */
export interface TrackStat {
  chartId: string;
  title: string;
  difficulty: Difficulty;
  plays: number;
  avgAccuracy: number;
  avgMissRate: number;
  avgScore: number;
  bestScore: number;
}

/** A single bar in the accuracy histogram. */
export interface HistogramBucket {
  label: string;
  count: number;
}

/** A lightweight recent-play row for the dashboard feed. */
export interface RecentSession {
  title: string;
  difficulty: Difficulty;
  accuracy: number;
  score: number;
  finishedAt: string;
}

/** The full rolled-up view rendered by the dashboard and fed to the analyzer. */
export interface MetricsSummary {
  generatedAt: string;
  totalSessions: number;
  uniquePlayers: number;
  totalNotesHit: number;
  /** Weighted accuracy across every session, 0..100. */
  overallAccuracy: number;
  /** Fraction of sessions that reached the end, 0..1. */
  completionRate: number;
  /** Median calibration offset players applied (ms). */
  medianCalibrationOffsetMs: number;
  accuracyBuckets: HistogramBucket[];
  byDifficulty: DifficultyStat[];
  topTracks: TrackStat[];
  recentSessions: RecentSession[];
}

export type RecommendationSeverity = "info" | "suggestion" | "warning";

export interface Recommendation {
  id: string;
  severity: RecommendationSeverity;
  title: string;
  detail: string;
}
