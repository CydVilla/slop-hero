"use client";

/**
 * Browser-side helpers for the community chart catalog: list, fetch-to-play,
 * and publish. Thin fetch wrappers around /api/charts with friendly errors.
 */

import type { ActiveSong } from "@/lib/activeSong";
import type { CommunityChartRecord } from "@/lib/community/store";
import type { CommunitySubmission } from "@/lib/community/sanitizeChart";

export type { CommunityChartRecord } from "@/lib/community/store";

export interface CommunityList {
  configured: boolean;
  items: CommunityChartRecord[];
}

/** Newest community charts (metadata only). Never throws. */
export async function fetchCommunityList(): Promise<CommunityList> {
  try {
    const res = await fetch("/api/charts");
    const data = (await res.json()) as Partial<CommunityList>;
    return {
      configured: data.configured ?? false,
      items: Array.isArray(data.items) ? data.items : [],
    };
  } catch {
    return { configured: false, items: [] };
  }
}

/** Full chart for one community entry, or null if it can't be loaded. */
export async function fetchCommunityChart(
  id: string,
): Promise<CommunityChartRecord | null> {
  try {
    const res = await fetch(`/api/charts/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { item?: CommunityChartRecord };
    return data.item && data.item.chart ? data.item : null;
  } catch {
    return null;
  }
}

/** Publish a chart. Returns the new id, or throws with a friendly message. */
export async function publishCommunityChart(
  submission: CommunitySubmission,
): Promise<string> {
  const res = await fetch("/api/charts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    id?: string;
    error?: string;
  };
  if (!res.ok || !data.ok || !data.id) {
    throw new Error(data.error ?? "Publishing failed — try again in a moment.");
  }
  return data.id;
}

/** Convert a fetched community record into the /play hand-off shape. */
export function communityChartToActiveSong(
  record: CommunityChartRecord,
): ActiveSong | null {
  if (!record.chart) return null;
  return {
    chart: record.chart,
    youtubeId: record.youtubeId,
    title: record.title,
    subtitle: `${record.artist ?? "Community chart"} · charted by ${record.contributor}`,
    meta: {
      trackId: record.id,
      source: record.youtubeId ? "youtube" : "session",
      difficulty: record.difficulty,
      bpm: record.bpm,
      artist: record.artist,
    },
  };
}
