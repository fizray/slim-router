/**
 * Structured JSON stdout logger with automatic credential, header & ?key= redaction.
 */

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|x-goog-api-key|cookie|set-cookie|x-9r-peer-token|x-9r-cli-token|proxy-authorization)$/i;
const SECRET_VALUE_RE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-9r_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g;

export function redactUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
  try {
    const u = new URL(rawUrl);
    for (const param of ["key", "api_key", "apikey", "access_token", "token", "secret"]) {
      if (u.searchParams.has(param)) {
        u.searchParams.set(param, "[REDACTED]");
      }
    }
    if (u.password) u.password = "[REDACTED]";
    return u.toString();
  } catch {
    return rawUrl.replace(/([?&](?:key|api_key|apikey|access_token|token|secret)=)[^&\s]+/gi, "$1[REDACTED]");
  }
}

export function redactString(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(SECRET_VALUE_RE, "[REDACTED]")
    .replace(/([?&](?:key|api_key|apikey|access_token|token|secret)=)[^&\s"'`]+/gi, "$1[REDACTED]");
}

export function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const out = {};
  for (const [k, v] of entries) {
    if (SENSITIVE_HEADER_RE.test(k) || /secret|token|password|api[-_]?key/i.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = typeof v === "string" ? redactString(v) : v;
    }
  }
  return out;
}

function sanitizeValue(val, depth = 0) {
  if (depth > 6) return "[MAX_DEPTH]";
  if (val === null || val === undefined) return val;
  if (typeof val === "string") return redactString(val);
  if (typeof val === "number" || typeof val === "boolean") return val;
  if (val instanceof Error) {
    return { name: val.name, message: redactString(val.message) };
  }
  if (Array.isArray(val)) {
    return val.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (/^(apiKey|api_key|accessToken|refreshToken|password|secret|private_key|authorization|cookie)$/i.test(k)) {
        out[k] = "[REDACTED]";
      } else if (/url$/i.test(k) && typeof v === "string") {
        out[k] = redactUrl(v);
      } else {
        out[k] = sanitizeValue(v, depth + 1);
      }
    }
    return out;
  }
  return String(val);
}

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel() {
  const configured = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LOG_LEVELS[configured] ?? LOG_LEVELS.info;
}

export function emitLog(level, event, fields = {}) {
  const numeric = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (numeric < minLevel()) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeValue(fields),
  };

  const line = JSON.stringify(entry);
  if (numeric >= LOG_LEVELS.error) {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const jsonLogger = {
  debug: (event, fields) => emitLog("debug", event, fields),
  info: (event, fields) => emitLog("info", event, fields),
  warn: (event, fields) => emitLog("warn", event, fields),
  error: (event, fields) => emitLog("error", event, fields),
};

export default jsonLogger;
