import { v4 as uuidv4 } from "uuid";
import { getConfigDb } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { encryptNodeSecrets, decryptNodeSecrets, maskSecret } from "@/lib/crypto/vault.js";

function rowToNode(row) {
  if (!row) return null;
  const rawExtra = parseJson(row.data, {});
  const extra = decryptNodeSecrets(row.id, rawExtra);
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  const encryptedRest = encryptNodeSecrets(id, rest);
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(encryptedRest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt]
  );
}

export function maskNodeForApi(node) {
  if (!node) return null;
  const out = { ...node };
  if (out.apiKey) {
    out.apiKeyMasked = maskSecret(out.apiKey);
    out.hasSecret = true;
    delete out.apiKey;
  }
  if (out.customHeaders && typeof out.customHeaders === "object") {
    const masked = {};
    for (const [k, v] of Object.entries(out.customHeaders)) {
      masked[k] = /auth|key|token|secret|cookie/i.test(k) ? maskSecret(String(v || "")) : v;
    }
    out.customHeaders = masked;
  }
  return out;
}

export async function getProviderNodes(filter = {}) {
  const db = await getConfigDb();
  const where = [];
  const params = [];
  if (filter.type) { where.push("type = ?"); params.push(filter.type); }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.all(sql, params).map(rowToNode);
}

export async function getProviderNodeById(id) {
  const db = await getConfigDb();
  return rowToNode(db.get("SELECT * FROM providerNodes WHERE id = ?", [id]));
}

export async function createProviderNode(data) {
  const db = await getConfigDb();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    ...(data.apiKey ? { apiKey: data.apiKey } : {}),
    ...(data.customHeaders ? { customHeaders: data.customHeaders } : {}),
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, node);
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getConfigDb();
  let result = null;
  db.transaction(() => {
    const row = db.get("SELECT * FROM providerNodes WHERE id = ?", [id]);
    if (!row) return;
    const existing = rowToNode(row);
    const merged = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
    if (!data.apiKey && existing.apiKey) merged.apiKey = existing.apiKey;
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProviderNode(id) {
  const db = await getConfigDb();
  let removed = null;
  db.transaction(() => {
    const row = db.get("SELECT * FROM providerNodes WHERE id = ?", [id]);
    if (!row) return;
    removed = rowToNode(row);
    db.run("DELETE FROM providerNodes WHERE id = ?", [id]);
    db.run("DELETE FROM kv WHERE scope = 'customModels' AND key LIKE ?", [`${id}|%`]);
  });
  return removed;
}
