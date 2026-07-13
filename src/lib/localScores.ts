/**
 * Local per-chart leaderboards.
 *
 * Best runs live on the device (localStorage, same privacy stance as the
 * metrics client): a top-5 board per chart+difficulty. The ranking core is a
 * pure function so it's unit-testable; the storage wrapper fails soft — a
 * blocked or full localStorage silently disables leaderboards rather than
 * breaking gameplay.
 *
 * Practice runs are never submitted (looping a section forever isn't a run).
 */

export interface LocalScoreEntry {
  score: number;
  /** 0–5 star rating of the run. */
  stars: number;
  /** Weighted accuracy percent (0..100). */
  accuracy: number;
  maxCombo: number;
  /** Whether every note was judged (false for failed runs). */
  completed: boolean;
  /** ISO date of the run. */
  at: string;
}

export interface SubmitResult {
  /** 1-based position on the board, or null if it didn't make the top 5. */
  rank: number | null;
  /** True when this run beat the previous best score for the chart. */
  isNewBest: boolean;
  /** The best score before this run, or null for a first run. */
  previousBest: number | null;
  board: LocalScoreEntry[];
}

export const BOARD_SIZE = 5;

const STORAGE_KEY = "slopHero.localScores.v1";

/** Stable board id for a chart: track identity + difficulty. */
export function chartScoreKey(trackId: string, difficulty: string): string {
  return `${trackId}::${difficulty}`;
}

/**
 * Pure ranking core: insert a run into a board, keeping it sorted by score
 * (ties broken by accuracy, then recency) and capped at BOARD_SIZE.
 */
export function rankScore(
  board: readonly LocalScoreEntry[],
  entry: LocalScoreEntry,
): SubmitResult {
  const previousBest = board.length > 0 ? (board[0] as LocalScoreEntry).score : null;
  const next = [...board, entry].sort(
    (a, b) => b.score - a.score || b.accuracy - a.accuracy || b.at.localeCompare(a.at),
  );
  const trimmed = next.slice(0, BOARD_SIZE);
  const index = trimmed.indexOf(entry);
  return {
    rank: index >= 0 ? index + 1 : null,
    isNewBest: previousBest === null || entry.score > previousBest,
    previousBest,
    board: trimmed,
  };
}

/* ------------------------------ storage layer ----------------------------- */

type ScoreStore = Record<string, LocalScoreEntry[]>;

function readStore(): ScoreStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as ScoreStore;
  } catch {
    return {};
  }
}

function writeStore(store: ScoreStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota/blocked storage: leaderboards silently off, gameplay unaffected.
  }
}

/** The stored top-5 board for a chart (best first). Empty when none. */
export function readBoard(key: string): LocalScoreEntry[] {
  const board = readStore()[key];
  return Array.isArray(board) ? board.filter(isValidEntry) : [];
}

/** Best stored score for a chart, or null. */
export function bestScore(key: string): LocalScoreEntry | null {
  return readBoard(key)[0] ?? null;
}

/**
 * Submit a finished (non-practice) run. Persists the updated board and
 * reports how the run placed.
 */
export function submitScore(key: string, entry: LocalScoreEntry): SubmitResult {
  const store = readStore();
  const board = Array.isArray(store[key]) ? store[key].filter(isValidEntry) : [];
  const result = rankScore(board, entry);
  store[key] = result.board;
  writeStore(store);
  return result;
}

function isValidEntry(value: unknown): value is LocalScoreEntry {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.score === "number" &&
    Number.isFinite(o.score) &&
    typeof o.at === "string"
  );
}
