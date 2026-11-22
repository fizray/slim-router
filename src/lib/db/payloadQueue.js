/**
 * Main-thread bridge to payloadWorker.js (node:worker_threads).
 * Keeps payload sanitization & gzip compression off the streaming SSE event loop.
 * Falls back to inline write if worker_threads cannot resolve the worker file
 * (e.g. bundled edge/test environments).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import { getDbPaths } from "./paths.js";
import { getPayloadsDb } from "./driver.js";
import { stripMediaAndRedact, compressPayloadField } from "./payloadWorker.js";

function getWorkerState() {
  if (!globalThis.__9r_payloadWorker) {
    globalThis.__9r_payloadWorker = {
      worker: null,
      disabled: false,
      flushResolvers: new Map(),
      seq: 0,
      shutdownHooked: false,
    };
  }
  return globalThis.__9r_payloadWorker;
}

function resolveWorkerPath() {
  const candidates = [
    path.join(process.cwd(), "src", "lib", "db", "payloadWorker.js"),
    path.join(process.cwd(), ".next", "standalone", "src", "lib", "db", "payloadWorker.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function ensureWorker() {
  const st = getWorkerState();
  if (st.worker || st.disabled) return st.worker;

  const workerPath = resolveWorkerPath();
  if (!workerPath) {
    st.disabled = true;
    return null;
  }

  try {
    const { payloadsDbFile } = getDbPaths();
    const worker = new Worker(workerPath, {
      workerData: { dbFile: payloadsDbFile },
    });
    worker.unref();
    worker.on("message", (msg) => {
      if (msg?.type === "flushed" && st.flushResolvers.has(msg.id)) {
        const resolve = st.flushResolvers.get(msg.id);
        st.flushResolvers.delete(msg.id);
        resolve();
      }
    });
    worker.on("error", () => {
      st.worker = null;
      st.disabled = true;
    });
    worker.on("exit", () => {
      st.worker = null;
    });
    st.worker = worker;

    if (!st.shutdownHooked) {
      st.shutdownHooked = true;
      const graceful = () => {
        try { st.worker?.postMessage({ type: "flush_and_close" }); } catch {}
      };
      process.once("SIGINT", graceful);
      process.once("SIGTERM", graceful);
    }

    return worker;
  } catch {
    st.disabled = true;
    return null;
  }
}

async function writeInlineFallback(item) {
  const db = await getPayloadsDb();
  const mediaManifest = [];
  const cReq = compressPayloadField(item.clientRequest, mediaManifest);
  const uReq = compressPayloadField(item.upstreamRequest, mediaManifest);
  const uRes = compressPayloadField(item.upstreamResponse, mediaManifest);
  const cRes = compressPayloadField(item.clientResponse, mediaManifest);
  const cleanHeaders = item.clientHeaders ? stripMediaAndRedact(item.clientHeaders, []) : null;

  const rawBytes = cReq.rawBytes + uReq.rawBytes + uRes.rawBytes + cRes.rawBytes;
  const compressedBytes = cReq.compressedBytes + uReq.compressedBytes + uRes.compressedBytes + cRes.compressedBytes;

  db.run(
    `INSERT INTO trace_payloads (
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
      compressed_bytes = excluded.compressed_bytes`,
    [
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
      compressedBytes,
    ]
  );
}

/**
 * Enqueue a trace payload snapshot for non-blocking sanitization + gzip persistence.
 */
export function enqueueTracePayload(payload) {
  if (!payload?.traceId) return;
  const worker = ensureWorker();
  if (worker) {
    try {
      worker.postMessage({ type: "enqueue", payload });
      return;
    } catch {
      // fall through to inline
    }
  }
  writeInlineFallback(payload).catch(() => {});
}

export async function flushPayloadWorker() {
  const st = getWorkerState();
  if (!st.worker) return;
  const id = ++st.seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      st.flushResolvers.delete(id);
      resolve();
    }, 3000);
    st.flushResolvers.set(id, () => {
      clearTimeout(t);
      resolve();
    });
    st.worker.postMessage({ type: "flush", id });
  });
}

function decompressGzBlob(blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const json = zlib.gunzipSync(buf).toString("utf8");
    try {
      return JSON.parse(json);
    } catch {
      return json;
    }
  } catch {
    return null;
  }
}

export async function getTracePayloadById(traceId) {
  await flushPayloadWorker();
  const db = await getPayloadsDb();
  const row = db.get("SELECT * FROM trace_payloads WHERE trace_id = ?", [traceId]);
  if (!row) return null;
  return {
    traceId: row.trace_id,
    epochMs: row.epoch_ms,
    timestamp: row.timestamp,
    encoding: row.encoding,
    clientHeaders: row.client_headers_json ? JSON.parse(row.client_headers_json) : null,
    clientRequest: decompressGzBlob(row.client_request_gz),
    upstreamRequest: decompressGzBlob(row.upstream_request_gz),
    upstreamResponse: decompressGzBlob(row.upstream_response_gz),
    clientResponse: decompressGzBlob(row.client_response_gz),
    mediaManifest: row.media_manifest_json ? JSON.parse(row.media_manifest_json) : [],
    rawBytes: row.raw_bytes,
    compressedBytes: row.compressed_bytes,
  };
}
