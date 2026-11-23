import { NextResponse } from "next/server";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import { ALIAS_TO_ID, getProviderAlias } from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases, authenticateApiKey, getSyncedCatalog } from "@/lib/db/index.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { extractApiKey } from "@/sse/services/auth.js";
import { getKeyAccessContext, filterModelsListForKey } from "@/sse/services/keyAccess.js";
import { capabilitiesFromServiceKind, getCapabilitiesForModel, aggregateComboCapabilities } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

export const dynamic = "force-dynamic";

const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])),
  ...ALIAS_TO_ID,
};

function comboSeatCapabilities(seat) {
  const slash = seat.indexOf("/");
  if (slash <= 0) return null;
  const alias = seat.slice(0, slash);
  return getCapabilitiesForModel(ALIAS_TO_PROVIDER_ID[alias] || alias, seat.slice(slash + 1));
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function buildModelsList(kindFilter = null) {
  const allowedKinds = Array.isArray(kindFilter) && kindFilter.length > 0 ? new Set(kindFilter) : null;
  const [connections, combos, customModels, aliases, disabledModels, syncedCatalog] = await Promise.all([
    getProviderConnections({ isActive: true }),
    getCombos(),
    getCustomModels(),
    getModelAliases(),
    getDisabledModels(),
    getSyncedCatalog(),
  ]);

  const disabledSet = new Set(
    Object.entries(disabledModels || {}).flatMap(([prov, list]) =>
      (Array.isArray(list) ? list : []).map((m) => `${prov}/${m}`)
    )
  );

  const activeProviders = new Set(connections.map((c) => c.provider));
  const seen = new Set();
  const list = [];
  const created = Math.floor(Date.now() / 1000);

  // 1. Combos
  for (const combo of combos || []) {
    if (!combo?.name || seen.has(combo.name)) continue;
    const kind = combo.kind || "llm";
    if (allowedKinds && !allowedKinds.has(kind)) continue;
    seen.add(combo.name);
    const seatCaps = (combo.models || []).map(comboSeatCapabilities).filter(Boolean);
    const caps = seatCaps.length ? aggregateComboCapabilities(seatCaps) : undefined;
    list.push({
      id: combo.name,
      object: "model",
      created,
      owned_by: "combo",
      kind,
      ...(caps ? { capabilities: caps } : {}),
    });
  }

  // 2. Active provider models (registry + live synced models.dev catalog)
  for (const providerId of activeProviders) {
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || getProviderAlias(providerId) || providerId;
    const registryModels = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
    const liveModels = syncedCatalog?.[providerId] || [];
    const combined = [...liveModels, ...registryModels];
    for (const m of combined) {
      const id = `${alias}/${m.id}`;
      if (seen.has(id) || disabledSet.has(`${providerId}/${m.id}`) || disabledSet.has(id)) continue;
      const kind = m.kind || m.type || getModelKind(alias, m.id) || "llm";
      if (allowedKinds && !allowedKinds.has(kind)) continue;
      seen.add(id);
      const caps = getCapabilitiesForModel(providerId, m.id) || capabilitiesFromServiceKind(kind);
      const thinkingLevels = getThinkingLevels(providerId, m.id);
      list.push({
        id,
        object: "model",
        created,
        owned_by: providerId,
        kind,
        ...(m.contextLength || m.contextWindow ? { context_length: m.contextLength || m.contextWindow } : {}),
        ...(caps ? { capabilities: caps } : {}),
        ...(thinkingLevels?.length ? { thinking_levels: thinkingLevels } : {}),
      });
    }
  }

  // 3. Custom models
  for (const cm of customModels || []) {
    if (!cm?.id || !cm?.providerAlias) continue;
    const id = `${cm.providerAlias}/${cm.id}`;
    const kind = cm.type || "llm";
    if (seen.has(id) || (allowedKinds && !allowedKinds.has(kind))) continue;
    seen.add(id);
    list.push({
      id,
      object: "model",
      created,
      owned_by: cm.providerAlias,
      kind,
    });
  }

  // 4. Aliases
  if (!allowedKinds || allowedKinds.has("llm")) {
    for (const [aliasName, target] of Object.entries(aliases || {})) {
      if (!aliasName || seen.has(aliasName)) continue;
      seen.add(aliasName);
      list.push({
        id: aliasName,
        object: "model",
        created,
        owned_by: "alias",
        target,
      });
    }
  }

  return list;
}

export async function GET(request) {
  try {
    const rawKey = extractApiKey(request);
    const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
    if (!apiKeyRecord) {
      return NextResponse.json({ error: { message: "Valid API key required", type: "authentication_error" } }, { status: 401 });
    }

    const list = await buildModelsList();
    const keyAccess = await getKeyAccessContext(request, apiKeyRecord);
    const filtered = await filterModelsListForKey(keyAccess, list);

    return NextResponse.json({ object: "list", data: filtered });
  } catch (error) {
    return NextResponse.json({ error: { message: error.message || "Failed to list models" } }, { status: 500 });
  }
}
