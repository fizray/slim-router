import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels, getProviderConnections, getPricingDetails } from "@/lib/db/index.js";
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

// GET /api/models - Full catalog across Vertex AI, Google AI Studio & Vertex Partner (all kinds, disabled state, pricing, connections)
export async function GET() {
  try {
    const [modelAliases, disabled, customModels, connections, pricingDetails] = await Promise.all([
      getModelAliases(),
      getDisabledModels(),
      getCustomModels(),
      getProviderConnections(),
      getPricingDetails(),
    ]);

    const activeConnectionsByProvider = {};
    for (const c of connections || []) {
      if (!c.isActive) continue;
      activeConnectionsByProvider[c.provider] = (activeConnectionsByProvider[c.provider] || 0) + 1;
    }

    const models = [];
    const seen = new Set();

    for (const entry of REGISTRY) {
      const providerId = entry.id;
      const providerAlias = entry.alias || getProviderAlias(providerId) || providerId;
      const disabledList = new Set([
        ...(disabled?.[providerId] || []),
        ...(disabled?.[providerAlias] || []),
      ]);

      for (const m of entry.models || []) {
        const kind = m.kind || m.type || "llm";
        const key = `${providerId}/${m.id}/${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const fullModel = `${providerId}/${m.id}`;
        const c = getCapabilitiesForModel(providerId, m.id);
        const rate = resolveRate(pricingDetails?.pricing, providerId, m.id);

        models.push({
          provider: providerId,
          providerName: entry.display?.name || providerId,
          providerAlias,
          model: m.id,
          name: m.name || m.id,
          kind,
          fullModel,
          routedModel: `${providerAlias}/${m.id}`,
          alias: modelAliases[fullModel] || null,
          disabled: disabledList.has(m.id),
          custom: false,
          hasActiveConnection: (activeConnectionsByProvider[providerId] || 0) > 0,
          activeConnections: activeConnectionsByProvider[providerId] || 0,
          pricing: rate ? {
            input: rate.input,
            output: rate.output,
            cached: rate.cached,
            source: rate._source || "synced",
          } : null,
          caps: {
            vision: !!c.vision,
            reasoning: !!c.reasoning,
            contextWindow: m.contextLength || c.contextWindow || null,
            maxOutput: m.maxOutputTokens || c.maxOutput || null,
          },
        });
      }
    }

    // Include custom models of any kind
    for (const m of customModels || []) {
      if (!m?.id || !m?.providerAlias) continue;
      const providerId = ALIAS_TO_ID[m.providerAlias] || m.providerAlias;
      const kind = m.kind || m.type || "llm";
      const key = `${providerId}/${m.id}/${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const fullModel = `${providerId}/${m.id}`;
      const disabledList = new Set([
        ...(disabled?.[providerId] || []),
        ...(disabled?.[m.providerAlias] || []),
      ]);
      const c = getCapabilitiesForModel(providerId, m.id);
      const rate = resolveRate(pricingDetails?.pricing, providerId, m.id);

      models.push({
        provider: providerId,
        providerName: providerId,
        providerAlias: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        kind,
        fullModel,
        routedModel: `${m.providerAlias}/${m.id}`,
        alias: modelAliases[fullModel] || null,
        disabled: disabledList.has(m.id),
        custom: true,
        hasActiveConnection: (activeConnectionsByProvider[providerId] || 0) > 0,
        activeConnections: activeConnectionsByProvider[providerId] || 0,
        pricing: rate ? {
          input: rate.input,
          output: rate.output,
          cached: rate.cached,
          source: rate._source || "synced",
        } : null,
        caps: {
          vision: !!c.vision,
          reasoning: !!c.reasoning,
          contextWindow: c.contextWindow || null,
          maxOutput: c.maxOutput || null,
          ...(m.caps || {}),
        },
      });
    }

    return NextResponse.json({
      models,
      activeConnectionsByProvider,
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
