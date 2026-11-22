import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/db/index.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { fetchProviderUpstream } from "open-sse/utils/proxyFetch.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const conn = await getProviderConnectionById(id);
    if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const provider = conn.provider;
    const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;

    // Try live /models endpoint for OpenAI-compatible or Ollama local connections
    const baseUrl = conn.providerSpecificData?.baseUrl;
    if (baseUrl && (provider.startsWith("openai-compatible-") || provider === "ollama-local")) {
      try {
        const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
        const headers = conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {};
        const res = await fetchProviderUpstream(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const json = await res.json();
          const data = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
          const models = data
            .map((m) => ({ id: m.id || m.name, name: m.name || m.id }))
            .filter((m) => m.id);
          if (models.length > 0) return NextResponse.json({ models, source: "live" });
        }
      } catch {
        // fall through to static list
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
