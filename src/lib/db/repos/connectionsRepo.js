import { v4 as uuidv4 } from "uuid";
import { getConfigDb } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  encryptConnectionSecrets,
  decryptConnectionSecrets,
  maskSecret,
  CONNECTION_SECRET_FIELDS,
  PROVIDER_SPECIFIC_SECRET_FIELDS,
} from "@/lib/crypto/vault.js";

const MODEL_LOCK_PREFIX = "modelLock_";

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;
  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };
  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null;
  }
  return normalized;
}

function rowToConn(row) {
  if (!row) return null;
  const rawExtra = parseJson(row.data, {});
  const extra = decryptConnectionSecrets(row.id, rawExtra);
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  const encryptedRest = encryptConnectionSecrets(id, rest);
  return {
    id,
    provider,
    authType: authType || "apikey",
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(encryptedRest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

/**
 * Strip/mask all plaintext secrets before returning a connection to any HTTP API.
 */
export function maskConnectionForApi(conn) {
  if (!conn) return null;
  const out = { ...conn };
  let hasSecret = false;

  for (const field of CONNECTION_SECRET_FIELDS) {
    if (out[field]) {
      hasSecret = true;
      if (field === "apiKey") {
        out.apiKeyMasked = maskSecret(out[field]);
      }
      delete out[field];
    }
  }

  if (out.providerSpecificData && typeof out.providerSpecificData === "object") {
    const psd = { ...out.providerSpecificData };
    for (const field of PROVIDER_SPECIFIC_SECRET_FIELDS) {
      if (psd[field]) {
        hasSecret = true;
        psd[`${field}Masked`] = maskSecret(psd[field]);
        delete psd[field];
      }
    }
    out.providerSpecificData = psd;
  }

  out.hasSecret = hasSecret;
  return out;
}

export async function getProviderConnections(filter = {}) {
  const db = await getConfigDb();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getConfigDb();
  const row = db.get("SELECT * FROM providerConnections WHERE id = ?", [id]);
  return rowToConn(row);
}

function reorderInTx(db, providerId) {
  const rows = db.all("SELECT * FROM providerConnections WHERE provider = ? ORDER BY priority ASC, createdAt ASC", [providerId]);
  rows.forEach((row, idx) => {
    db.run("UPDATE providerConnections SET priority = ? WHERE id = ?", [idx + 1, row.id]);
  });
}

export async function createProviderConnection(data) {
  const db = await getConfigDb();
  const now = new Date().toISOString();
  let created;

  db.transaction(() => {
    const maxRow = db.get("SELECT MAX(priority) as maxP FROM providerConnections WHERE provider = ?", [data.provider]);
    const nextPriority = data.priority ?? ((maxRow?.maxP || 0) + 1);
    const id = data.id || uuidv4();
    created = {
      ...data,
      id,
      provider: data.provider,
      authType: data.authType || "apikey",
      name: data.name || data.displayName || `${data.provider}-${id.slice(0, 6)}`,
      priority: nextPriority,
      isActive: data.isActive !== false,
      testStatus: data.testStatus || "active",
      createdAt: now,
      updatedAt: now,
    };
    upsert(db, created);
  });

  return created;
}

export async function updateProviderConnection(id, patch) {
  const db = await getConfigDb();
  let updated = null;

  db.transaction(() => {
    const row = db.get("SELECT * FROM providerConnections WHERE id = ?", [id]);
    if (!row) return;
    const existing = rowToConn(row);
    const normalizedPatch = resetHealthStateOnActivation(existing, patch);
    const merged = {
      ...existing,
      ...normalizedPatch,
      id,
      updatedAt: new Date().toISOString(),
    };
    // Preserve existing secrets if patch sent empty string/undefined
    for (const field of CONNECTION_SECRET_FIELDS) {
      if (normalizedPatch[field] === "" || normalizedPatch[field] === undefined) {
        if (existing[field]) merged[field] = existing[field];
      }
    }
    if (normalizedPatch.providerSpecificData && existing.providerSpecificData) {
      merged.providerSpecificData = {
        ...existing.providerSpecificData,
        ...normalizedPatch.providerSpecificData,
      };
      for (const field of PROVIDER_SPECIFIC_SECRET_FIELDS) {
        if (!normalizedPatch.providerSpecificData[field] && existing.providerSpecificData[field]) {
          merged.providerSpecificData[field] = existing.providerSpecificData[field];
        }
      }
    }
    for (const key of Object.keys(merged)) {
      if (key.startsWith(MODEL_LOCK_PREFIX) && merged[key] === null) {
        delete merged[key];
      }
    }
    upsert(db, merged);
    updated = merged;
  });

  return updated;
}

export async function deleteProviderConnection(id) {
  const db = await getConfigDb();
  let removed = null;
  db.transaction(() => {
    const row = db.get("SELECT * FROM providerConnections WHERE id = ?", [id]);
    if (!row) return;
    removed = rowToConn(row);
    db.run("DELETE FROM providerConnections WHERE id = ?", [id]);
    reorderInTx(db, removed.provider);
  });
  return removed;
}

export async function deleteProviderConnectionsByProvider(provider) {
  const db = await getConfigDb();
  const res = db.run("DELETE FROM providerConnections WHERE provider = ?", [provider]);
  return res.changes;
}

export async function reorderProviderConnections(provider, orderedIds = []) {
  const db = await getConfigDb();
  db.transaction(() => {
    orderedIds.forEach((id, idx) => {
      db.run("UPDATE providerConnections SET priority = ?, updatedAt = ? WHERE id = ? AND provider = ?", [
        idx + 1,
        new Date().toISOString(),
        id,
        provider,
      ]);
    });
  });
  return getProviderConnections({ provider });
}

export async function cleanupProviderConnections() {
  return 0;
}
