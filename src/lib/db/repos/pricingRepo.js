/**
 * 100% Database-Backed Dynamic Pricing Repository (ZERO hardcoded prices).
 *
 * Resolution order for getPricingForModel(provider, model):
 *   1. User manual override in config.sqlite (kv scope = 'pricing')
 *   2. Live synced pricing from models.dev in config.sqlite (kv scope = 'pricing_synced')
 *      - Exact provider + model match
 *      - Stripped vendor prefix match (e.g. "google/gemini-2.5-pro" -> "gemini-2.5-pro")
 *      - Cross-provider fallback between vertex <-> gemini for identical Gemini model IDs
 *   3. null (never silently uses stale hardcoded rates)
 */

import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const userPricingKv = makeKv("pricing");
const syncedPricingKv = makeKv("pricing_synced");
const syncedCatalogKv = makeKv("catalog_models");
const CACHE_TTL_MS = 5000;

function getCache() {
  return (globalThis.__9r_pricingCache ??= {
    merged: null,
    user: null,
    synced: null,
    catalog: null,
    catalogExpiresAt: 0,
    expiresAt: 0,
  });
}

function invalidate() {
  const c = getCache();
  c.merged = null;
  c.user = null;
  c.synced = null;
  c.catalog = null;
  c.catalogExpiresAt = 0;
  c.expiresAt = 0;
}

async function loadAll() {
  const c = getCache();
  const now = Date.now();
  if (c.merged && c.expiresAt > now) {
    return { user: c.user, synced: c.synced, merged: c.merged };
  }

  const [user, syncedRaw] = await Promise.all([
    userPricingKv.getAll(),
    syncedPricingKv.getAll(),
  ]);

  const { _meta: syncedMeta, ...synced } = syncedRaw || {};
  const merged = {};

  for (const [provider, models] of Object.entries(synced || {})) {
    if (!models || typeof models !== "object") continue;
    merged[provider] = {};
    for (const [model, rate] of Object.entries(models)) {
      merged[provider][model] = { ...rate, _source: "synced" };
    }
  }

  for (const [provider, models] of Object.entries(user || {})) {
    if (!models || typeof models !== "object") continue;
    if (!merged[provider]) merged[provider] = {};
    for (const [model, rate] of Object.entries(models)) {
      merged[provider][model] = {
        ...(merged[provider][model] || {}),
        ...rate,
        _source: "override",
      };
    }
  }

  c.user = user || {};
  c.synced = synced || {};
  c.syncedMeta = syncedMeta || null;
  c.merged = merged;
  c.expiresAt = now + CACHE_TTL_MS;
  return { user: c.user, synced: c.synced, syncedMeta: c.syncedMeta, merged: c.merged };
}

export async function getPricing() {
  const { merged } = await loadAll();
  return merged;
}

export async function getPricingDetails() {
  const { user, synced, syncedMeta, merged } = await loadAll();
  return {
    pricing: merged,
    overrides: user,
    synced,
    meta: syncedMeta || null,
  };
}

function lookupInMap(map, provider, model) {
  if (!map || !model) return null;
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  const candidates = [];
  if (provider) {
    candidates.push(provider);
    if (provider === "vx") candidates.push("vertex");
    if (provider === "vxp") candidates.push("vertex-partner");
    if (provider === "google" || provider === "aistudio") candidates.push("gemini");
    // Cross-lookup between vertex & gemini for shared Gemini models
    if (provider === "vertex" || provider === "vx") candidates.push("gemini");
    if (provider === "gemini") candidates.push("vertex");
  }

  for (const prov of candidates) {
    const provMap = map[prov];
    if (!provMap) continue;
    if (provMap[model]) return provMap[model];
    if (provMap[baseModel]) return provMap[baseModel];
  }

  // Fallback across any stored provider for exact model ID
  for (const provMap of Object.values(map)) {
    if (!provMap || typeof provMap !== "object") continue;
    if (provMap[model]) return provMap[model];
    if (provMap[baseModel]) return provMap[baseModel];
  }
  return null;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const { user, synced } = await loadAll();
  const userHit = lookupInMap(user, provider, model);
  if (userHit) return userHit;
  const syncedHit = lookupInMap(synced, provider, model);
  if (syncedHit) return syncedHit;
  return null;
}

export async function saveSyncedPricing(syncedByProvider, meta = {}) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(`DELETE FROM kv WHERE scope = 'pricing_synced'`);
    for (const [provider, models] of Object.entries(syncedByProvider || {})) {
      if (!models || typeof models !== "object" || Object.keys(models).length === 0) continue;
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing_synced', ?, ?)`,
        [provider, stringifyJson(models)]
      );
    }
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES('pricing_synced', '_meta', ?)`,
      [stringifyJson({ ...meta, syncedAt: Date.now() })]
    );
  });
  invalidate();
}

export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getPricing();
}

export async function saveSyncedCatalog(catalogByProvider) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(`DELETE FROM kv WHERE scope = 'catalog_models'`);
    for (const [provider, models] of Object.entries(catalogByProvider || {})) {
      if (!Array.isArray(models) || models.length === 0) continue;
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('catalog_models', ?, ?)`,
        [provider, stringifyJson(models)]
      );
    }
  });
  invalidate();
}

export async function getSyncedCatalog() {
  const c = getCache();
  const now = Date.now();
  if (c.catalog && c.catalogExpiresAt > now) return c.catalog;
  const raw = await syncedCatalogKv.getAll();
  const out = {};
  for (const [provider, list] of Object.entries(raw || {})) {
    if (Array.isArray(list)) out[provider] = list;
  }
  c.catalog = out;
  c.catalogExpiresAt = now + CACHE_TTL_MS;
  return out;
}

export async function resetAllPricing() {
  await userPricingKv.clear();
  invalidate();
  return await getPricing();
}
