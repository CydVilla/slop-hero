/**
 * GET /api/charts/[id] — one community chart including its full note payload.
 * Used when the player actually presses Play on a community track; the list
 * endpoint stays lightweight.
 */

import { NextResponse } from "next/server";

import { getCommunityChart, isCommunityConfigured } from "@/lib/community/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^community-[A-Za-z0-9-]{10,60}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ ok: false, error: "not configured" }, { status: 503 });
  }

  const { id } = await params;
  if (!ID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  }

  try {
    const record = await getCommunityChart(id);
    if (!record) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, item: record }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, error: "lookup failed" }, { status: 500 });
  }
}
