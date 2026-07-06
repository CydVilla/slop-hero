/**
 * Community chart catalog.
 *
 * GET  /api/charts — newest community charts (metadata only, no note payloads).
 * POST /api/charts — publish a chart. The body is untrusted: it is rebuilt and
 * clamped by sanitizeCommunitySubmission before touching the database, exactly
 * like metrics events. Audio is never accepted — charts + YouTube ids only
 * (docs/adr/0002-community-catalog-charts-only.md).
 *
 * Without a configured DATABASE_URL both verbs answer with configured: false /
 * 503 so the client can hide the community section gracefully.
 */

import { NextResponse } from "next/server";

import { sanitizeCommunitySubmission } from "@/lib/community/sanitizeChart";
import {
  insertCommunityChart,
  isCommunityConfigured,
  listCommunityCharts,
} from "@/lib/community/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bigger than any legal chart (5000 clamped notes ≈ 400 KB of JSON). */
const MAX_BODY_BYTES = 1_500_000;

export async function GET(): Promise<NextResponse> {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ configured: false, items: [] }, { status: 200 });
  }
  try {
    const items = await listCommunityCharts();
    return NextResponse.json({ configured: true, items }, { status: 200 });
  } catch {
    return NextResponse.json(
      { configured: true, items: [], error: "list failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isCommunityConfigured()) {
    return NextResponse.json(
      { ok: false, error: "The shared catalog isn't available right now." },
      { status: 503 },
    );
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "unreadable body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Chart too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const result = sanitizeCommunitySubmission(body);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  }

  try {
    const id = await insertCommunityChart(result.value);
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "The shared catalog isn't available right now." },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch {
    return NextResponse.json({ ok: false, error: "publish failed" }, { status: 500 });
  }
}
