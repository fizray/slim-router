import { NextResponse } from "next/server";
import { getPerformanceAnalytics } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "7d";
    const data = await getPerformanceAnalytics({ range });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load performance analytics" }, { status: 500 });
  }
}
