// Unified Public DB Barrel — 3-File Split SQLite (config, telemetry, payloads)
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import { getConfigDb, getDatabases } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { encryptConnectionSecrets, encryptNodeSecrets } from "@/lib/crypto/vault.js";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

// Settings
export {
  getSettings, updateSettings, exportSettings, getCurrentSessionVersion,
  invalidateAuthStateCache, MUTABLE_SETTING_KEYS,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
  maskConnectionForApi,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
  maskNodeForApi,
} from "./repos/nodesRepo.js";

// API keys (zero-plaintext HMAC)
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, authenticateApiKey,
  createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
} from "./repos/aliasRepo.js";

// Pricing & Dynamic Model Catalog (100% dynamic live synced + user override)
export {
  getPricing, getPricingDetails, getPricingForModel, saveSyncedPricing,
  saveSyncedCatalog, getSyncedCatalog, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Telemetry & Analytics
export {
  canonicalizeTokens, computePrecisionCost, classifyErrorCategory,
  recordTraceAndSpans, getApiKeySpendWindow, getGlobalSpendWindow,
  getOverviewAnalytics, getPerformanceAnalytics, getCostAnalytics,
  getCacheAnalytics, getReliabilityAnalytics, listTraces, getTraceById,
} from "./repos/telemetryRepo.js";

// Payloads (worker queue + reader)
export { enqueueTracePayload, flushPayloadWorker, getTracePayloadById } from "./payloadQueue.js";

// Backups
export { createAtomicBackup, listBackups, getDbDiskStats, startDailyBackupScheduler } from "./backup.js";

// Lightweight in-memory pending request tracker (anchored on globalThis)
const pendingState = (globalThis.__9r_pendingRequests ??= { byModel: {}, byAccount: {}, activeCount: 0 });
export const statsEmitter = (globalThis.__9r_statsEmitter ??= (() => {
  const e = new EventEmitter();
  e.setMaxListeners(50);
  return e;
})());

export function trackPendingRequest(model, provider, connectionId, started, isError = false) {
  const key = `${provider}/${model}`;
  if (started) {
    pendingState.activeCount = Math.max(0, pendingState.activeCount + 1);
    pendingState.byModel[key] = (pendingState.byModel[key] || 0) + 1;
    if (connectionId) pendingState.byAccount[connectionId] = (pendingState.byAccount[connectionId] || 0) + 1;
  } else {
    pendingState.activeCount = Math.max(0, pendingState.activeCount - 1);
    if (pendingState.byModel[key]) {
      pendingState.byModel[key]--;
      if (pendingState.byModel[key] <= 0) delete pendingState.byModel[key];
    }
    if (connectionId && pendingState.byAccount[connectionId]) {
      pendingState.byAccount[connectionId]--;
      if (pendingState.byAccount[connectionId] <= 0) delete pendingState.byAccount[connectionId];
    }
  }
  statsEmitter.emit(isError ? "error" : "pending", { activeCount: pendingState.activeCount });
}

export function getActiveRequests() {
  return {
    activeCount: pendingState.activeCount,
    byModel: { ...pendingState.byModel },
    byAccount: { ...pendingState.byAccount },
  };
}

// Backward-compatible no-op shims for open-sse chatCore (real telemetry flows through Tracer)
export async function saveRequestUsage() {}
export async function appendRequestLog() {}
export async function saveRequestDetail() {}

// Safe redacted config export (never dumps plaintext secrets unless explicitly opted-in after re-auth)
export async function exportDb({ includeSecrets = false } = {}) {
  const db = await getConfigDb();
  const { exportSettings } = await import("./repos/settingsRepo.js");
  const { getProviderConnections, maskConnectionForApi } = await import("./repos/connectionsRepo.js");
  const { getProviderNodes, maskNodeForApi } = await import("./repos/nodesRepo.js");

  const conns = await getProviderConnections();
  const nodes = await getProviderNodes();
  const rawSettings = await exportSettings();
  const { password, ...safeSettings } = rawSettings || {};

  const out = {
    version: 3,
    exportedAt: new Date().toISOString(),
    settings: safeSettings,
    providerConnections: includeSecrets ? conns : conns.map(maskConnectionForApi),
    providerNodes: includeSecrets ? nodes : nodes.map(maskNodeForApi),
    apiKeys: db.all("SELECT * FROM apiKeys").map((r) => ({
      id: r.id,
      keyHint: r.key_hint,
      name: r.name,
      isActive: r.is_active === 1,
      access: keyAccessFromColumns(r.access_restricted, r.access_allow),
      rpmLimit: r.rpm_limit,
      tpmLimit: r.tpm_limit,
      dailyBudgetUsd: r.daily_budget_usd,
      monthlyBudgetUsd: r.monthly_budget_usd,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    })),
    combos: db.all("SELECT * FROM combos").map((r) => ({
      id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []),
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
    modelAliases: {},
    customModels: [],
    pricing: {},
  };

  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'modelAliases'")) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'customModels'")) out.customModels.push(parseJson(r.value));
  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'pricing'")) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getConfigDb();

  db.transaction(() => {
    db.run("DELETE FROM providerConnections");
    db.run("DELETE FROM providerNodes");
    db.run("DELETE FROM combos");
    db.run("DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'pricing')");

    for (const c of payload.providerConnections || []) {
      // Assign final ID BEFORE encrypting so AES-256-GCM AAD matches permanently
      const finalId = c.id || uuidv4();
      const { id: _id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      const encrypted = encryptConnectionSecrets(finalId, rest);
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [finalId, provider, authType || "apikey", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(encrypted), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }

    for (const n of payload.providerNodes || []) {
      const finalId = n.id || uuidv4();
      const { id: _id, type, name, createdAt, updatedAt, ...rest } = n;
      const encrypted = encryptNodeSecrets(finalId, rest);
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)`,
        [finalId, type || null, name || null, stringifyJson(encrypted), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }

    for (const c of payload.combos || []) {
      const finalId = c.id || uuidv4();
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [finalId, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }

    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)", [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)", [k, stringifyJson(m)]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)", [provider, stringifyJson(models || {})]);
    }
  });

  return exportDb({ includeSecrets: false });
}

export async function initDb() {
  await getDatabases();
}
