import { NextResponse } from "next/server";
import { listTraces } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const sp = url.searchParams;
    const data = await listTraces({
      startMs: sp.get("startMs") || undefined,
      endMs: sp.get("endMs") || undefined,
      cursorEpochMs: sp.get("cursor") || undefined,
      traceId: sp.get("traceId") || undefined,
      search: sp.get("search") || undefined,
      provider: sp.get("provider") || undefined,
      model: sp.get("model") || undefined,
      apiKeyId: sp.get("apiKeyId") || undefined,
      tag: sp.get("tag") || undefined,
      sessionId: sp.get("sessionId") || undefined,
      status: sp.get("status") || undefined,
      errorCategory: sp.get("errorCategory") || undefined,
      minLatencyMs: sp.get("minLatencyMs") || undefined,
      cacheFilter: sp.get("cache") || undefined,
      multimodalOnly: sp.get("multimodal") === "true",
      fallbackOnly: sp.get("fallback") === "true",
      limit: sp.get("limit") || 50,
    });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to list traces" }, { status: 500 });
  }
}
