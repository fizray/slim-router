/**
 * Zero-plaintext API Keys Repository with Governance (Allow-list, RPM/TPM, Daily/Monthly Budget, Expiry).
 * Stores ONLY `key_hash = HMAC-SHA256(API_KEY_SECRET, rawKey)` and `key_hint`.
 */

import { v4 as uuidv4 } from "uuid";
import { getConfigDb } from "../driver.js";
import { generateClientApiKey, hashApiKey, verifyApiKeyHash } from "@/shared/utils/apiKey.js";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

function rowToApiKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyHint: row.key_hint,
    name: row.name || "Unnamed Key",
    isActive: row.is_active === 1 || row.is_active === true,
    access: keyAccessFromColumns(row.access_restricted, row.access_allow),
    rpmLimit: row.rpm_limit ?? null,
    tpmLimit: row.tpm_limit ?? null,
    dailyBudgetUsd: row.daily_budget_usd ?? null,
    monthlyBudgetUsd: row.monthly_budget_usd ?? null,
    expiresAt: row.expires_at || null,
    lastUsedAt: row.last_used_at || null,
    createdAt: row.created_at,
  };
}

function normalizePositiveNumber(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeExpiresAt(val) {
  if (!val) return null;
  const ts = Date.parse(val);
  if (Number.isNaN(ts)) throw new Error("Invalid expiresAt timestamp");
  return new Date(ts).toISOString();
}

export async function getApiKeys() {
  const db = await getConfigDb();
  return db.all("SELECT * FROM apiKeys ORDER BY created_at DESC").map(rowToApiKey);
}

export async function getApiKeyById(id) {
  const db = await getConfigDb();
  return rowToApiKey(db.get("SELECT * FROM apiKeys WHERE id = ?", [id]));
}

/**
 * Authenticate a raw API key using HMAC-SHA256 lookup + constant-time verification.
 * Returns the full key record if valid, active, and unexpired — else null.
 */
export async function authenticateApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return null;
  const db = await getConfigDb();
  const keyHash = hashApiKey(rawKey);
  if (!keyHash) return null;

  const row = db.get("SELECT * FROM apiKeys WHERE key_hash = ?", [keyHash]);
  if (!row) return null;
  if (!verifyApiKeyHash(rawKey, row.key_hash)) return null;
  if (row.is_active !== 1) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

  // Non-blocking last_used_at touch (throttled to avoid hot writes on every request)
  const lastTouchMap = (globalThis.__9r_keyTouchCache ??= new Map());
  const now = Date.now();
  const prev = lastTouchMap.get(row.id) || 0;
  if (now - prev > 30_000) {
    lastTouchMap.set(row.id, now);
    try {
      db.run("UPDATE apiKeys SET last_used_at = ? WHERE id = ?", [new Date(now).toISOString(), row.id]);
    } catch {}
  }

  return rowToApiKey(row);
}

// Backward-compatible helpers
export async function getApiKeyByKey(rawKey) {
  return authenticateApiKey(rawKey);
}

export async function validateApiKey(rawKey) {
  const record = await authenticateApiKey(rawKey);
  return !!record;
}

/**
 * Create a new API key. Returns `{ ...record, key: rawKey }` ONCE.
 * The raw key is NEVER persisted in SQLite.
 */
export async function createApiKey(name, options = {}) {
  const db = await getConfigDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const { rawKey, keyHash, keyHint } = generateClientApiKey();

  let access = KEY_ACCESS_UNRESTRICTED;
  if (options.access !== undefined) {
    const checked = validateKeyAccessInput(options.access);
    if (!checked.ok) throw new Error(checked.error);
    access = checked.value;
  }
  const cols = keyAccessToColumns(access);

  const rpmLimit = normalizePositiveNumber(options.rpmLimit);
  const tpmLimit = normalizePositiveNumber(options.tpmLimit);
  const dailyBudgetUsd = normalizePositiveNumber(options.dailyBudgetUsd);
  const monthlyBudgetUsd = normalizePositiveNumber(options.monthlyBudgetUsd);
  const expiresAt = normalizeExpiresAt(options.expiresAt);

  db.run(
    `INSERT INTO apiKeys (
      id, key_hash, key_hint, name, is_active,
      access_restricted, access_allow,
      rpm_limit, tpm_limit, daily_budget_usd, monthly_budget_usd,
      expires_at, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      keyHash,
      keyHint,
      String(name || "API Key").trim().slice(0, 80),
      cols.accessRestricted,
      cols.accessAllow,
      rpmLimit ? Math.floor(rpmLimit) : null,
      tpmLimit ? Math.floor(tpmLimit) : null,
      dailyBudgetUsd,
      monthlyBudgetUsd,
      expiresAt,
      now,
    ]
  );

  const created = await getApiKeyById(id);
  return { ...created, key: rawKey };
}

export async function updateApiKey(id, updates = {}) {
  const db = await getConfigDb();
  const row = db.get("SELECT * FROM apiKeys WHERE id = ?", [id]);
  if (!row) return null;

  const sets = [];
  const params = [];

  if (updates.name !== undefined) {
    sets.push("name = ?");
    params.push(String(updates.name || "API Key").trim().slice(0, 80));
  }
  if (updates.isActive !== undefined) {
    sets.push("is_active = ?");
    params.push(updates.isActive ? 1 : 0);
  }
  if (updates.access !== undefined) {
    const checked = validateKeyAccessInput(updates.access);
    if (!checked.ok) throw new Error(checked.error);
    const cols = keyAccessToColumns(checked.value);
    sets.push("access_restricted = ?", "access_allow = ?");
    params.push(cols.accessRestricted, cols.accessAllow);
  }
  if (updates.rpmLimit !== undefined) {
    const v = normalizePositiveNumber(updates.rpmLimit);
    sets.push("rpm_limit = ?");
    params.push(v ? Math.floor(v) : null);
  }
  if (updates.tpmLimit !== undefined) {
    const v = normalizePositiveNumber(updates.tpmLimit);
    sets.push("tpm_limit = ?");
    params.push(v ? Math.floor(v) : null);
  }
  if (updates.dailyBudgetUsd !== undefined) {
    sets.push("daily_budget_usd = ?");
    params.push(normalizePositiveNumber(updates.dailyBudgetUsd));
  }
  if (updates.monthlyBudgetUsd !== undefined) {
    sets.push("monthly_budget_usd = ?");
    params.push(normalizePositiveNumber(updates.monthlyBudgetUsd));
  }
  if (updates.expiresAt !== undefined) {
    sets.push("expires_at = ?");
    params.push(normalizeExpiresAt(updates.expiresAt));
  }

  if (sets.length > 0) {
    params.push(id);
    db.run(`UPDATE apiKeys SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  return getApiKeyById(id);
}

export async function deleteApiKey(id) {
  const db = await getConfigDb();
  const res = db.run("DELETE FROM apiKeys WHERE id = ?", [id]);
  return res.changes > 0;
}
