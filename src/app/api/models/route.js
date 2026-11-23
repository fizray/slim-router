import { NextResponse } from "next/server";
import {
  getModelAliases,
  setModelAlias,
  getCustomModels,
  getProviderConnections,
  getPricingDetails,
  getSyncedCatalog,
} from "@/lib/db/index.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getProviderAlias, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import REGISTRY from "open-sse/providers/registry/index.js";

function resolveRate(pricingMap, provider, modelId) {
  const short = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  const provMap = pricingMap?.[provider];
  if (provMap?.[modelId]) return provMap[modelId];
  if (provMap?.[short]) return provMap[short];
  if (provider === "vertex" && pricingMap?.gemini?.[short]) return pricingMap.gemini[short];
  if (provider === "gemini" && pricingMap?.vertex?.[short]) return pricingMap.vertex[short];
  return null;
}

// GET /api/models - Full catalog merging Registry + Live Synced models.dev Catalog + Custom Models
export async function GET() {
  try {
    const [modelAliases, disabled, customModels, connections, pricingDetails, syncedCatalog] = await Promise.all([
      getModelAliases(),
      getDisabledModels(),
      getCustomModels(),
      getProviderConnections(),
      getPricingDetails(),
      getSyncedCatalog(),
    ]);

    const activeConnectionsByProvider = {};
    for (const c of connections || []) {
      if (!c.isActive) continue;
      activeConnectionsByProvider[c.provider] = (activeConnectionsByProvider[c.provider] || 0) + 1;
    }

    const providerMeta = new Map(
      REGISTRY.map((entry) => [
        entry.id,
        {
          name: entry.display?.name || entry.id,
          alias: entry.alias || getProviderAlias(entry.id) || entry.id,
        },
      ])
    );

    const models = [];
    const seen = new Set();

    function pushModel({ providerId, providerAlias, providerName, id, name, kind, source, custom = false, capsOverride = null, contextLength = null, maxOutputTokens = null }) {
      const cleanKind = kind || "llm";
      const key = `${providerId}/${id}/${cleanKind}`;
      if (seen.has(key)) return;
      seen.add(key);

      const disabledList = new Set([
        ...(disabled?.[providerId] || []),
        ...(disabled?.[providerAlias] || []),
      ]);
      const fullModel = `${providerId}/${id}`;
      const c = getCapabilitiesForModel(providerId, id);
      const rate = resolveRate(pricingDetails?.pricing, providerId, id);

      models.push({
        provider: providerId,
        providerName,
        providerAlias,
        model: id,
        name: name || id,
        kind: cleanKind,
        source,
        fullModel,
        routedModel: `${providerAlias}/${id}`,
        alias: modelAliases[fullModel] || null,
        disabled: disabledList.has(id),
        custom,
        hasActiveConnection: (activeConnectionsByProvider[providerId] || 0) > 0,
        activeConnections: activeConnectionsByProvider[providerId] || 0,
        pricing: rate ? {
          input: rate.input,
          output: rate.output,
          cached: rate.cached,
          source: rate._source || "synced",
        } : null,
        caps: {
          vision: capsOverride?.vision ?? !!c.vision,
          reasoning: capsOverride?.reasoning ?? !!c.reasoning,
          contextWindow: contextLength || capsOverride?.contextWindow || c.contextWindow || null,
          maxOutput: maxOutputTokens || capsOverride?.maxOutput || c.maxOutput || null,
        },
      });
    }

    // 1. Live synced catalog from models.dev (complete Vertex AI, AI Studio & Vertex Partner catalog)
    for (const [providerId, list] of Object.entries(syncedCatalog || {})) {
      const meta = providerMeta.get(providerId) || { name: providerId, alias: providerId };
      for (const m of list || []) {
        pushModel({
          providerId,
          providerAlias: meta.alias,
          providerName: meta.name,
          id: m.id,
          name: m.name || m.id,
          kind: m.kind || "llm",
          source: "models.dev",
          capsOverride: {
            vision: m.vision,
            reasoning: m.reasoning,
            contextWindow: m.contextWindow,
            maxOutput: m.maxOutput,
          },
        });
      }
    }

    // 2. Built-in registry models (adds Veo video, Gemini Live STT, and offline fallback before first sync)
    for (const entry of REGISTRY) {
      const providerId = entry.id;
      const meta = providerMeta.get(providerId);
      for (const m of entry.models || []) {
        pushModel({
          providerId,
          providerAlias: meta.alias,
          providerName: meta.name,
          id: m.id,
          name: m.name || m.id,
          kind: m.kind || m.type || "llm",
          source: "registry",
          contextLength: m.contextLength,
          maxOutputTokens: m.maxOutputTokens,
        });
      }
    }

    // 3. User custom models
    for (const m of customModels || []) {
      if (!m?.id || !m?.providerAlias) continue;
      const providerId = ALIAS_TO_ID[m.providerAlias] || m.providerAlias;
      const meta = providerMeta.get(providerId) || { name: providerId, alias: m.providerAlias };
      pushModel({
        providerId,
        providerAlias: m.providerAlias,
        providerName: meta.name,
        id: m.id,
        name: m.name || m.id,
        kind: m.kind || m.type || "llm",
        source: "custom",
        custom: true,
        capsOverride: m.caps || null,
      });
    }

    return NextResponse.json({
      models,
      activeConnectionsByProvider,
      syncedCounts: {
        vertex: (syncedCatalog?.vertex || []).length,
        gemini: (syncedCatalog?.gemini || []).length,
        "vertex-partner": (syncedCatalog?.["vertex-partner"] || []).length,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;
    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }
    const modelAliases = await getModelAliases();
    const existingModel = Object.entries(modelAliases).find(([key, val]) => val === alias && key !== model);
    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }
    await setModelAlias(model, alias);
    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update alias" }, { status: 500 });
  }
}
