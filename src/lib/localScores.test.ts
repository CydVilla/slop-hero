/**
 * Tests for the local leaderboard's pure ranking core and key derivation.
 * The storage wrapper is a thin localStorage shim that fails soft; the
 * decisions (ordering, capping, new-best detection) all live in rankScore.
 */

import { describe, expect, it } from "vitest";

import {
  BOARD_SIZE,
  chartScoreKey,
  rankScore,
  type LocalScoreEntry,
} from "./localScores";

function entry(score: number, accuracy = 90, at = "2026-07-13"): LocalScoreEntry {
  return { score, stars: 3, accuracy, maxCombo: 10, completed: true, at };
}

describe("chartScoreKey", () => {
  it("separates the same track by difficulty", () => {
    expect(chartScoreKey("track-1", "easy")).not.toBe(
      chartScoreKey("track-1", "expert"),
    );
  });
});

describe("rankScore", () => {
  it("the first run is rank 1 and a new best with no previous", () => {
    const result = rankScore([], entry(5000));
    expect(result).toMatchObject({ rank: 1, isNewBest: true, previousBest: null });
    expect(result.board).toHaveLength(1);
  });

  it("beating the top score reports the previous best", () => {
    const board = rankScore([], entry(5000)).board;
    const result = rankScore(board, entry(8000));
    expect(result.rank).toBe(1);
    expect(result.isNewBest).toBe(true);
    expect(result.previousBest).toBe(5000);
  });

  it("a mid-board run ranks without being a new best", () => {
    let board: LocalScoreEntry[] = [];
    for (const s of [9000, 7000, 5000]) board = rankScore(board, entry(s)).board;
    const result = rankScore(board, entry(6000));
    expect(result.rank).toBe(3);
    expect(result.isNewBest).toBe(false);
    expect(result.board.map((e) => e.score)).toEqual([9000, 7000, 6000, 5000]);
  });

  it("caps the board and reports null rank for runs that miss it", () => {
    let board: LocalScoreEntry[] = [];
    for (let i = 0; i < BOARD_SIZE; i += 1) {
      board = rankScore(board, entry(10_000 - i * 1000)).board;
    }
    const result = rankScore(board, entry(1));
    expect(result.rank).toBeNull();
    expect(result.board).toHaveLength(BOARD_SIZE);
    expect(result.board.some((e) => e.score === 1)).toBe(false);
  });

  it("breaks score ties by accuracy", () => {
    const board = rankScore([], entry(5000, 80)).board;
    const result = rankScore(board, entry(5000, 95));
    expect(result.rank).toBe(1);
    // Equal score is not a NEW best — you must beat it, not match it.
    expect(result.isNewBest).toBe(false);
  });
});
