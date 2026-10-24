import { describe, expect, it } from "vitest";

import { versusOutcome } from "./versus";

describe("versusOutcome", () => {
  it("awards the higher score", () => {
    expect(versusOutcome({ score: 900, failed: false }, { score: 1200, failed: false })).toBe("p2");
    expect(versusOutcome({ score: 1300, failed: false }, { score: 1200, failed: false })).toBe("p1");
  });

  it("calls equal scores a draw", () => {
    expect(versusOutcome({ score: 500, failed: true }, { score: 500, failed: true })).toBe("draw");
  });

  it("lets a survivor beat a booed-off player whatever the score", () => {
    expect(versusOutcome({ score: 9000, failed: true }, { score: 10, failed: false })).toBe("p2");
  });

  it("falls back to score when both were booed off", () => {
    expect(versusOutcome({ score: 700, failed: true }, { score: 400, failed: true })).toBe("p1");
  });
});
