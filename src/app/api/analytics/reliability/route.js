import { NextResponse } from "next/server";
import { getReliabilityAnalytics, getProviderConnections, maskConnectionForApi } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "7d";
    const [data, connections] = await Promise.all([
      getReliabilityAnalytics({ range }),
      getProviderConnections(),
    ]);
    return NextResponse.json({
      ...data,
      connections: connections.map(maskConnectionForApi),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load reliability analytics" }, { status: 500 });
  }
}
