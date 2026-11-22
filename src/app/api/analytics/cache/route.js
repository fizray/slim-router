import { NextResponse } from "next/server";
import { getCacheAnalytics } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "7d";
    const data = await getCacheAnalytics({ range });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load cache analytics" }, { status: 500 });
  }
}
