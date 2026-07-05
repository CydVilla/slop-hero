/**
 * Tests for the track-availability filter that hides audit-flagged tracks from
 * the catalog (src/data/availability.ts + src/data/unavailableTracks.json).
 * The audit script writes the JSON; these tests pin down how the app consumes
 * it — including the defensive behaviour on malformed machine-written data.
 */

import { describe, expect, it } from "vitest";

import { filterAvailable, unavailableTrackIds } from "./availability";

describe("unavailableTrackIds", () => {
  it("collects the flagged ids", () => {
    const ids = unavailableTrackIds({
      tracks: [
        { trackId: "a", reason: "youtube-unavailable" },
        { trackId: "b", reason: "missing-audio-file" },
      ],
    });
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("degrades to an empty set on malformed data instead of throwing", () => {
    expect(
      unavailableTrackIds({ tracks: undefined as unknown as [] }).size,
    ).toBe(0);
    expect(
      unavailableTrackIds({
        tracks: [
          null,
          { reason: "x" },
          { trackId: 42 },
          { trackId: "" },
        ] as unknown as [],
      }).size,
    ).toBe(0);
  });

  it("reads the checked-in JSON without error (shape contract)", () => {
    // The real file ships empty until the audit flags something; this pins the
    // import + parse path the app takes at module load.
    expect(unavailableTrackIds()).toBeInstanceOf(Set);
  });
});

describe("filterAvailable", () => {
  const tracks = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("removes exactly the flagged tracks", () => {
    const out = filterAvailable(tracks, new Set(["b"]));
    expect(out.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("returns a copy (not the input array) when nothing is flagged", () => {
    const out = filterAvailable(tracks, new Set());
    expect(out).toEqual(tracks);
    expect(out).not.toBe(tracks);
  });

  it("can flag everything (callers must handle the empty case)", () => {
    expect(filterAvailable(tracks, new Set(["a", "b", "c"]))).toEqual([]);
  });
});
