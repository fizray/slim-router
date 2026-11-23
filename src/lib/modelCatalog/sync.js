/**
 * Dynamic Model Catalog & Live Pricing Sync from https://models.dev/api.json
 *
 * Scoped strictly to Google Vertex AI (vertex), Google AI Studio (gemini),
 * and Vertex AI Partner Models (vertex-partner).
 * - Persists full model catalog into config.sqlite (kv scope 'catalog_models')
 * - Persists live $/1M token pricing into config.sqlite (kv scope 'pricing_synced')
 * - Writes capability overrides to DATA_DIR/model-catalog.json
 */

import fs from "node:fs";
import path from "node:path";
import { CATALOG_FILE, CATALOG_VERSION, invalidateCatalog, installCatalogSource } from "open-sse/providers/catalogOverride.js";
import { saveSyncedPricing, saveSyncedCatalog } from "@/lib/db/repos/pricingRepo.js";
import { fetchProviderUpstream } from "open-sse/utils/proxyFetch.js";
import { jsonLogger } from "@/lib/logging/logger.js";

export const CATALOG_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 30000;
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 1000;
const RETRY_DELAY_MS = 30 * 60 * 1000;

const MODALITY_BY_INPUT = { image: "vision", pdf: "pdf", audio: "audioInput", video: "videoInput" };
const GOOGLE_FIRST_PARTY_RE = /^(?:google\/)?(?:gemini|gemma|imagen|veo|text-embedding|embedding|multimodalembedding)/i;
const PARTNER_VENDOR_PROVIDERS = ["anthropic", "deepseek", "alibaba", "zai"];

const syncState = (globalThis.__9r_catalogSync ??= {
  running: false,
  lastSync: null,
  lastError: null,
  lastResult: null,
  etag: null,
  timer: null,
});

export function getSyncState() {
  return {
    running: syncState.running,
    lastSync: syncState.lastSync,
    lastError: syncState.lastError,
    lastResult: syncState.lastResult,
    url: CATALOG_URL,
    intervalMs: SYNC_INTERVAL_MS,
  };
}

function normalizeRate(costObj) {
  if (!costObj || typeof costObj !== "object") return null;
  const input = Number(costObj.input);
  const output = Number(costObj.output);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const safeInput = Number.isFinite(input) && input >= 0 ? input : 0;
  const safeOutput = Number.isFinite(output) && output >= 0 ? output : 0;
  const cachedRaw = Number(costObj.cache_read ?? costObj.cached);
  const cacheWriteRaw = Number(costObj.cache_write ?? costObj.cache_creation);
  const reasoningRaw = Number(costObj.reasoning);

  return {
    input: safeInput,
    output: safeOutput,
    cached: Number.isFinite(cachedRaw) && cachedRaw >= 0 ? cachedRaw : safeInput,
    cache_creation: Number.isFinite(cacheWriteRaw) && cacheWriteRaw >= 0 ? cacheWriteRaw : safeInput,
    reasoning: Number.isFinite(reasoningRaw) && reasoningRaw >= 0 ? reasoningRaw : safeOutput,
  };
}

function inferModelKind(modelId, model) {
  const id = String(modelId || "").toLowerCase();
  const outputs = Array.isArray(model?.modalities?.output) ? model.modalities.output : [];
  if (id.includes("embedding")) return "embedding";
  if (id.startsWith("veo") || id.includes("/veo")) return "video";
  if (id.startsWith("imagen") || id.includes("-image") || id.includes("nano-banana") || (outputs.includes("image") && !outputs.includes("text"))) {
    return "image";
  }
  if (id.includes("-tts") || id.endsWith("tts") || (outputs.includes("audio") && !outputs.includes("text"))) {
    return "tts";
  }
  return "llm";
}

function extractPricingAndCapabilities(catalog) {
  const syncedPricing = { vertex: {}, gemini: {}, "vertex-partner": {} };
  const syncedCatalog = { vertex: [], gemini: [], "vertex-partner": [] };
  const seenCatalog = { vertex: new Set(), gemini: new Set(), "vertex-partner": new Set() };
  const capModels = {};
  const capProviders = {};

  function recordModel(localId, rawModelId, model) {
    const shortId = rawModelId.includes("/") ? rawModelId.split("/").pop() : rawModelId;
    const rate = normalizeRate(model?.cost);
    if (rate) {
      syncedPricing[localId][rawModelId] = rate;
      if (shortId !== rawModelId && !syncedPricing[localId][shortId]) {
        syncedPricing[localId][shortId] = rate;
      }
    }

    const declared = {};
    for (const inp of model?.modalities?.input || []) {
      const k = MODALITY_BY_INPUT[inp];
      if (k) declared[k] = true;
    }
    if (Object.keys(declared).length) {
      capModels[`${localId}:${shortId.toLowerCase()}`] = declared;
    }

    const ctx = Number(model?.limit?.context || 0);
    const out = Number(model?.limit?.output || 0);
    if (ctx > 0 || out > 0) {
      capProviders[localId] ??= {};
      capProviders[localId][shortId] = {
        ...(ctx > 0 ? { contextWindow: ctx } : {}),
        ...(out > 0 ? { maxOutput: out } : {}),
      };
    }

    if (!seenCatalog[localId].has(rawModelId)) {
      seenCatalog[localId].add(rawModelId);
      syncedCatalog[localId].push({
        id: rawModelId,
        name: model?.name || shortId,
        kind: inferModelKind(rawModelId, model),
        contextWindow: ctx || null,
        maxOutput: out || null,
        vision: !!declared.vision,
        reasoning: !!model?.reasoning,
        releaseDate: model?.release_date || null,
      });
    }
  }

  // 1. Google AI Studio (google -> gemini)
  for (const [rawModelId, model] of Object.entries(catalog?.google?.models || {})) {
    recordModel("gemini", rawModelId, model);
  }

  // 2. Google Vertex AI (google-vertex -> split first-party Google models into vertex, third-party into vertex-partner)
  for (const [rawModelId, model] of Object.entries(catalog?.["google-vertex"]?.models || {})) {
    const target = GOOGLE_FIRST_PARTY_RE.test(rawModelId) ? "vertex" : "vertex-partner";
    recordModel(target, rawModelId, model);
  }

  // 3. Google Vertex Anthropic (google-vertex-anthropic -> vertex-partner)
  for (const [rawModelId, model] of Object.entries(catalog?.["google-vertex-anthropic"]?.models || {})) {
    recordModel("vertex-partner", rawModelId, model);
  }

  // 4. Additional Vertex Partner MaaS pricing fallback from vendor catalogs
  for (const vendor of PARTNER_VENDOR_PROVIDERS) {
    const prov = catalog?.[vendor];
    if (!prov?.models) continue;
    for (const [rawModelId, model] of Object.entries(prov.models)) {
      if (!/^(claude-|deepseek-v3|qwen3-|glm-5)/i.test(rawModelId)) continue;
      const rate = normalizeRate(model?.cost);
      if (rate && !syncedPricing["vertex-partner"][rawModelId]) {
        syncedPricing["vertex-partner"][rawModelId] = rate;
      }
    }
  }

  // Sort synced catalog newest-first, then alphabetically
  for (const list of Object.values(syncedCatalog)) {
    list.sort((a, b) => {
      const da = a.releaseDate || "";
      const db = b.releaseDate || "";
      if (da !== db) return db.localeCompare(da);
      return a.id.localeCompare(b.id);
    });
  }

  return { syncedPricing, syncedCatalog, capModels, capProviders };
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, contents, "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

export async function syncModelCatalog({ force = false } = {}) {
  if (syncState.running) return { status: "running" };
  syncState.running = true;
  try {
    const headers = { accept: "application/json" };
    if (!force && syncState.etag) headers["if-none-match"] = syncState.etag;

    const response = await fetchProviderUpstream(CATALOG_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 304) {
      syncState.lastSync = Date.now();
      syncState.lastError = null;
      syncState.lastResult = { status: "unchanged" };
      return syncState.lastResult;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from models.dev`);
    }

    const catalog = await response.json();
    const etag = response.headers.get("etag") || null;
    const { syncedPricing, syncedCatalog, capModels, capProviders } = extractPricingAndCapabilities(catalog);

    await Promise.all([
      saveSyncedPricing(syncedPricing, { source: CATALOG_URL, etag }),
      saveSyncedCatalog(syncedCatalog),
    ]);

    try {
      const serialized = JSON.stringify({
        v: CATALOG_VERSION,
        etag,
        syncedAt: Date.now(),
        models: capModels,
        providers: capProviders,
      });
      writeAtomic(CATALOG_FILE, serialized);
      invalidateCatalog();
    } catch {
      // Non-fatal if catalog file path isn't writable
    }

    const counts = {
      vertex: syncedCatalog.vertex.length,
      gemini: syncedCatalog.gemini.length,
      "vertex-partner": syncedCatalog["vertex-partner"].length,
    };

    syncState.etag = etag;
    syncState.lastSync = Date.now();
    syncState.lastError = null;
    syncState.lastResult = { status: "updated", counts, totalModels: counts.vertex + counts.gemini + counts["vertex-partner"] };

    jsonLogger.info("catalog.synced", syncState.lastResult);
    return syncState.lastResult;
  } catch (error) {
    syncState.lastError = error?.message || String(error);
    jsonLogger.warn("catalog.sync_failed", { error: syncState.lastError });
    return { status: "error", error: syncState.lastError };
  } finally {
    await installCatalogSource().catch(() => {});
    syncState.running = false;
  }
}

export function startModelCatalogSync() {
  if (syncState.timer) return;
  if (String(process.env.MODEL_CATALOG_SYNC || "").toLowerCase() === "off") return;

  const schedule = (delay) => {
    syncState.timer = setTimeout(async () => {
      const result = await syncModelCatalog();
      schedule(result?.status === "error" ? RETRY_DELAY_MS : SYNC_INTERVAL_MS);
    }, delay);
    syncState.timer.unref?.();
  };
  schedule(STARTUP_DELAY_MS);
}
