/**
 * Two-player versus rules: highest score wins, but getting booed off the stage
 * (rock meter empty) forfeits — a survivor beats a failed player on any score.
 */

export interface VersusRun {
  score: number;
  failed: boolean;
}

export type VersusOutcome = "p1" | "p2" | "draw";

export function versusOutcome(p1: VersusRun, p2: VersusRun): VersusOutcome {
  if (p1.failed !== p2.failed) return p1.failed ? "p2" : "p1";
  if (p1.score === p2.score) return "draw";
  return p1.score > p2.score ? "p1" : "p2";
}
