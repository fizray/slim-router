import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/db/index.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { fetchProviderUpstream } from "open-sse/utils/proxyFetch.js";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const conn = await getProviderConnectionById(id);
    if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const provider = conn.provider;
    const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;

    // Live model discovery for Google AI Studio (gemini)
    if (provider === "gemini" && conn.apiKey) {
      try {
        const res = await fetchProviderUpstream("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
          headers: { "x-goog-api-key": conn.apiKey },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const json = await res.json();
          const models = (json?.models || []).map((m) => ({
            id: String(m.name || "").replace(/^models\//, ""),
            name: m.displayName || m.name,
            kind: (m.supportedGenerationMethods || []).includes("embedContent") ? "embedding" : "llm",
            contextLength: m.inputTokenLimit,
          })).filter((m) => m.id);
          if (models.length > 0) return NextResponse.json({ models, source: "live" });
        }
      } catch {
        // fall through to registry list
      }
    }

    const staticModels = (PROVIDER_MODELS[alias] || PROVIDER_MODELS[provider] || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      kind: m.kind || m.type || "llm",
      contextLength: m.contextLength,
    }));

    return NextResponse.json({ models: staticModels, source: "registry" });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load models" }, { status: 500 });
  }
}
