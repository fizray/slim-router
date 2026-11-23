/**
 * Enterprise Telemetry, Rollup & Analytics Repository (`telemetry.sqlite`).
 *
 * Implements:
 * - Canonical token normalization: prompt_tokens = uncached_input + cached_read + cache_write
 * - Precision cost calculation (Input / Output / Reasoning / Cache Read / Cache Write + Net Cache Savings)
 * - Streaming-only TPOT & Output TPS (NULL for non-streaming / invalid denominator)
 * - Log-linear latency & TTFT histograms for fast p50/p95/p99 across arbitrary date ranges
 * - Atomic trace + span recording & NOT NULL-keyed hourly/daily rollup UPSERT
 * - All 5 Analytics query engines + API key budget window query
 */

import { getTelemetryDb } from "../driver.js";
import { getPricingForModel } from "./pricingRepo.js";

// Log-linear histogram bucket upper bounds in milliseconds (covers 10ms to >5min cleanly)
export const HISTOGRAM_BUCKETS_MS = [
  50, 100, 200, 350, 500, 750, 1000, 1500, 2000, 3000,
  5000, 7500, 10000, 15000, 20000, 30000, 45000, 60000,
  90000, 120000, 180000, 300000,
];

export function bucketForMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  for (const bound of HISTOGRAM_BUCKETS_MS) {
    if (ms <= bound) return String(bound);
  }
  return "inf";
}

export function incrementHistogram(histJson, ms) {
  let obj = {};
  if (histJson) {
    try { obj = typeof histJson === "string" ? JSON.parse(histJson) : { ...histJson }; } catch {}
  }
  const b = bucketForMs(ms);
  if (b !== null) {
    obj[b] = (obj[b] || 0) + 1;
  }
  return JSON.stringify(obj);
}

export function mergeHistograms(histList) {
  const merged = {};
  for (const raw of histList) {
    if (!raw) continue;
    let obj;
    try { obj = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { continue; }
    for (const [k, v] of Object.entries(obj)) {
      if (Number.isFinite(v) && v > 0) merged[k] = (merged[k] || 0) + v;
    }
  }
  return merged;
}

export function percentileFromHistogram(hist, p) {
  const total = Object.values(hist || {}).reduce((acc, v) => acc + v, 0);
  if (total === 0) return null;
  const target = Math.ceil((p / 100) * total);
  let cumulative = 0;
  let prevBound = 0;
  for (const bound of HISTOGRAM_BUCKETS_MS) {
    const count = hist[String(bound)] || 0;
    if (cumulative + count >= target) {
      // Linear interpolation within the bucket
      const frac = count > 0 ? (target - cumulative) / count : 1;
      return Math.round(prevBound + frac * (bound - prevBound));
    }
    cumulative += count;
    prevBound = bound;
  }
  return HISTOGRAM_BUCKETS_MS[HISTOGRAM_BUCKETS_MS.length - 1];
}

/**
 * Canonicalize token usage from any provider (OpenAI, Anthropic, Gemini/Vertex, Bedrock, Ollama).
 * Invariant guaranteed:
 *   prompt_tokens = uncached_input_tokens + cached_read_tokens + cache_write_tokens
 */
export function canonicalizeTokens(rawUsage = {}, provider = "") {
  if (!rawUsage || typeof rawUsage !== "object") {
    return {
      prompt_tokens: 0,
      uncached_input_tokens: 0,
      cached_read_tokens: 0,
      cache_write_tokens: 0,
      completion_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
    };
  }

  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

  const hasAnthropicCacheFields =
    rawUsage.cache_read_input_tokens !== undefined ||
    rawUsage.cache_creation_input_tokens !== undefined;

  const isAnthropicShape =
    hasAnthropicCacheFields ||
    (rawUsage.input_tokens !== undefined && rawUsage.input_tokens_details === undefined && /anthropic|claude|bedrock/i.test(provider));

  const completionTokens = n(rawUsage.completion_tokens ?? rawUsage.output_tokens ?? rawUsage.candidatesTokenCount);
  const reasoningTokens = n(
    rawUsage.reasoning_tokens ??
    rawUsage.completion_tokens_details?.reasoning_tokens ??
    rawUsage.output_tokens_details?.reasoning_tokens ??
    rawUsage.thoughtsTokenCount
  );

  let uncachedInput = 0;
  let cachedRead = 0;
  let cacheWrite = 0;
  let promptTotal = 0;

  if (isAnthropicShape) {
    // Anthropic reports input_tokens as UNCACHED input only (excludes cache_read & cache_creation)
    uncachedInput = n(rawUsage.input_tokens ?? rawUsage.prompt_tokens);
    cachedRead = n(rawUsage.cache_read_input_tokens ?? rawUsage.cached_tokens);
    cacheWrite = n(rawUsage.cache_creation_input_tokens);
    promptTotal = uncachedInput + cachedRead + cacheWrite;
  } else {
    // OpenAI / Responses / Gemini / Vertex report prompt_tokens as CACHE-INCLUSIVE
    promptTotal = n(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? rawUsage.promptTokenCount);
    cachedRead = n(
      rawUsage.cached_tokens ??
      rawUsage.prompt_tokens_details?.cached_tokens ??
      rawUsage.input_tokens_details?.cached_tokens ??
      rawUsage.cachedContentTokenCount
    );
    cacheWrite = n(rawUsage.cache_creation_input_tokens);
    if (cachedRead + cacheWrite > promptTotal) {
      promptTotal = cachedRead + cacheWrite;
    }
    uncachedInput = Math.max(0, promptTotal - cachedRead - cacheWrite);
  }

  const totalTokens = promptTotal + completionTokens;

  return {
    prompt_tokens: promptTotal,
    uncached_input_tokens: uncachedInput,
    cached_read_tokens: cachedRead,
    cache_write_tokens: cacheWrite,
    completion_tokens: completionTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
  };
}

/**
 * Compute precise USD cost breakdown including cache read discount & cache write overhead.
 * Pricing values are USD per 1M tokens.
 */
export async function computePrecisionCost(provider, model, tokens) {
  const p = await getPricingForModel(provider, model);
  if (!p) {
    return {
      cost_input: 0,
      cost_output: 0,
      cost_reasoning: 0,
      cost_cache_read: 0,
      cost_cache_write: 0,
      cost_total: 0,
      cost_without_cache: 0,
      cache_net_savings: 0,
    };
  }

  const M = 1_000_000;
  const inputRate = Number(p.input ?? 0);
  const outputRate = Number(p.output ?? 0);
  const reasoningRate = Number(p.reasoning ?? outputRate);

  // Provider-accurate default cache multipliers when explicit cached/cache_creation rates are absent
  const isAnthropic = /anthropic|claude|bedrock/i.test(provider || "") || /claude/i.test(model || "");
  const isGemini = /gemini|vertex/i.test(provider || "") || /gemini/i.test(model || "");
  const cacheReadRate = p.cached !== undefined
    ? Number(p.cached)
    : inputRate * (isAnthropic ? 0.1 : isGemini ? 0.25 : 0.5);
  const cacheWriteRate = p.cache_creation !== undefined
    ? Number(p.cache_creation)
    : inputRate * (isAnthropic ? 1.25 : 1.0);

  const costInput = (tokens.uncached_input_tokens / M) * inputRate;
  const costCacheRead = (tokens.cached_read_tokens / M) * cacheReadRate;
  const costCacheWrite = (tokens.cache_write_tokens / M) * cacheWriteRate;

  // Reasoning tokens are typically included inside completion_tokens for OpenAI/Gemini;
  // price them at reasoningRate if separate, otherwise standard outputRate without double-counting.
  const nonReasoningOut = Math.max(0, tokens.completion_tokens - tokens.reasoning_tokens);
  const costOutput = (nonReasoningOut / M) * outputRate;
  const costReasoning = (tokens.reasoning_tokens / M) * reasoningRate;

  const costTotal = costInput + costCacheRead + costCacheWrite + costOutput + costReasoning;
  const costWithoutCache = (tokens.prompt_tokens / M) * inputRate + costOutput + costReasoning;
  const cacheNetSavings = costWithoutCache - costTotal;

  return {
    cost_input: costInput,
    cost_output: costOutput,
    cost_reasoning: costReasoning,
    cost_cache_read: costCacheRead,
    cost_cache_write: costCacheWrite,
    cost_total: costTotal,
    cost_without_cache: costWithoutCache,
    cache_net_savings: cacheNetSavings,
  };
}

export function classifyErrorCategory(httpStatus, errorMessage = "") {
  const s = Number(httpStatus) || 0;
  const msg = String(errorMessage || "").toLowerCase();
  if (s === 402 || msg.includes("budget") || msg.includes("quota_exceeded")) return "policy_denied";
  if (msg.includes("ssrf blocked")) return "ssrf_blocked";
  if (s === 429 || msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limit";
  if (s === 401 || s === 403) return msg.includes("not allowed") || msg.includes("denied") ? "policy_denied" : "auth";
  if (s === 408 || s === 499 || s === 504 || msg.includes("timeout") || msg.includes("aborted")) return "timeout";
  if (msg.includes("context length") || msg.includes("maximum context") || msg.includes("too many tokens")) return "context_length";
  if (s >= 500) return "upstream_5xx";
  if (s >= 400) return "bad_request";
  return "";
}

function getBucketTs(epochMs, granularity) {
  const unit = granularity === "hourly" ? 3600_000 : 86400_000;
  return Math.floor(epochMs / unit) * unit;
}

function upsertRollupRow(db, tableName, bucketTs, trace) {
  const provider = trace.final_provider || "";
  const model = trace.final_model || "";
  const apiKeyId = trace.api_key_id || "";
  const clientTag = trace.client_tag || "";
  const endpoint = trace.endpoint || "";

  const existing = db.get(
    `SELECT ttft_histogram_json, latency_histogram_json FROM ${tableName}
     WHERE bucket_ts = ? AND provider = ? AND model = ? AND api_key_id = ? AND client_tag = ? AND endpoint = ?`,
    [bucketTs, provider, model, apiKeyId, clientTag, endpoint]
  );

  const nextTtftHist = trace.ttft_ms != null
    ? incrementHistogram(existing?.ttft_histogram_json, trace.ttft_ms)
    : (existing?.ttft_histogram_json || "{}");
  const nextLatHist = incrementHistogram(existing?.latency_histogram_json, trace.total_ms);

  const isSuccess = trace.status === "success" ? 1 : 0;
  const isError = trace.status === "error" ? 1 : 0;
  const isFallback = trace.fallback_triggered ? 1 : 0;
  const isCacheHit = trace.cached_read_tokens > 0 ? 1 : 0;
  const hasTtft = trace.ttft_ms != null ? 1 : 0;
  const hasTps = trace.output_tps != null ? 1 : 0;

  db.run(
    `INSERT INTO ${tableName} (
      bucket_ts, provider, model, api_key_id, client_tag, endpoint,
      requests, success_count, error_count, fallback_count, cache_hit_requests,
      prompt_tokens, uncached_input_tokens, cached_read_tokens, cache_write_tokens,
      completion_tokens, reasoning_tokens,
      cost_total, cost_without_cache, cache_net_savings,
      sum_ttft_ms, ttft_sample_count, sum_total_ms, sum_tps, tps_sample_count,
      ttft_histogram_json, latency_histogram_json
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket_ts, provider, model, api_key_id, client_tag, endpoint) DO UPDATE SET
      requests = requests + 1,
      success_count = success_count + excluded.success_count,
      error_count = error_count + excluded.error_count,
      fallback_count = fallback_count + excluded.fallback_count,
      cache_hit_requests = cache_hit_requests + excluded.cache_hit_requests,
      prompt_tokens = prompt_tokens + excluded.prompt_tokens,
      uncached_input_tokens = uncached_input_tokens + excluded.uncached_input_tokens,
      cached_read_tokens = cached_read_tokens + excluded.cached_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      completion_tokens = completion_tokens + excluded.completion_tokens,
      reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
      cost_total = cost_total + excluded.cost_total,
      cost_without_cache = cost_without_cache + excluded.cost_without_cache,
      cache_net_savings = cache_net_savings + excluded.cache_net_savings,
      sum_ttft_ms = sum_ttft_ms + excluded.sum_ttft_ms,
      ttft_sample_count = ttft_sample_count + excluded.ttft_sample_count,
      sum_total_ms = sum_total_ms + excluded.sum_total_ms,
      sum_tps = sum_tps + excluded.sum_tps,
      tps_sample_count = tps_sample_count + excluded.tps_sample_count,
      ttft_histogram_json = excluded.ttft_histogram_json,
      latency_histogram_json = excluded.latency_histogram_json`,
    [
      bucketTs, provider, model, apiKeyId, clientTag, endpoint,
      isSuccess, isError, isFallback, isCacheHit,
      trace.prompt_tokens, trace.uncached_input_tokens, trace.cached_read_tokens, trace.cache_write_tokens,
      trace.completion_tokens, trace.reasoning_tokens,
      trace.cost_total, trace.cost_without_cache, trace.cache_net_savings,
      hasTtft ? trace.ttft_ms : 0, hasTtft, trace.total_ms, hasTps ? trace.output_tps : 0, hasTps,
      nextTtftHist, nextLatHist,
    ]
  );
}

/**
 * Atomically persist a finalized trace, its waterfall spans, and hourly/daily rollups.
 */
export async function recordTraceAndSpans(trace, spans = []) {
  const db = await getTelemetryDb();
  const epochMs = trace.epoch_ms || Date.now();
  const timestamp = trace.timestamp || new Date(epochMs).toISOString();

  // Compute streaming-only TPOT and TPS safely (never Infinity / NaN, NULL for non-streaming)
  const isStream = trace.is_stream ? 1 : 0;
  const ttftMs = trace.ttft_ms != null && Number.isFinite(trace.ttft_ms) ? Math.max(0, Math.round(trace.ttft_ms)) : null;
  const totalMs = Math.max(0, Math.round(trace.total_ms || 0));
  let tpotMs = null;
  let outputTps = null;
  const effectiveOut = trace.completion_tokens || 0;
  if (isStream === 1 && ttftMs !== null && effectiveOut > 1 && totalMs > ttftMs) {
    const genMs = totalMs - ttftMs;
    tpotMs = Number((genMs / (effectiveOut - 1)).toFixed(3));
    outputTps = Number((effectiveOut / (genMs / 1000)).toFixed(2));
  }

  const row = {
    trace_id: trace.trace_id,
    timestamp,
    epoch_ms: epochMs,
    api_key_id: trace.api_key_id || "",
    client_tag: trace.client_tag || "",
    session_id: trace.session_id || "",
    endpoint: trace.endpoint || "/v1/chat/completions",
    source_format: trace.source_format || "",
    requested_model: trace.requested_model || "",
    combo_name: trace.combo_name || "",
    final_provider: trace.final_provider || "",
    final_model: trace.final_model || "",
    final_connection_id: trace.final_connection_id || "",
    is_stream: isStream,
    http_status: trace.http_status || 200,
    status: trace.status || "success",
    error_category: trace.error_category || "",
    error_code: trace.error_code ? String(trace.error_code) : null,
    error_message: trace.error_message ? String(trace.error_message).slice(0, 1000) : null,
    attempt_count: trace.attempt_count || 1,
    fallback_triggered: trace.fallback_triggered ? 1 : 0,
    ttft_ms: ttftMs,
    total_ms: totalMs,
    tpot_ms: tpotMs,
    output_tps: outputTps,
    translate_ms: Math.max(0, Math.round(trace.translate_ms || 0)),
    prompt_tokens: trace.prompt_tokens || 0,
    uncached_input_tokens: trace.uncached_input_tokens || 0,
    cached_read_tokens: trace.cached_read_tokens || 0,
    cache_write_tokens: trace.cache_write_tokens || 0,
    completion_tokens: trace.completion_tokens || 0,
    reasoning_tokens: trace.reasoning_tokens || 0,
    total_tokens: trace.total_tokens || 0,
    has_multimodal: trace.has_multimodal ? 1 : 0,
    media_count: trace.media_count || 0,
    cost_input: trace.cost_input || 0,
    cost_output: trace.cost_output || 0,
    cost_reasoning: trace.cost_reasoning || 0,
    cost_cache_read: trace.cost_cache_read || 0,
    cost_cache_write: trace.cost_cache_write || 0,
    cost_total: trace.cost_total || 0,
    cost_without_cache: trace.cost_without_cache || 0,
    cache_net_savings: trace.cache_net_savings || 0,
  };

  db.transaction(() => {
    db.run(
      `INSERT OR REPLACE INTO request_traces (
        trace_id, timestamp, epoch_ms, api_key_id, client_tag, session_id,
        endpoint, source_format, requested_model, combo_name,
        final_provider, final_model, final_connection_id, is_stream,
        http_status, status, error_category, error_code, error_message,
        attempt_count, fallback_triggered, ttft_ms, total_ms, tpot_ms, output_tps, translate_ms,
        prompt_tokens, uncached_input_tokens, cached_read_tokens, cache_write_tokens,
        completion_tokens, reasoning_tokens, total_tokens, has_multimodal, media_count,
        cost_input, cost_output, cost_reasoning, cost_cache_read, cost_cache_write,
        cost_total, cost_without_cache, cache_net_savings
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
      [
        row.trace_id, row.timestamp, row.epoch_ms, row.api_key_id, row.client_tag, row.session_id,
        row.endpoint, row.source_format, row.requested_model, row.combo_name,
        row.final_provider, row.final_model, row.final_connection_id, row.is_stream,
        row.http_status, row.status, row.error_category, row.error_code, row.error_message,
        row.attempt_count, row.fallback_triggered, row.ttft_ms, row.total_ms, row.tpot_ms, row.output_tps, row.translate_ms,
        row.prompt_tokens, row.uncached_input_tokens, row.cached_read_tokens, row.cache_write_tokens,
        row.completion_tokens, row.reasoning_tokens, row.total_tokens, row.has_multimodal, row.media_count,
        row.cost_input, row.cost_output, row.cost_reasoning, row.cost_cache_read, row.cost_cache_write,
        row.cost_total, row.cost_without_cache, row.cache_net_savings,
      ]
    );

    spans.forEach((sp, idx) => {
      db.run(
        `INSERT INTO trace_spans (
          trace_id, span_order, span_type, provider, model, connection_id,
          target_format, started_at_ms, duration_ms, ttft_ms, http_status,
          status, error_category, error_message, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.trace_id,
          sp.span_order ?? idx,
          sp.span_type || "upstream_attempt",
          sp.provider || null,
          sp.model || null,
          sp.connection_id || null,
          sp.target_format || null,
          Math.max(0, Math.round(sp.started_at_ms || 0)),
          Math.max(0, Math.round(sp.duration_ms || 0)),
          sp.ttft_ms != null ? Math.round(sp.ttft_ms) : null,
          sp.http_status ?? null,
          sp.status || "success",
          sp.error_category || null,
          sp.error_message ? String(sp.error_message).slice(0, 500) : null,
          sp.meta ? JSON.stringify(sp.meta) : null,
        ]
      );
    });

    upsertRollupRow(db, "metrics_hourly", getBucketTs(epochMs, "hourly"), row);
    upsertRollupRow(db, "metrics_daily", getBucketTs(epochMs, "daily"), row);
  });

  return row;
}

// ─── Spend window helper for Governance budget enforcement ─────────────────

export async function getApiKeySpendWindow(apiKeyId) {
  const db = await getTelemetryDb();
  const now = new Date();
  const startOfDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const dayRow = db.get(
    "SELECT COALESCE(SUM(cost_total), 0) AS spend FROM request_traces WHERE api_key_id = ? AND epoch_ms >= ?",
    [apiKeyId, startOfDayMs]
  );
  const monthRow = db.get(
    "SELECT COALESCE(SUM(cost_total), 0) AS spend FROM request_traces WHERE api_key_id = ? AND epoch_ms >= ?",
    [apiKeyId, startOfMonthMs]
  );

  return {
    dailyUsd: Number(dayRow?.spend || 0),
    monthlyUsd: Number(monthRow?.spend || 0),
  };
}

export async function getGlobalSpendWindow() {
  const db = await getTelemetryDb();
  const now = new Date();
  const startOfDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const dayRow = db.get("SELECT COALESCE(SUM(cost_total), 0) AS spend FROM request_traces WHERE epoch_ms >= ?", [startOfDayMs]);
  const monthRow = db.get("SELECT COALESCE(SUM(cost_total), 0) AS spend FROM request_traces WHERE epoch_ms >= ?", [startOfMonthMs]);
  return {
    dailyUsd: Number(dayRow?.spend || 0),
    monthlyUsd: Number(monthRow?.spend || 0),
  };
}

// ─── Range resolution helper ──────────────────────────────────────────────

function formatBucketLabel(bucketTs, table) {
  const iso = new Date(bucketTs).toISOString();
  return table === "metrics_hourly"
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    : iso.slice(0, 10);
}

export function resolveRangeWindow(range = "7d", fromMs = null, toMs = null) {
  const now = Date.now();
  if (fromMs && toMs) {
    const start = Number(fromMs);
    const end = Number(toMs);
    const table = end - start <= 72 * 3600_000 ? "metrics_hourly" : "metrics_daily";
    const bucketUnit = table === "metrics_hourly" ? 3600_000 : 86400_000;
    return {
      startMs: start,
      bucketStartMs: Math.floor(start / bucketUnit) * bucketUnit,
      endMs: end,
      table,
    };
  }
  const map = {
    "1h": 3600_000,
    "24h": 24 * 3600_000,
    "7d": 7 * 86400_000,
    "30d": 30 * 86400_000,
    "90d": 90 * 86400_000,
    "all": now,
  };
  const span = map[range] ?? map["7d"];
  const startMs = range === "all" ? 0 : now - span;
  const table = range === "1h" || range === "24h" ? "metrics_hourly" : "metrics_daily";
  const bucketUnit = table === "metrics_hourly" ? 3600_000 : 86400_000;
  const bucketStartMs = range === "all" ? 0 : Math.floor(startMs / bucketUnit) * bucketUnit;
  return {
    startMs,
    bucketStartMs,
    endMs: now,
    table,
  };
}

// ─── 1. Overview Analytics ────────────────────────────────────────────────

export async function getOverviewAnalytics({ range = "7d" } = {}) {
  const db = await getTelemetryDb();
  const { bucketStartMs, endMs, table } = resolveRangeWindow(range);

  const rows = db.all(
    `SELECT * FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`,
    [bucketStartMs, endMs]
  );

  let requests = 0, successCount = 0, errorCount = 0, fallbackCount = 0, cacheHitRequests = 0;
  let promptTokens = 0, uncachedTokens = 0, cachedReadTokens = 0, cacheWriteTokens = 0;
  let completionTokens = 0, reasoningTokens = 0;
  let costTotal = 0, costWithoutCache = 0, cacheNetSavings = 0;
  let sumTtft = 0, ttftSamples = 0, sumTotalMs = 0, sumTps = 0, tpsSamples = 0;

  const ttftHists = [];
  const latHists = [];
  const byBucket = new Map();
  const byModel = new Map();

  for (const r of rows) {
    requests += r.requests;
    successCount += r.success_count;
    errorCount += r.error_count;
    fallbackCount += r.fallback_count;
    cacheHitRequests += r.cache_hit_requests;
    promptTokens += r.prompt_tokens;
    uncachedTokens += r.uncached_input_tokens;
    cachedReadTokens += r.cached_read_tokens;
    cacheWriteTokens += r.cache_write_tokens;
    completionTokens += r.completion_tokens;
    reasoningTokens += r.reasoning_tokens;
    costTotal += r.cost_total;
    costWithoutCache += r.cost_without_cache;
    cacheNetSavings += r.cache_net_savings;
    sumTtft += r.sum_ttft_ms;
    ttftSamples += r.ttft_sample_count;
    sumTotalMs += r.sum_total_ms;
    sumTps += r.sum_tps;
    tpsSamples += r.tps_sample_count;
    ttftHists.push(r.ttft_histogram_json);
    latHists.push(r.latency_histogram_json);

    const b = byBucket.get(r.bucket_ts) || {
      bucketTs: r.bucket_ts,
      bucket: formatBucketLabel(r.bucket_ts, table),
      label: new Date(r.bucket_ts).toISOString(),
      requests: 0,
      successRequests: 0,
      errors: 0,
      costUsd: 0,
      cacheSavingsUsd: 0,
      cacheNetSavingsUsd: 0,
      promptTokens: 0,
      uncachedInputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
    };
    b.requests += r.requests;
    b.successRequests += r.success_count;
    b.errors += r.error_count;
    b.costUsd += r.cost_total;
    b.cacheSavingsUsd += r.cache_net_savings;
    b.cacheNetSavingsUsd += r.cache_net_savings;
    b.promptTokens += r.prompt_tokens;
    b.uncachedInputTokens += r.uncached_input_tokens;
    b.cachedReadTokens += r.cached_read_tokens;
    b.cacheWriteTokens += r.cache_write_tokens;
    b.completionTokens += r.completion_tokens;
    byBucket.set(r.bucket_ts, b);

    const modelKey = `${r.provider || "unknown"}/${r.model || "unknown"}`;
    const m = byModel.get(modelKey) || {
      provider: r.provider || "unknown",
      model: r.model || "unknown",
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedReadTokens: 0,
      costUsd: 0,
    };
    m.requests += r.requests;
    m.promptTokens += r.prompt_tokens;
    m.completionTokens += r.completion_tokens;
    m.cachedReadTokens += r.cached_read_tokens;
    m.costUsd += r.cost_total;
    byModel.set(modelKey, m);
  }

  const mergedTtft = mergeHistograms(ttftHists);
  const mergedLat = mergeHistograms(latHists);

  // Rolling 7d burn rate (floored to daily bucket boundary)
  const sevenDaysAgoBucket = Math.floor((Date.now() - 7 * 86400_000) / 86400_000) * 86400_000;
  const burnRow = db.get(
    "SELECT COALESCE(SUM(cost_total), 0) AS spend7d FROM metrics_daily WHERE bucket_ts >= ?",
    [sevenDaysAgoBucket]
  );
  const dailyBurnRateUsd = Number(burnRow?.spend7d || 0) / 7;

  const totalTokens = promptTokens + completionTokens;
  const successRatePct = requests > 0 ? Number(((successCount / requests) * 100).toFixed(2)) : 0;
  const errorRatePct = requests > 0 ? Number(((errorCount / requests) * 100).toFixed(2)) : 0;
  const fallbackRatePct = requests > 0 ? Number(((fallbackCount / requests) * 100).toFixed(2)) : 0;
  const requestCacheHitRatePct = requests > 0 ? Number(((cacheHitRequests / requests) * 100).toFixed(2)) : 0;
  const tokenCacheHitRatioPct = promptTokens > 0 ? Number(((cachedReadTokens / promptTokens) * 100).toFixed(2)) : 0;
  const p50TtftMs = percentileFromHistogram(mergedTtft, 50);
  const p95TtftMs = percentileFromHistogram(mergedTtft, 95);
  const p99TtftMs = percentileFromHistogram(mergedTtft, 99);
  const p50LatencyMs = percentileFromHistogram(mergedLat, 50);
  const p95LatencyMs = percentileFromHistogram(mergedLat, 95);
  const p99LatencyMs = percentileFromHistogram(mergedLat, 99);
  const avgTtftMs = ttftSamples > 0 ? Math.round(sumTtft / ttftSamples) : null;
  const avgLatencyMs = requests > 0 ? Math.round(sumTotalMs / requests) : null;
  const avgOutputTps = tpsSamples > 0 ? Number((sumTps / tpsSamples).toFixed(2)) : null;

  const kpis = {
    requests,
    successCount,
    successRatePct,
    errorCount,
    errorRatePct,
    fallbackCount,
    fallbackRatePct,
    promptTokens,
    uncachedTokens,
    cachedReadTokens,
    cacheWriteTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    costTotalUsd: Number(costTotal.toFixed(6)),
    costWithoutCacheUsd: Number(costWithoutCache.toFixed(6)),
    cacheNetSavingsUsd: Number(cacheNetSavings.toFixed(6)),
    requestCacheHitRatePct,
    tokenCacheHitRatioPct,
    avgTtftMs,
    p50TtftMs,
    p95TtftMs,
    p99TtftMs,
    avgLatencyMs,
    p50LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    avgOutputTps,
    dailyBurnRateUsd: Number(dailyBurnRateUsd.toFixed(4)),
    projectedMonthlyUsd: Number((dailyBurnRateUsd * 30).toFixed(2)),
  };

  const summary = {
    totalRequests: requests,
    successCount,
    successRatePct,
    errorCount,
    errorRatePct,
    failoverCount: fallbackCount,
    totalTokens,
    totalCostUsd: kpis.costTotalUsd,
    costWithoutCacheUsd: kpis.costWithoutCacheUsd,
    cacheHitRatioPct: tokenCacheHitRatioPct,
    netCacheSavingsUsd: kpis.cacheNetSavingsUsd,
    p50LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    p50TtftMs,
    p95TtftMs,
    avgLatencyMs,
    avgTtftMs,
    avgOutputTps,
    dailyBurnRateUsd: kpis.dailyBurnRateUsd,
    projectedMonthlyUsd: kpis.projectedMonthlyUsd,
  };

  const topModels = [...byModel.values()]
    .map((m) => ({
      provider: m.provider,
      model: m.model,
      requests: m.requests,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      totalTokens: m.promptTokens + m.completionTokens,
      cachedReadTokens: m.cachedReadTokens,
      cacheHitRatioPct: m.promptTokens > 0 ? Number(((m.cachedReadTokens / m.promptTokens) * 100).toFixed(2)) : 0,
      costUsd: Number(m.costUsd.toFixed(6)),
    }))
    .sort((a, b) => b.requests - a.requests || b.costUsd - a.costUsd)
    .slice(0, 20);

  return {
    range,
    summary,
    kpis,
    topModels,
    timeseries: [...byBucket.values()].map((b) => ({
      ...b,
      costUsd: Number(b.costUsd.toFixed(6)),
      cacheSavingsUsd: Number(b.cacheSavingsUsd.toFixed(6)),
      cacheNetSavingsUsd: Number(b.cacheNetSavingsUsd.toFixed(6)),
    })),
  };
}

// ─── 2. Performance Analytics ─────────────────────────────────────────────

export async function getPerformanceAnalytics({ range = "7d" } = {}) {
  const db = await getTelemetryDb();
  const { startMs, bucketStartMs, endMs, table } = resolveRangeWindow(range);

  const rows = db.all(
    `SELECT * FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`,
    [bucketStartMs, endMs]
  );

  const overall = {
    key: "all",
    requests: 0,
    sumTtft: 0,
    ttftSamples: 0,
    sumTotal: 0,
    sumTps: 0,
    tpsSamples: 0,
    ttftHists: [],
    latHists: [],
  };
  const byModel = new Map();
  const byProvider = new Map();
  const byBucket = new Map();

  for (const r of rows) {
    overall.requests += r.requests;
    overall.sumTtft += r.sum_ttft_ms;
    overall.ttftSamples += r.ttft_sample_count;
    overall.sumTotal += r.sum_total_ms;
    overall.sumTps += r.sum_tps;
    overall.tpsSamples += r.tps_sample_count;
    overall.ttftHists.push(r.ttft_histogram_json);
    overall.latHists.push(r.latency_histogram_json);

    const modelKey = `${r.provider}/${r.model}`;
    const accum = (map, key, extra = {}) => {
      const e = map.get(key) || {
        key,
        ...extra,
        requests: 0,
        sumTtft: 0,
        ttftSamples: 0,
        sumTotal: 0,
        sumTps: 0,
        tpsSamples: 0,
        ttftHists: [],
        latHists: [],
      };
      e.requests += r.requests;
      e.sumTtft += r.sum_ttft_ms;
      e.ttftSamples += r.ttft_sample_count;
      e.sumTotal += r.sum_total_ms;
      e.sumTps += r.sum_tps;
      e.tpsSamples += r.tps_sample_count;
      e.ttftHists.push(r.ttft_histogram_json);
      e.latHists.push(r.latency_histogram_json);
      map.set(key, e);
    };

    accum(byModel, modelKey, { provider: r.provider, model: r.model });
    accum(byProvider, r.provider || "unknown", { provider: r.provider || "unknown" });
    accum(byBucket, r.bucket_ts, {
      bucketTs: r.bucket_ts,
      bucket: formatBucketLabel(r.bucket_ts, table),
      label: new Date(r.bucket_ts).toISOString(),
    });
  }

  const finalize = (e) => {
    const tHist = mergeHistograms(e.ttftHists);
    const lHist = mergeHistograms(e.latHists);
    const avgTps = e.tpsSamples > 0 ? Number((e.sumTps / e.tpsSamples).toFixed(2)) : null;
    const p50Ttft = percentileFromHistogram(tHist, 50);
    const p95Ttft = percentileFromHistogram(tHist, 95);
    const p99Ttft = percentileFromHistogram(tHist, 99);
    const p50Lat = percentileFromHistogram(lHist, 50);
    const p95Lat = percentileFromHistogram(lHist, 95);
    const p99Lat = percentileFromHistogram(lHist, 99);
    return {
      key: e.key,
      provider: e.provider,
      model: e.model,
      bucketTs: e.bucketTs,
      bucket: e.bucket,
      label: e.label,
      requests: e.requests,
      avgTtftMs: e.ttftSamples > 0 ? Math.round(e.sumTtft / e.ttftSamples) : null,
      p50TtftMs: p50Ttft,
      p95TtftMs: p95Ttft,
      p99TtftMs: p99Ttft,
      ttftP50Ms: p50Ttft,
      ttftP95Ms: p95Ttft,
      ttftP99Ms: p99Ttft,
      avgLatencyMs: e.requests > 0 ? Math.round(e.sumTotal / e.requests) : null,
      p50LatencyMs: p50Lat,
      p95LatencyMs: p95Lat,
      p99LatencyMs: p99Lat,
      latencyP50Ms: p50Lat,
      latencyP95Ms: p95Lat,
      latencyP99Ms: p99Lat,
      avgOutputTps: avgTps,
      avgTpotMs: avgTps && avgTps > 0 ? Number((1000 / avgTps).toFixed(2)) : null,
      streamingSamples: e.tpsSamples,
    };
  };

  const overallFin = finalize(overall);

  // Stream vs non-stream summary from request_traces
  const modeBreakdown = db.all(
    `SELECT is_stream, COUNT(*) AS requests,
            AVG(ttft_ms) AS avg_ttft_ms, AVG(total_ms) AS avg_total_ms,
            AVG(output_tps) AS avg_tps, AVG(tpot_ms) AS avg_tpot_ms
     FROM request_traces
     WHERE epoch_ms >= ? AND epoch_ms <= ?
     GROUP BY is_stream`,
    [startMs, endMs]
  );

  return {
    range,
    summary: {
      totalRequests: overallFin.requests,
      latencyP50Ms: overallFin.latencyP50Ms,
      latencyP95Ms: overallFin.latencyP95Ms,
      latencyP99Ms: overallFin.latencyP99Ms,
      ttftP50Ms: overallFin.ttftP50Ms,
      ttftP95Ms: overallFin.ttftP95Ms,
      ttftP99Ms: overallFin.ttftP99Ms,
      avgLatencyMs: overallFin.avgLatencyMs,
      avgTtftMs: overallFin.avgTtftMs,
      avgOutputTps: overallFin.avgOutputTps,
      avgTpotMs: overallFin.avgTpotMs,
      streamingSamples: overallFin.streamingSamples,
    },
    byModel: [...byModel.values()].map(finalize).sort((a, b) => b.requests - a.requests),
    byProvider: [...byProvider.values()].map(finalize).sort((a, b) => b.requests - a.requests),
    timeseries: [...byBucket.values()].map(finalize),
    streamModeBreakdown: modeBreakdown.map((m) => ({
      mode: m.is_stream ? "streaming" : "non-streaming",
      requests: m.requests,
      avgTtftMs: m.avg_ttft_ms != null ? Math.round(m.avg_ttft_ms) : null,
      avgLatencyMs: m.avg_total_ms != null ? Math.round(m.avg_total_ms) : null,
      avgOutputTps: m.avg_tps != null ? Number(m.avg_tps.toFixed(2)) : null,
      avgTpotMs: m.avg_tpot_ms != null ? Number(m.avg_tpot_ms.toFixed(2)) : null,
    })),
  };
}

// ─── 3. Deep Cost Analytics ───────────────────────────────────────────────

export async function getCostAnalytics({ range = "30d" } = {}) {
  const db = await getTelemetryDb();
  const { startMs, bucketStartMs, endMs, table } = resolveRangeWindow(range);

  const summary = db.get(
    `SELECT
       COUNT(*) AS requests,
       COALESCE(SUM(cost_input), 0) AS cost_input,
       COALESCE(SUM(cost_output), 0) AS cost_output,
       COALESCE(SUM(cost_reasoning), 0) AS cost_reasoning,
       COALESCE(SUM(cost_cache_read), 0) AS cost_cache_read,
       COALESCE(SUM(cost_cache_write), 0) AS cost_cache_write,
       COALESCE(SUM(cost_total), 0) AS cost_total,
       COALESCE(SUM(cost_without_cache), 0) AS cost_without_cache,
       COALESCE(SUM(cache_net_savings), 0) AS cache_net_savings
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?`,
    [startMs, endMs]
  );

  const byModelRaw = db.all(
    `SELECT final_provider AS provider, final_model AS model, COUNT(*) AS requests,
            SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
            SUM(cached_read_tokens) AS cached_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cost_input) AS cost_input, SUM(cost_output) AS cost_output,
            SUM(cost_reasoning) AS cost_reasoning, SUM(cost_cache_read) AS cost_cache_read,
            SUM(cost_cache_write) AS cost_cache_write, SUM(cost_total) AS cost_total,
            SUM(cache_net_savings) AS cache_net_savings
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?
     GROUP BY final_provider, final_model ORDER BY cost_total DESC`,
    [startMs, endMs]
  );

  const byModel = byModelRaw.map((m) => ({
    ...m,
    costInputUsd: Number((m.cost_input || 0).toFixed(6)),
    costOutputUsd: Number((m.cost_output || 0).toFixed(6)),
    costReasoningUsd: Number((m.cost_reasoning || 0).toFixed(6)),
    costCacheReadUsd: Number((m.cost_cache_read || 0).toFixed(6)),
    costCacheWriteUsd: Number((m.cost_cache_write || 0).toFixed(6)),
    costTotalUsd: Number((m.cost_total || 0).toFixed(6)),
    netCacheSavingsUsd: Number((m.cache_net_savings || 0).toFixed(6)),
  }));

  const byProvider = db.all(
    `SELECT final_provider AS provider, COUNT(*) AS requests,
            SUM(cost_total) AS cost_total, SUM(cache_net_savings) AS cache_net_savings
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?
     GROUP BY final_provider ORDER BY cost_total DESC`,
    [startMs, endMs]
  );

  const byApiKey = db.all(
    `SELECT api_key_id AS apiKeyId, COUNT(*) AS requests,
            SUM(prompt_tokens + completion_tokens) AS total_tokens,
            SUM(cost_total) AS cost_total
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?
     GROUP BY api_key_id ORDER BY cost_total DESC`,
    [startMs, endMs]
  );

  const byTag = db.all(
    `SELECT COALESCE(NULLIF(client_tag, ''), 'untagged') AS tag, COUNT(*) AS requests,
            SUM(prompt_tokens + completion_tokens) AS total_tokens,
            SUM(cost_total) AS cost_total
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?
     GROUP BY tag ORDER BY cost_total DESC`,
    [startMs, endMs]
  );

  const timeseries = db.all(
    `SELECT bucket_ts AS bucketTs, SUM(cost_total) AS costTotal,
            SUM(cost_without_cache) AS costWithoutCache,
            SUM(cache_net_savings) AS cacheNetSavings, SUM(requests) AS requests
     FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ?
     GROUP BY bucket_ts ORDER BY bucket_ts ASC`,
    [bucketStartMs, endMs]
  );

  const dailyStartMs = range === "all" ? 0 : Math.floor(startMs / 86400_000) * 86400_000;
  const dailyRows = db.all(
    `SELECT bucket_ts AS bucketTs, SUM(cost_total) AS costTotal,
            SUM(cost_without_cache) AS costWithoutCache,
            SUM(cache_net_savings) AS cacheNetSavings, SUM(requests) AS requests
     FROM metrics_daily WHERE bucket_ts >= ? AND bucket_ts <= ?
     GROUP BY bucket_ts ORDER BY bucket_ts ASC`,
    [dailyStartMs, endMs]
  );

  const sevenDaysAgoBucket = Math.floor((Date.now() - 7 * 86400_000) / 86400_000) * 86400_000;
  const spend7d = db.get(
    "SELECT COALESCE(SUM(cost_total), 0) AS spend FROM metrics_daily WHERE bucket_ts >= ?",
    [sevenDaysAgoBucket]
  )?.spend || 0;
  const dailyBurnUsd = Number(spend7d) / 7;

  const totalRequests = summary?.requests || 0;
  const totalCostUsd = Number((summary?.cost_total || 0).toFixed(6));
  const costWithoutCacheUsd = Number((summary?.cost_without_cache || 0).toFixed(6));
  const netCacheSavingsUsd = Number((summary?.cache_net_savings || 0).toFixed(6));
  const avgCostPerRequestUsd = totalRequests > 0 ? Number((totalCostUsd / totalRequests).toFixed(6)) : 0;

  return {
    range,
    summary: {
      requests: totalRequests,
      totalRequests,
      costInput: Number((summary?.cost_input || 0).toFixed(6)),
      costOutput: Number((summary?.cost_output || 0).toFixed(6)),
      costReasoning: Number((summary?.cost_reasoning || 0).toFixed(6)),
      costCacheRead: Number((summary?.cost_cache_read || 0).toFixed(6)),
      costCacheWrite: Number((summary?.cost_cache_write || 0).toFixed(6)),
      costTotal: totalCostUsd,
      totalCostUsd,
      costWithoutCache: costWithoutCacheUsd,
      costWithoutCacheUsd,
      cacheNetSavings: netCacheSavingsUsd,
      netCacheSavingsUsd,
      avgCostPerRequestUsd,
      dailyBurnRateUsd: Number(dailyBurnUsd.toFixed(4)),
      projectedMonthlyUsd: Number((dailyBurnUsd * 30).toFixed(2)),
    },
    byModel,
    byProvider,
    byApiKey,
    byTag,
    daily: dailyRows.map((d) => ({
      bucketTs: d.bucketTs,
      day: new Date(d.bucketTs).toISOString().slice(0, 10),
      costUsd: Number((d.costTotal || 0).toFixed(6)),
      costWithoutCacheUsd: Number((d.costWithoutCache || 0).toFixed(6)),
      cacheSavingsUsd: Number((d.cacheNetSavings || 0).toFixed(6)),
      requests: d.requests || 0,
    })),
    timeseries: timeseries.map((t) => ({
      ...t,
      bucket: formatBucketLabel(t.bucketTs, table),
      label: new Date(t.bucketTs).toISOString(),
      costUsd: Number((t.costTotal || 0).toFixed(6)),
    })),
  };
}

// ─── 4. Prompt Caching Analysis ───────────────────────────────────────────

export async function getCacheAnalytics({ range = "7d" } = {}) {
  const db = await getTelemetryDb();
  const { startMs, bucketStartMs, endMs, table } = resolveRangeWindow(range);

  const summary = db.get(
    `SELECT
       COUNT(*) AS requests,
       SUM(CASE WHEN cached_read_tokens > 0 THEN 1 ELSE 0 END) AS cache_hit_requests,
       SUM(CASE WHEN cache_write_tokens > 0 THEN 1 ELSE 0 END) AS cache_write_requests,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
       COALESCE(SUM(cached_read_tokens), 0) AS cached_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
       COALESCE(SUM(cost_cache_read), 0) AS cost_cache_read,
       COALESCE(SUM(cost_cache_write), 0) AS cost_cache_write,
       COALESCE(SUM(cost_without_cache), 0) AS cost_without_cache,
       COALESCE(SUM(cost_total), 0) AS cost_total,
       COALESCE(SUM(cache_net_savings), 0) AS cache_net_savings
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?`,
    [startMs, endMs]
  );

  const byModel = db.all(
    `SELECT final_provider AS provider, final_model AS model, COUNT(*) AS requests,
            SUM(CASE WHEN cached_read_tokens > 0 THEN 1 ELSE 0 END) AS cache_hit_requests,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(cached_read_tokens) AS cached_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cost_cache_read) AS cost_cache_read,
            SUM(cost_cache_write) AS cost_cache_write,
            SUM(cache_net_savings) AS cache_net_savings
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?
     GROUP BY final_provider, final_model ORDER BY prompt_tokens DESC`,
    [startMs, endMs]
  );

  const worstSessions = db.all(
    `SELECT session_id AS sessionId, final_provider AS provider, final_model AS model,
            COUNT(*) AS requests,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(cached_read_tokens) AS cached_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cache_net_savings) AS cache_net_savings
     FROM request_traces
     WHERE epoch_ms >= ? AND epoch_ms <= ? AND session_id != ''
     GROUP BY session_id, final_provider, final_model
     HAVING requests >= 2
     ORDER BY (CAST(SUM(cached_read_tokens) AS REAL) / NULLIF(SUM(prompt_tokens), 0)) ASC, prompt_tokens DESC
     LIMIT 25`,
    [startMs, endMs]
  );

  const timeseries = db.all(
    `SELECT bucket_ts AS bucketTs, SUM(requests) AS requests,
            SUM(cache_hit_requests) AS cacheHitRequests,
            SUM(prompt_tokens) AS promptTokens,
            SUM(uncached_input_tokens) AS uncachedInputTokens,
            SUM(cached_read_tokens) AS cachedReadTokens,
            SUM(cache_write_tokens) AS cacheWriteTokens,
            SUM(cache_net_savings) AS cacheNetSavings
     FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ?
     GROUP BY bucket_ts ORDER BY bucket_ts ASC`,
    [bucketStartMs, endMs]
  );

  const reqs = summary?.requests || 0;
  const promptTok = summary?.prompt_tokens || 0;
  const readTok = summary?.cached_read_tokens || 0;
  const writeTok = summary?.cache_write_tokens || 0;

  return {
    range,
    summary: {
      requests: reqs,
      cacheHitRequests: summary?.cache_hit_requests || 0,
      cacheWriteRequests: summary?.cache_write_requests || 0,
      requestCacheHitRatePct: reqs > 0 ? Number((((summary?.cache_hit_requests || 0) / reqs) * 100).toFixed(2)) : 0,
      tokenCacheHitRatioPct: promptTok > 0 ? Number(((readTok / promptTok) * 100).toFixed(2)) : 0,
      readToWriteRatio: writeTok > 0 ? Number((readTok / writeTok).toFixed(2)) : null,
      promptTokens: promptTok,
      uncachedInputTokens: summary?.uncached_input_tokens || 0,
      cachedReadTokens: readTok,
      cacheWriteTokens: writeTok,
      costCacheReadUsd: Number((summary?.cost_cache_read || 0).toFixed(6)),
      costCacheWriteUsd: Number((summary?.cost_cache_write || 0).toFixed(6)),
      netCacheSavingsUsd: Number((summary?.cache_net_savings || 0).toFixed(6)),
      cacheThrashingDetected: (summary?.cache_net_savings || 0) < 0,
    },
    byModel: byModel.map((m) => {
      const tokenHitRatioPct = m.prompt_tokens > 0 ? Number(((m.cached_read_tokens / m.prompt_tokens) * 100).toFixed(2)) : 0;
      return {
        ...m,
        promptTokens: m.prompt_tokens || 0,
        cachedReadTokens: m.cached_read_tokens || 0,
        cacheWriteTokens: m.cache_write_tokens || 0,
        requestHitRatePct: m.requests > 0 ? Number(((m.cache_hit_requests / m.requests) * 100).toFixed(2)) : 0,
        tokenHitRatioPct,
        tokenCacheHitRatioPct: tokenHitRatioPct,
        netCacheSavingsUsd: Number((m.cache_net_savings || 0).toFixed(6)),
        readToWriteRatio: m.cache_write_tokens > 0 ? Number((m.cached_read_tokens / m.cache_write_tokens).toFixed(2)) : null,
      };
    }),
    worstSessions: worstSessions.map((s) => ({
      ...s,
      tokenHitRatioPct: s.prompt_tokens > 0 ? Number(((s.cached_read_tokens / s.prompt_tokens) * 100).toFixed(2)) : 0,
    })),
    timeseries: timeseries.map((t) => {
      const tokenHitRatioPct = t.promptTokens > 0 ? Number(((t.cachedReadTokens / t.promptTokens) * 100).toFixed(2)) : 0;
      return {
        ...t,
        bucket: formatBucketLabel(t.bucketTs, table),
        label: new Date(t.bucketTs).toISOString(),
        tokenHitRatioPct,
        tokenCacheHitRatioPct: tokenHitRatioPct,
        requestHitRatePct: t.requests > 0 ? Number(((t.cacheHitRequests / t.requests) * 100).toFixed(2)) : 0,
      };
    }),
  };
}

// ─── 5. Reliability & Error Analytics ─────────────────────────────────────

export async function getReliabilityAnalytics({ range = "7d" } = {}) {
  const db = await getTelemetryDb();
  const { startMs, endMs } = resolveRangeWindow(range);

  const overall = db.get(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
            SUM(fallback_triggered) AS fallback_count,
            SUM(CASE WHEN http_status = 429 OR error_category = 'rate_limit' THEN 1 ELSE 0 END) AS rate_limited_count
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?`,
    [startMs, endMs]
  );

  const byProvider = db.all(
    `SELECT final_provider AS provider, COUNT(*) AS requests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
            SUM(fallback_triggered) AS fallback_count,
            AVG(attempt_count) AS avg_attempts
     FROM request_traces WHERE epoch_ms >= ? AND epoch_ms <= ?
     GROUP BY final_provider ORDER BY requests DESC`,
    [startMs, endMs]
  );

  const errorTaxonomy = db.all(
    `SELECT COALESCE(NULLIF(error_category, ''), 'unknown') AS category, http_status AS httpStatus,
            final_provider AS provider, COUNT(*) AS count
     FROM request_traces
     WHERE epoch_ms >= ? AND epoch_ms <= ? AND status = 'error'
     GROUP BY category, http_status, final_provider ORDER BY count DESC`,
    [startMs, endMs]
  );

  const categoryTotals = new Map();
  for (const row of errorTaxonomy) {
    categoryTotals.set(row.category, (categoryTotals.get(row.category) || 0) + (row.count || 0));
  }
  const errorCategories = [...categoryTotals.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const comboStats = db.all(
    `SELECT combo_name AS comboName, COUNT(*) AS requests,
            SUM(fallback_triggered) AS fallback_triggered,
            SUM(CASE WHEN status = 'success' AND fallback_triggered = 1 THEN 1 ELSE 0 END) AS fallback_saved,
            AVG(CASE WHEN fallback_triggered = 1 THEN total_ms END) AS avg_fallback_ms,
            AVG(CASE WHEN fallback_triggered = 0 THEN total_ms END) AS avg_direct_ms
     FROM request_traces
     WHERE epoch_ms >= ? AND epoch_ms <= ? AND combo_name != ''
     GROUP BY combo_name ORDER BY requests DESC`,
    [startMs, endMs]
  );

  const recentErrors = db.all(
    `SELECT trace_id, timestamp, final_provider, final_model, http_status, error_category, error_message, attempt_count, total_ms
     FROM request_traces
     WHERE epoch_ms >= ? AND epoch_ms <= ? AND status = 'error'
     ORDER BY epoch_ms DESC LIMIT 30`,
    [startMs, endMs]
  );

  const totalRequests = overall?.requests || 0;
  const successCount = overall?.success_count || 0;
  const errorCount = overall?.error_count || 0;
  const failoverCount = overall?.fallback_count || 0;
  const rateLimitedCount = overall?.rate_limited_count || 0;

  return {
    range,
    summary: {
      totalRequests,
      successCount,
      errorCount,
      successRatePct: totalRequests > 0 ? Number(((successCount / totalRequests) * 100).toFixed(2)) : 0,
      errorRatePct: totalRequests > 0 ? Number(((errorCount / totalRequests) * 100).toFixed(2)) : 0,
      failoverCount,
      rateLimitedCount,
    },
    byProvider: byProvider.map((p) => {
      const pct = p.requests > 0 ? Number(((p.success_count / p.requests) * 100).toFixed(2)) : 100;
      return {
        ...p,
        errors: p.error_count || 0,
        failovers: p.fallback_count || 0,
        uptimePct: pct,
        successRatePct: pct,
      };
    }),
    errorCategories,
    errorTaxonomy,
    comboStats,
    recentErrors,
  };
}

// ─── 6. Trace Explorer (Cursor-based pagination + Detail Waterfall) ───────

export async function listTraces(filters = {}) {
  const db = await getTelemetryDb();
  const baseWhere = [];
  const baseParams = [];

  if (filters.startMs) { baseWhere.push("epoch_ms >= ?"); baseParams.push(Number(filters.startMs)); }
  if (filters.endMs) { baseWhere.push("epoch_ms <= ?"); baseParams.push(Number(filters.endMs)); }
  if (filters.traceId) { baseWhere.push("trace_id LIKE ?"); baseParams.push(`%${filters.traceId}%`); }
  if (filters.provider) { baseWhere.push("final_provider = ?"); baseParams.push(filters.provider); }
  if (filters.model) { baseWhere.push("(final_model LIKE ? OR requested_model LIKE ?)"); baseParams.push(`%${filters.model}%`, `%${filters.model}%`); }
  if (filters.search) {
    const q = `%${filters.search}%`;
    baseWhere.push("(trace_id LIKE ? OR final_model LIKE ? OR requested_model LIKE ? OR endpoint LIKE ? OR final_provider LIKE ?)");
    baseParams.push(q, q, q, q, q);
  }
  if (filters.apiKeyId) { baseWhere.push("api_key_id = ?"); baseParams.push(filters.apiKeyId); }
  if (filters.tag) { baseWhere.push("client_tag = ?"); baseParams.push(filters.tag); }
  if (filters.sessionId) { baseWhere.push("session_id = ?"); baseParams.push(filters.sessionId); }
  if (filters.status) { baseWhere.push("status = ?"); baseParams.push(filters.status); }
  if (filters.errorCategory) { baseWhere.push("error_category = ?"); baseParams.push(filters.errorCategory); }
  if (filters.minLatencyMs) { baseWhere.push("total_ms >= ?"); baseParams.push(Number(filters.minLatencyMs)); }
  if (filters.cacheFilter === "hit") { baseWhere.push("cached_read_tokens > 0"); }
  if (filters.cacheFilter === "miss") { baseWhere.push("cached_read_tokens = 0"); }
  if (filters.multimodalOnly) { baseWhere.push("has_multimodal = 1"); }
  if (filters.fallbackOnly) { baseWhere.push("fallback_triggered = 1"); }

  const countWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(" AND ")}` : "";
  const totalRow = db.get(`SELECT COUNT(*) AS total FROM request_traces ${countWhereSql}`, baseParams);
  const total = Number(totalRow?.total || 0);

  const pageWhere = [...baseWhere];
  const pageParams = [...baseParams];
  if (filters.cursorEpochMs) { pageWhere.push("epoch_ms < ?"); pageParams.push(Number(filters.cursorEpochMs)); }

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const whereSql = pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : "";

  const items = db.all(
    `SELECT * FROM request_traces ${whereSql} ORDER BY epoch_ms DESC LIMIT ?`,
    [...pageParams, limit + 1]
  );

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? page[page.length - 1].epoch_ms : null;

  return { items: page, total, nextCursor, hasMore };
}

export async function getTraceById(traceId) {
  const db = await getTelemetryDb();
  const trace = db.get("SELECT * FROM request_traces WHERE trace_id = ?", [traceId]);
  if (!trace) return null;
  const spans = db.all("SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY span_order ASC, id ASC", [traceId]);
  return {
    trace,
    spans: spans.map((s) => ({
      ...s,
      meta: s.meta_json ? (() => { try { return JSON.parse(s.meta_json); } catch { return null; } })() : null,
    })),
  };
}
