/**
 * Worker Thread for off-main-thread payload sanitization, multimodal binary
 * stripping (replaced with { _media: true, mimeType, bytes, sha256 }),
 * gzip compression, and batched writes to payloads.sqlite (forever retention).
 */

import { parentPort, workerData } from "node:worker_threads";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const DATA_URI_RE = /^data:([^;,]+);base64,([\s\S]+)$/;
const SECRET_RE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-9r_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g;
const QUERY_SECRET_RE = /([?&](?:key|api_key|apikey|access_token|token|secret)=)[^&\s"'`]+/gi;

function hashBase64(b64) {
  const buf = Buffer.from(b64, "base64");
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  return { bytes: buf.length, sha256 };
}

function redactText(str) {
  if (typeof str !== "string") return str;
  return str.replace(SECRET_RE, "[REDACTED]").replace(QUERY_SECRET_RE, "$1[REDACTED]");
}

function stripMediaAndRedact(val, mediaManifest, depth = 0) {
  if (depth > 16 || val === null || val === undefined) return val;

  if (typeof val === "string") {
    if (val.length > 128 && val.startsWith("data:")) {
      const m = val.match(DATA_URI_RE);
      if (m) {
        const mimeType = m[1];
        const { bytes, sha256 } = hashBase64(m[2]);
        const meta = { _media: true, mimeType, bytes, sha256 };
        mediaManifest.push(meta);
        return meta;
      }
    }
    return redactText(val);
  }

  if (typeof val !== "object") return val;

  if (Array.isArray(val)) {
    return val.map((item) => stripMediaAndRedact(item, mediaManifest, depth + 1));
  }

  // Gemini / Vertex inlineData or inline_data
  if (typeof val.data === "string" && val.data.length > 128 && (val.mimeType || val.mime_type)) {
    const mimeType = val.mimeType || val.mime_type;
    const { bytes, sha256 } = hashBase64(val.data);
    const meta = { _media: true, mimeType, bytes, sha256 };
    mediaManifest.push(meta);
    return { ...val, data: meta };
  }

  // Anthropic base64 image/document source: { type: "base64", media_type, data }
  if (val.type === "base64" && typeof val.data === "string" && val.data.length > 128) {
    const mimeType = val.media_type || "application/octet-stream";
    const { bytes, sha256 } = hashBase64(val.data);
    const meta = { _media: true, mimeType, bytes, sha256 };
    mediaManifest.push(meta);
    return { ...val, data: meta };
  }

  // OpenAI input_audio: { data, format }
  if (typeof val.data === "string" && val.data.length > 128 && typeof val.format === "string" && /^(wav|mp3|ogg|flac|m4a|pcm16)$/i.test(val.format)) {
    const mimeType = `audio/${val.format.toLowerCase()}`;
    const { bytes, sha256 } = hashBase64(val.data);
    const meta = { _media: true, mimeType, bytes, sha256 };
    mediaManifest.push(meta);
    return { ...val, data: meta };
  }

  // OpenAI image response b64_json
  if (typeof val.b64_json === "string" && val.b64_json.length > 128) {
    const { bytes, sha256 } = hashBase64(val.b64_json);
    const meta = { _media: true, mimeType: "image/png", bytes, sha256 };
    mediaManifest.push(meta);
    return { ...val, b64_json: meta };
  }

  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (/^(authorization|x-api-key|x-goog-api-key|cookie|set-cookie|apiKey|accessToken|refreshToken|password|private_key)$/i.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = stripMediaAndRedact(v, mediaManifest, depth + 1);
    }
  }
  return out;
}

function compressPayloadField(obj, mediaManifest) {
  if (obj === null || obj === undefined) return { gz: null, rawBytes: 0, compressedBytes: 0 };
  const sanitized = stripMediaAndRedact(obj, mediaManifest);
  const json = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  const rawBuf = Buffer.from(json, "utf8");
  const gz = zlib.gzipSync(rawBuf, { level: 6 });
  return { gz, rawBytes: rawBuf.length, compressedBytes: gz.length };
}

function initDb(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 5000;
  `);
  const insertStmt = db.prepare(`
    INSERT INTO trace_payloads (
      trace_id, epoch_ms, timestamp, encoding,
      client_headers_json, client_request_gz, upstream_request_gz,
      upstream_response_gz, client_response_gz, media_manifest_json,
      raw_bytes, compressed_bytes
    ) VALUES (?, ?, ?, 'gzip', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trace_id) DO UPDATE SET
      client_headers_json = COALESCE(excluded.client_headers_json, trace_payloads.client_headers_json),
      client_request_gz = COALESCE(excluded.client_request_gz, trace_payloads.client_request_gz),
      upstream_request_gz = COALESCE(excluded.upstream_request_gz, trace_payloads.upstream_request_gz),
      upstream_response_gz = COALESCE(excluded.upstream_response_gz, trace_payloads.upstream_response_gz),
      client_response_gz = COALESCE(excluded.client_response_gz, trace_payloads.client_response_gz),
      media_manifest_json = COALESCE(excluded.media_manifest_json, trace_payloads.media_manifest_json),
      raw_bytes = excluded.raw_bytes,
      compressed_bytes = excluded.compressed_bytes
  `);
  return { db, insertStmt };
}

if (parentPort && workerData?.dbFile) {
  const { db, insertStmt } = initDb(workerData.dbFile);
  const batch = [];
  const FLUSH_INTERVAL_MS = 500;
  const MAX_BATCH_SIZE = 25;

  function flushBatch() {
    if (batch.length === 0) return;
    const items = batch.splice(0, batch.length);
    db.exec("BEGIN");
    try {
      for (const item of items) {
        const mediaManifest = [];
        const cReq = compressPayloadField(item.clientRequest, mediaManifest);
        const uReq = compressPayloadField(item.upstreamRequest, mediaManifest);
        const uRes = compressPayloadField(item.upstreamResponse, mediaManifest);
        const cRes = compressPayloadField(item.clientResponse, mediaManifest);

        const rawBytes = cReq.rawBytes + uReq.rawBytes + uRes.rawBytes + cRes.rawBytes;
        const compressedBytes = cReq.compressedBytes + uReq.compressedBytes + uRes.compressedBytes + cRes.compressedBytes;

        const cleanHeaders = item.clientHeaders ? stripMediaAndRedact(item.clientHeaders, []) : null;

        insertStmt.run(
          item.traceId,
          item.epochMs || Date.now(),
          item.timestamp || new Date().toISOString(),
          cleanHeaders ? JSON.stringify(cleanHeaders) : null,
          cReq.gz,
          uReq.gz,
          uRes.gz,
          cRes.gz,
          mediaManifest.length > 0 ? JSON.stringify(mediaManifest) : null,
          rawBytes,
          compressedBytes
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      parentPort.postMessage({ type: "error", message: err.message });
    }
  }

  const timer = setInterval(flushBatch, FLUSH_INTERVAL_MS);

  parentPort.on("message", (msg) => {
    if (!msg) return;
    if (msg.type === "enqueue") {
      batch.push(msg.payload);
      if (batch.length >= MAX_BATCH_SIZE) flushBatch();
    } else if (msg.type === "flush") {
      flushBatch();
      parentPort.postMessage({ type: "flushed", id: msg.id });
    } else if (msg.type === "flush_and_close") {
      clearInterval(timer);
      flushBatch();
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      try { db.close(); } catch {}
      parentPort.postMessage({ type: "closed" });
      process.exit(0);
    }
  });
}

// Export pure helper for direct fallback / unit testing
export { stripMediaAndRedact, compressPayloadField };
