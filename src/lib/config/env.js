/**
 * Build-safe, fail-closed runtime environment configuration & validation.
 * During `next build` (NEXT_PHASE === "phase-production-build"), validation
 * is skipped so production secrets are never required at image build time.
 * At runtime, calling `assertRuntimeEnv()` exits with code 1 on any violation.
 */

import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

export function isBuildPhase() {
  return (
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.NEXT_PHASE === "phase-export" ||
    process.env.SKIP_ENV_VALIDATION === "build"
  );
}

export function getDataDir() {
  return process.env.DATA_DIR || path.join(os.homedir(), ".9router");
}

/**
 * Decode ENCRYPTION_KEY (64-char hex or 44-char base64) to a 32-byte Buffer.
 * Returns null if invalid.
 */
export function parseEncryptionKey(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 32) return buf;
  } catch {
    return null;
  }
  return null;
}

export function getEncryptionKeyBuffer() {
  const buf = parseEncryptionKey(process.env.ENCRYPTION_KEY);
  if (!buf) {
    throw new Error("ENCRYPTION_KEY must be a valid 32-byte key (64 hex chars or 44-char base64)");
  }
  return buf;
}

export function getJwtSecret() {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (secret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters long");
  }
  return secret;
}

export function getApiKeySecret() {
  const secret = (process.env.API_KEY_SECRET || "").trim();
  if (secret.length < 32) {
    throw new Error("API_KEY_SECRET must be set and at least 32 characters long");
  }
  return secret;
}

export function getSessionTtlSeconds() {
  const hours = Number(process.env.SESSION_TTL_HOURS || 12);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) return 12 * 3600;
  return Math.round(hours * 3600);
}

export function getTrustedProxyList() {
  const raw = process.env.TRUSTED_PROXY_IPS;
  if (!raw || !raw.trim()) return ["127.0.0.1", "::1"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateWeakSecret(name, val) {
  const lowered = val.toLowerCase();
  const forbidden = [
    "change-me",
    "endpoint-proxy",
    "123456",
    "secret",
    "password",
    "default",
  ];
  if (forbidden.some((f) => lowered === f || lowered.startsWith(`${f}-`))) {
    return `${name} appears to be a placeholder/default value`;
  }
  return null;
}

/**
 * Validate all required runtime environment variables.
 * Throws or exits(1) fail-closed if anything is missing or weak.
 */
export function assertRuntimeEnv({ exitOnFailure = true } = {}) {
  if (isBuildPhase()) return { ok: true, skipped: "build" };
  if (globalThis.__9r_envValidated) return { ok: true, cached: true };

  const errors = [];

  const jwtSecret = (process.env.JWT_SECRET || "").trim();
  if (jwtSecret.length < 32) {
    errors.push("JWT_SECRET is required and must be at least 32 characters");
  } else {
    const weak = validateWeakSecret("JWT_SECRET", jwtSecret);
    if (weak) errors.push(weak);
  }

  const apiKeySecret = (process.env.API_KEY_SECRET || "").trim();
  if (apiKeySecret.length < 32) {
    errors.push("API_KEY_SECRET is required and must be at least 32 characters");
  } else {
    const weak = validateWeakSecret("API_KEY_SECRET", apiKeySecret);
    if (weak) errors.push(weak);
  }

  if (!parseEncryptionKey(process.env.ENCRYPTION_KEY)) {
    errors.push("ENCRYPTION_KEY is required and must be exactly 32 bytes (64 hex chars or 44-char base64)");
  }

  const adminPass = process.env.ADMIN_PASSWORD || "";
  const adminHash = process.env.ADMIN_PASSWORD_HASH || "";
  if (adminPass && adminPass.length < 12) {
    errors.push("ADMIN_PASSWORD must be at least 12 characters");
  }
  if (adminPass === "123456") {
    errors.push("ADMIN_PASSWORD cannot be the insecure default '123456'");
  }
  if (adminHash && !/^\$2[aby]\$\d{2}\$.{53}$/.test(adminHash)) {
    errors.push("ADMIN_PASSWORD_HASH must be a valid bcrypt hash");
  }

  if (errors.length > 0) {
    const msg = `[FATAL][ENV] Fail-closed startup validation failed:\n  - ${errors.join("\n  - ")}`;
    console.error(msg);
    if (exitOnFailure) {
      process.exit(1);
    }
    throw new Error(msg);
  }

  globalThis.__9r_envValidated = true;
  return { ok: true };
}

/**
 * Derive a deterministic non-secret key fingerprint (first 8 hex chars of SHA-256)
 * for diagnostics without ever exposing the key itself.
 */
export function getKeyFingerprint(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
}
