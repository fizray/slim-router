import { NextResponse } from "next/server";
import { getOverviewAnalytics, getActiveRequests, getDbDiskStats } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "7d";
    const data = await getOverviewAnalytics({ range });
    return NextResponse.json({
      ...data,
      activeRequests: getActiveRequests(),
      storage: getDbDiskStats(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load overview analytics" }, { status: 500 });
  }
}
