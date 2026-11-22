/**
 * Hardened Client API Key utilities:
 * - Cryptographically random format: `sk-9r_<base64url(32 bytes)>` (no machineId)
 * - Zero plaintext storage: only `HMAC-SHA256(API_KEY_SECRET, rawKey)` + `key_hint`
 * - Constant-time verification with `crypto.timingSafeEqual`
 */

import crypto from "node:crypto";
import { getApiKeySecret } from "@/lib/config/env.js";

const KEY_PREFIX = "sk-9r_";

export function generateClientApiKey() {
  const randomPart = crypto.randomBytes(32).toString("base64url");
  const rawKey = `${KEY_PREFIX}${randomPart}`;
  const keyHash = hashApiKey(rawKey);
  const keyHint = buildKeyHint(rawKey);
  return { rawKey, keyHash, keyHint };
}

export function hashApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return "";
  const secret = getApiKeySecret();
  return crypto
    .createHmac("sha256", secret)
    .update(rawKey.trim())
    .digest("hex");
}

export function buildKeyHint(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return "sk-9r_****";
  const trimmed = rawKey.trim();
  if (trimmed.length <= 12) return `${trimmed.slice(0, 4)}...`;
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-4)}`;
}

export function verifyApiKeyHash(rawKey, storedHashHex) {
  if (!rawKey || !storedHashHex || typeof rawKey !== "string" || typeof storedHashHex !== "string") {
    return false;
  }
  const computed = hashApiKey(rawKey);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(storedHashHex, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
