/**
 * AES-256-GCM Encryption-at-Rest Vault with AAD and Startup Canary.
 *
 * Ciphertext wire format:
 *   enc:v1:<iv_12B_b64>:<authTag_16B_b64>:<ciphertext_b64>
 *
 * AAD binds ciphertext to `<tableName>:<recordId>:<fieldName>` to prevent
 * cross-row or cross-column ciphertext swapping.
 */

import crypto from "node:crypto";
import { getEncryptionKeyBuffer } from "@/lib/config/env.js";

const PREFIX = "enc:v1:";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const CANARY_KEY = "vault_canary";
const CANARY_AAD = "_meta:vault_canary:value";
const CANARY_PLAINTEXT = "9router-vault-ok";

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptField(plaintext, aad) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return plaintext;
  const str = typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext);
  if (isEncrypted(str)) return str;

  const key = getEncryptionKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  if (aad) cipher.setAAD(Buffer.from(String(aad), "utf8"));

  const ciphertext = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptField(value, aad) {
  if (value === null || value === undefined || value === "") return value;
  if (typeof value !== "string" || !isEncrypted(value)) return value;

  const body = value.slice(PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new Error("Vault decryption error: malformed ciphertext envelope");
  }

  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Vault decryption error: invalid IV or authTag length");
  }

  const key = getEncryptionKeyBuffer();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  if (aad) decipher.setAAD(Buffer.from(String(aad), "utf8"));
  decipher.setAuthTag(authTag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * Verify the startup Vault Canary in config.sqlite.
 * Creates the canary on first boot; exits fail-closed on mismatch.
 */
export function verifyOrInitVaultCanary(configDb) {
  const row = configDb.get("SELECT value FROM _meta WHERE key = ?", [CANARY_KEY]);
  if (!row?.value) {
    const encrypted = encryptField(CANARY_PLAINTEXT, CANARY_AAD);
    configDb.run(
      "INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [CANARY_KEY, encrypted]
    );
    return true;
  }

  try {
    const decrypted = decryptField(row.value, CANARY_AAD);
    if (decrypted !== CANARY_PLAINTEXT) {
      throw new Error("Canary plaintext mismatch");
    }
    return true;
  } catch (err) {
    const msg = `[FATAL][VAULT] Vault Canary verification failed — ENCRYPTION_KEY does not match config.sqlite (${err.message})`;
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Mask a secret string for UI/API display without leaking sensitive material.
 */
export function maskSecret(secret) {
  if (!secret || typeof secret !== "string") return "";
  const trimmed = secret.trim();
  if (!trimmed) return "";

  // GCP Service Account JSON -> show only client_email
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.client_email) return `sa:${parsed.client_email}`;
      if (parsed.type === "authorized_user") return "adc:authorized_user";
    } catch {
      // fall through
    }
    return "json:***[redacted]";
  }

  if (trimmed.length <= 10) return "****";
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

// Sensitive fields inside providerConnections extra JSON
export const CONNECTION_SECRET_FIELDS = [
  "apiKey",
  "accessToken",
  "refreshToken",
  "idToken",
];

// Sensitive nested fields inside providerSpecificData
export const PROVIDER_SPECIFIC_SECRET_FIELDS = [
  "awsSecretAccessKey",
  "secretAccessKey",
  "awsSessionToken",
  "sessionToken",
  "clientSecret",
  "apiKey",
];

export function encryptConnectionSecrets(recordId, dataObj) {
  if (!dataObj || typeof dataObj !== "object") return dataObj;
  const copy = { ...dataObj };
  for (const field of CONNECTION_SECRET_FIELDS) {
    if (typeof copy[field] === "string" && copy[field]) {
      copy[field] = encryptField(copy[field], `providerConnections:${recordId}:${field}`);
    }
  }
  if (copy.providerSpecificData && typeof copy.providerSpecificData === "object") {
    const psd = { ...copy.providerSpecificData };
    for (const field of PROVIDER_SPECIFIC_SECRET_FIELDS) {
      if (typeof psd[field] === "string" && psd[field]) {
        psd[field] = encryptField(psd[field], `providerConnections:${recordId}:psd.${field}`);
      }
    }
    copy.providerSpecificData = psd;
  }
  return copy;
}

export function decryptConnectionSecrets(recordId, dataObj) {
  if (!dataObj || typeof dataObj !== "object") return dataObj;
  const copy = { ...dataObj };
  for (const field of CONNECTION_SECRET_FIELDS) {
    if (typeof copy[field] === "string" && isEncrypted(copy[field])) {
      copy[field] = decryptField(copy[field], `providerConnections:${recordId}:${field}`);
    }
  }
  if (copy.providerSpecificData && typeof copy.providerSpecificData === "object") {
    const psd = { ...copy.providerSpecificData };
    for (const field of PROVIDER_SPECIFIC_SECRET_FIELDS) {
      if (typeof psd[field] === "string" && isEncrypted(psd[field])) {
        psd[field] = decryptField(psd[field], `providerConnections:${recordId}:psd.${field}`);
      }
    }
    copy.providerSpecificData = psd;
  }
  return copy;
}

export function encryptNodeSecrets(nodeId, dataObj) {
  if (!dataObj || typeof dataObj !== "object") return dataObj;
  const copy = { ...dataObj };
  if (copy.apiKey && typeof copy.apiKey === "string") {
    copy.apiKey = encryptField(copy.apiKey, `providerNodes:${nodeId}:apiKey`);
  }
  if (copy.customHeaders && typeof copy.customHeaders === "object") {
    const encHeaders = {};
    for (const [k, v] of Object.entries(copy.customHeaders)) {
      if (/auth|key|token|secret|cookie/i.test(k) && typeof v === "string" && v) {
        encHeaders[k] = encryptField(v, `providerNodes:${nodeId}:header.${k.toLowerCase()}`);
      } else {
        encHeaders[k] = v;
      }
    }
    copy.customHeaders = encHeaders;
  }
  return copy;
}

export function decryptNodeSecrets(nodeId, dataObj) {
  if (!dataObj || typeof dataObj !== "object") return dataObj;
  const copy = { ...dataObj };
  if (typeof copy.apiKey === "string" && isEncrypted(copy.apiKey)) {
    copy.apiKey = decryptField(copy.apiKey, `providerNodes:${nodeId}:apiKey`);
  }
  if (copy.customHeaders && typeof copy.customHeaders === "object") {
    const decHeaders = {};
    for (const [k, v] of Object.entries(copy.customHeaders)) {
      if (typeof v === "string" && isEncrypted(v)) {
        decHeaders[k] = decryptField(v, `providerNodes:${nodeId}:header.${k.toLowerCase()}`);
      } else {
        decHeaders[k] = v;
      }
    }
    copy.customHeaders = decHeaders;
  }
  return copy;
}
