/**
 * Distributed-style Request Tracer & Span Collector.
 *
 * Generates time-ordered UUIDv7 trace_id, records waterfall spans, detects
 * multimodal media count, normalizes canonical tokens, computes precision
 * cost & net cache savings, writes to telemetry.sqlite, offloads payload
 * sanitization + gzip to payloadWorker, and emits structured JSON logs.
 */

import crypto from "node:crypto";
import {
  canonicalizeTokens,
  computePrecisionCost,
  classifyErrorCategory,
  recordTraceAndSpans,
} from "@/lib/db/repos/telemetryRepo.js";
import { enqueueTracePayload } from "@/lib/db/payloadQueue.js";
import { jsonLogger, redactHeaders, redactUrl } from "@/lib/logging/logger.js";

const SAFE_TAG_RE = /^[a-zA-Z0-9._:-]{1,64}$/;

/**
 * Generate RFC 9562 UUIDv7 (millisecond time-ordered).
 */
export function generateTraceId() {
  const bytes = crypto.randomBytes(16);
  const now = BigInt(Date.now());
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function extractClientTag(headers) {
  if (!headers) return "";
  const raw =
    (typeof headers.get === "function"
      ? (headers.get("x-trace-tag") || headers.get("x-project"))
      : (headers["x-trace-tag"] || headers["x-project"])) || "";
  const trimmed = String(raw).trim();
  return SAFE_TAG_RE.test(trimmed) ? trimmed : "";
}

export function extractSessionId(headers, body) {
  const h =
    (typeof headers?.get === "function"
      ? (headers.get("x-session-id") || headers.get("x-claude-code-session-id"))
      : (headers?.["x-session-id"] || headers?.["x-claude-code-session-id"])) || "";
  if (h) return String(h).trim().slice(0, 128);
  if (body?.metadata?.user_id && typeof body.metadata.user_id === "string") {
    return body.metadata.user_id.slice(0, 128);
  }
  if (body?.user && typeof body.user === "string") {
    return body.user.slice(0, 128);
  }
  return "";
}

/**
 * Count multimodal attachments (image, audio, video, pdf/document) in any wire format.
 */
export function detectMultimodalMediaCount(body) {
  if (!body || typeof body !== "object") return 0;
  let count = 0;

  // OpenAI / Anthropic messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!Array.isArray(msg?.content)) continue;
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (["image_url", "image", "input_audio", "audio_url", "document", "video_url", "file"].includes(block.type)) {
          count++;
        }
      }
    }
  }

  // OpenAI Responses input[]
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!Array.isArray(item?.content)) continue;
      for (const block of item.content) {
        if (["input_image", "input_audio", "input_file"].includes(block?.type)) count++;
      }
    }
  }

  // Gemini / Vertex contents[]
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) {
      for (const part of c?.parts || []) {
        if (part?.inlineData || part?.inline_data || part?.fileData || part?.file_data) count++;
      }
    }
  }

  return count;
}

export function createTraceContext({
  request,
  endpoint,
  body = null,
  apiKeyRecord = null,
  requestedModel = "",
  comboName = "",
  sourceFormat = "",
  isStream = false,
  governanceRelease = null,
}) {
  const traceId = generateTraceId();
  const startWallMs = Date.now();
  const startPerfMs = performance.now();
  const headers = request?.headers || {};
  const clientTag = extractClientTag(headers);
  const sessionId = extractSessionId(headers, body);
  const mediaCount = detectMultimodalMediaCount(body);

  const spans = [];
  let spanOrder = 0;
  let translateMs = 0;
  let lastUpstreamRequest = null;
  let finalized = false;

  const ctx = {
    traceId,
    startWallMs,
    startPerfMs,
    clientTag,
    sessionId,
    apiKeyId: apiKeyRecord?.id || "",
    endpoint: redactUrl(endpoint || "/v1/chat/completions"),
    requestedModel: String(requestedModel || ""),
    comboName: String(comboName || ""),
    sourceFormat: String(sourceFormat || ""),
    isStream: Boolean(isStream),
    mediaCount,

    addSpan(span) {
      spans.push({
        span_order: spanOrder++,
        started_at_ms: Math.max(0, Math.round(performance.now() - startPerfMs)),
        duration_ms: 0,
        status: "success",
        ...span,
      });
    },

    recordPolicySpan({ durationMs, status = "success", httpStatus = 200, errorCategory = null, errorMessage = null }) {
      this.addSpan({
        span_type: "policy",
        started_at_ms: 0,
        duration_ms: Math.max(0, Math.round(durationMs)),
        http_status: httpStatus,
        status,
        error_category: errorCategory,
        error_message: errorMessage,
      });
    },

    recordTranslateSpan({ durationMs, sourceFormat: sf, targetFormat: tf, provider, model }) {
      translateMs += Math.max(0, Math.round(durationMs));
      if (sf && !this.sourceFormat) this.sourceFormat = sf;
      this.addSpan({
        span_type: "translate",
        provider,
        model,
        target_format: tf,
        duration_ms: Math.max(0, Math.round(durationMs)),
        status: "success",
        meta: { sourceFormat: sf, targetFormat: tf },
      });
    },

    recordAttemptSpan({
      provider,
      model,
      connectionId,
      targetFormat,
      startedAtMs,
      durationMs,
      ttftMs = null,
      httpStatus = 200,
      status = "success",
      errorMessage = null,
      upstreamRequest = null,
      upstreamUrl = null,
    }) {
      if (upstreamRequest) lastUpstreamRequest = upstreamRequest;
      const errCat = status === "error" ? classifyErrorCategory(httpStatus, errorMessage) : null;
      this.addSpan({
        span_type: "upstream_attempt",
        provider,
        model,
        connection_id: connectionId,
        target_format: targetFormat,
        started_at_ms: startedAtMs != null ? Math.max(0, Math.round(startedAtMs - startPerfMs)) : Math.round(performance.now() - startPerfMs),
        duration_ms: Math.max(0, Math.round(durationMs || 0)),
        ttft_ms: ttftMs != null ? Math.round(ttftMs) : null,
        http_status: httpStatus,
        status,
        error_category: errCat,
        error_message: errorMessage,
        meta: upstreamUrl ? { url: redactUrl(upstreamUrl) } : null,
      });
    },

    attachResponseHeaders(response, { provider = "", model = "", rateLimitHeaders = {} } = {}) {
      if (!response) return response;
      const nextHeaders = new Headers(response.headers);
      nextHeaders.set("X-Trace-Id", traceId);
      if (provider) nextHeaders.set("X-Router-Provider", provider);
      if (model) nextHeaders.set("X-Router-Model", model);
      for (const [k, v] of Object.entries(rateLimitHeaders || {})) {
        nextHeaders.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: nextHeaders,
      });
    },

    async finalize({
      provider = "",
      model = "",
      connectionId = "",
      isStream: finalStream = undefined,
      httpStatus = 200,
      status = "success",
      errorCode = null,
      errorMessage = null,
      ttftMs = null,
      usage = null,
      upstreamRequest = null,
      upstreamResponse = null,
      clientResponse = null,
      sourceFormat: finalSourceFormat = null,
    } = {}) {
      if (finalized) return null;
      finalized = true;

      const totalMs = Math.max(0, Math.round(performance.now() - startPerfMs));
      const attemptSpans = spans.filter((s) => s.span_type === "upstream_attempt");
      const attemptCount = Math.max(1, attemptSpans.length);
      const fallbackTriggered = attemptCount > 1;
      const effectiveStream = finalStream !== undefined ? Boolean(finalStream) : this.isStream;
      const errCategory = status === "error" ? classifyErrorCategory(httpStatus, errorMessage) : "";

      const canonical = canonicalizeTokens(usage, provider);
      const cost = await computePrecisionCost(provider, model, canonical);

      // Release governance in-flight hold & reconcile actual spend/tokens
      try {
        governanceRelease?.(cost.cost_total, canonical.total_tokens);
      } catch {}

      const traceRecord = await recordTraceAndSpans(
        {
          trace_id: traceId,
          timestamp: new Date(startWallMs).toISOString(),
          epoch_ms: startWallMs,
          api_key_id: this.apiKeyId,
          client_tag: this.clientTag,
          session_id: this.sessionId,
          endpoint: this.endpoint,
          source_format: finalSourceFormat || this.sourceFormat,
          requested_model: this.requestedModel,
          combo_name: this.comboName,
          final_provider: provider,
          final_model: model,
          final_connection_id: connectionId,
          is_stream: effectiveStream,
          http_status: httpStatus,
          status,
          error_category: errCategory,
          error_code: errorCode,
          error_message: errorMessage,
          attempt_count: attemptCount,
          fallback_triggered: fallbackTriggered,
          ttft_ms: ttftMs,
          total_ms: totalMs,
          translate_ms: translateMs,
          ...canonical,
          has_multimodal: mediaCount > 0,
          media_count: mediaCount,
          ...cost,
        },
        spans
      ).catch((err) => {
        jsonLogger.error("telemetry.write_failed", { trace_id: traceId, error: err.message });
        return null;
      });

      // Offload payload sanitization + media stripping + gzip to worker thread
      enqueueTracePayload({
        traceId,
        epochMs: startWallMs,
        timestamp: new Date(startWallMs).toISOString(),
        clientHeaders: redactHeaders(headers),
        clientRequest: body,
        upstreamRequest: upstreamRequest || lastUpstreamRequest,
        upstreamResponse,
        clientResponse,
      });

      // Emit structured JSON log line to stdout
      const cacheHitPct = canonical.prompt_tokens > 0
        ? Number(((canonical.cached_read_tokens / canonical.prompt_tokens) * 100).toFixed(1))
        : 0;
      jsonLogger[status === "error" ? "warn" : "info"]("inference.completed", {
        trace_id: traceId,
        api_key_id: this.apiKeyId || undefined,
        tag: this.clientTag || undefined,
        endpoint: this.endpoint,
        provider,
        model,
        status,
        http_status: httpStatus,
        is_stream: effectiveStream,
        attempt_count: attemptCount,
        fallback: fallbackTriggered,
        ttft_ms: traceRecord?.ttft_ms ?? ttftMs,
        total_ms: totalMs,
        tpot_ms: traceRecord?.tpot_ms ?? null,
        tps: traceRecord?.output_tps ?? null,
        prompt_tokens: canonical.prompt_tokens,
        cached_read_tokens: canonical.cached_read_tokens,
        uncached_input_tokens: canonical.uncached_input_tokens,
        cache_hit_pct: cacheHitPct,
        cache_write_tokens: canonical.cache_write_tokens,
        completion_tokens: canonical.completion_tokens,
        reasoning_tokens: canonical.reasoning_tokens,
        cost_usd: Number(cost.cost_total.toFixed(6)),
        cost_input_usd: Number((cost.cost_input || 0).toFixed(6)),
        cost_cache_read_usd: Number((cost.cost_cache_read || 0).toFixed(6)),
        cost_output_usd: Number((cost.cost_output || 0).toFixed(6)),
        cost_without_cache_usd: Number((cost.cost_without_cache || 0).toFixed(6)),
        cache_savings_usd: Number(cost.cache_net_savings.toFixed(6)),
        error_category: errCategory || undefined,
      });

      return traceRecord;
    },
  };

  return ctx;
}
