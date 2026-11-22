import { NextResponse } from "next/server";
import { getTraceById, getTracePayloadById } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { traceId } = await params;
    if (!traceId) return NextResponse.json({ error: "Missing traceId" }, { status: 400 });

    const [detail, payload] = await Promise.all([
      getTraceById(traceId),
      getTracePayloadById(traceId),
    ]);

    if (!detail) {
      return NextResponse.json({ error: "Trace not found" }, { status: 404 });
    }

    return NextResponse.json({
      trace: detail.trace,
      spans: detail.spans,
      payload,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load trace detail" }, { status: 500 });
  }
}
