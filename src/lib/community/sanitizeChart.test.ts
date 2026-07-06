import { describe, expect, it } from "vitest";

import {
  COMMUNITY_MAX_NOTES,
  sanitizeCommunitySubmission,
} from "./sanitizeChart";

function validBody(): Record<string, unknown> {
  return {
    title: "My Chart",
    artist: "Someone",
    contributor: "tester",
    difficulty: "medium",
    bpm: 120,
    durationSeconds: 30,
    youtubeId: "dQw4w9WgXcQ",
    chart: {
      id: "whatever",
      title: "ignored",
      offsetMs: 0,
      difficulty: "medium",
      notes: [
        { id: "a", timeMs: 500, lane: 0 },
        { id: "b", timeMs: 1000, lane: 1 },
        { id: "c", timeMs: 1500, lane: 2, durationMs: 800 },
        { id: "d", timeMs: 2000, lane: 4 },
      ],
    },
  };
}

describe("sanitizeCommunitySubmission", () => {
  it("accepts a well-formed submission and rebuilds the chart", () => {
    const res = sanitizeCommunitySubmission(validBody());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.title).toBe("My Chart");
    expect(res.value.chart.notes).toHaveLength(4);
    // Ids are server-assigned, not passed through.
    expect(res.value.chart.notes.every((n) => n.id.startsWith("c_"))).toBe(true);
    // Hold survives with type set.
    expect(res.value.chart.notes[2]?.type).toBe("hold");
    expect(res.value.chart.notes[2]?.durationMs).toBe(800);
  });

  it("rejects non-objects and missing titles", () => {
    expect(sanitizeCommunitySubmission(null).ok).toBe(false);
    expect(sanitizeCommunitySubmission("nope").ok).toBe(false);
    const body = validBody();
    delete body.title;
    expect(sanitizeCommunitySubmission(body).ok).toBe(false);
  });

  it("rejects bad difficulties and malformed YouTube ids", () => {
    const bad = validBody();
    bad.difficulty = "nightmare";
    expect(sanitizeCommunitySubmission(bad).ok).toBe(false);

    const badYt = validBody();
    badYt.youtubeId = "https://youtu.be/dQw4w9WgXcQ";
    expect(sanitizeCommunitySubmission(badYt).ok).toBe(false);
  });

  it("drops invalid notes and rejects charts left with too few", () => {
    const body = validBody();
    (body.chart as Record<string, unknown>).notes = [
      { timeMs: 100, lane: 9 }, // bad lane
      { timeMs: -50, lane: 0 }, // clamps to 0 — valid
      { timeMs: "x", lane: 1 }, // bad time
      { timeMs: 200, lane: 2 },
    ];
    // Only 2 valid notes remain — below the minimum.
    expect(sanitizeCommunitySubmission(body).ok).toBe(false);
  });

  it("rejects charts above the note cap", () => {
    const body = validBody();
    (body.chart as Record<string, unknown>).notes = Array.from(
      { length: COMMUNITY_MAX_NOTES + 1 },
      (_, i) => ({ timeMs: i * 100, lane: i % 5 }),
    );
    const res = sanitizeCommunitySubmission(body);
    expect(res.ok).toBe(false);
  });

  it("sorts notes by time and clamps text fields", () => {
    const body = validBody();
    body.title = "x".repeat(500);
    (body.chart as Record<string, unknown>).notes = [
      { timeMs: 4000, lane: 0 },
      { timeMs: 1000, lane: 1 },
      { timeMs: 3000, lane: 2 },
      { timeMs: 2000, lane: 3 },
    ];
    const res = sanitizeCommunitySubmission(body);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.title).toHaveLength(80);
    const times = res.value.chart.notes.map((n) => n.timeMs);
    expect(times).toEqual([1000, 2000, 3000, 4000]);
  });

  it("derives durationSeconds from the last note when absent", () => {
    const body = validBody();
    delete body.durationSeconds;
    const res = sanitizeCommunitySubmission(body);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Latest note end is the hold: 1500ms + 800ms = 2300ms → ceil → 3 seconds.
    expect(res.value.durationSeconds).toBe(3);
  });
});
