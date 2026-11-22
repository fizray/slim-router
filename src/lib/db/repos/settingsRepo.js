import bcrypt from "bcryptjs";
import { getConfigDb } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { isBuildPhase } from "@/lib/config/env.js";

const DEFAULT_SETTINGS = {
  requireLogin: true,
  requireApiKey: true,
  sessionVersion: 1,
  fallbackStrategy: "fill-first",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  globalDailyBudgetUsd: null,
  globalMonthlyBudgetUsd: null,
  providerOverrides: {},
};

// Explicit allow-list for PATCH /api/settings (prevents CWE-915 mass assignment)
export const MUTABLE_SETTING_KEYS = new Set([
  "fallbackStrategy",
  "stickyRoundRobinLimit",
  "providerStrategies",
  "comboStrategy",
  "comboStickyRoundRobinLimit",
  "comboStrategies",
  "globalDailyBudgetUsd",
  "globalMonthlyBudgetUsd",
  "providerOverrides",
]);

function getAuthStateCache() {
  if (!globalThis.__9r_authState) {
    globalThis.__9r_authState = { sessionVersion: null, ts: 0 };
  }
  return globalThis.__9r_authState;
}

export function invalidateAuthStateCache() {
  const st = getAuthStateCache();
  st.sessionVersion = null;
  st.ts = 0;
}

async function ensureBootstrapAdminPassword(db, current) {
  if (current?.password || isBuildPhase()) return current;

  const envHash = (process.env.ADMIN_PASSWORD_HASH || "").trim();
  const envPass = (process.env.ADMIN_PASSWORD || "").trim();

  let passwordHash = null;
  if (envHash) {
    passwordHash = envHash;
  } else if (envPass && envPass.length >= 12) {
    passwordHash = await bcrypt.hash(envPass, 12);
  } else {
    throw new Error(
      "[FATAL][AUTH] No admin password configured in config.sqlite. Set ADMIN_PASSWORD (>= 12 chars) or ADMIN_PASSWORD_HASH in environment."
    );
  }

  const next = {
    ...current,
    password: passwordHash,
    sessionVersion: current?.sessionVersion || 1,
    requireLogin: true,
    requireApiKey: true,
  };
  db.run(
    "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    [stringifyJson(next)]
  );
  return next;
}

async function readRaw() {
  const db = await getConfigDb();
  const row = db.get("SELECT data FROM settings WHERE id = 1");
  const parsed = row ? parseJson(row.data, {}) : {};
  return ensureBootstrapAdminPassword(db, parsed);
}

export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // Security invariants: never allow disabling dashboard auth or API key enforcement
  merged.requireLogin = true;
  merged.requireApiKey = true;
  if (!Number.isInteger(merged.sessionVersion) || merged.sessionVersion < 1) {
    merged.sessionVersion = 1;
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

export async function getCurrentSessionVersion() {
  const cache = getAuthStateCache();
  if (cache.sessionVersion !== null && Date.now() - cache.ts < 5000) {
    return cache.sessionVersion;
  }
  const settings = await getSettings();
  cache.sessionVersion = settings.sessionVersion;
  cache.ts = Date.now();
  return settings.sessionVersion;
}

export async function updateSettings(updates) {
  const db = await getConfigDb();
  let next;
  db.transaction(() => {
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    const current = row ? parseJson(row.data, {}) : {};
    next = {
      ...current,
      ...updates,
      requireLogin: true,
      requireApiKey: true,
    };
    db.run(
      "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      [stringifyJson(next)]
    );
  });
  invalidateAuthStateCache();
  return mergeWithDefaults(next);
}

export async function exportSettings() {
  return readRaw();
}
