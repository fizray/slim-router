import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { authenticateApiKey, getProviderConnectionById } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess.js";
import { checkAndReserveGovernance } from "../services/governance.js";
import { createTraceContext } from "@/lib/telemetry/tracer.js";
import { handleVideoProxyCore, getVideoConfig, sanitizeSecrets } from "open-sse/handlers/videoCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

const DEFAULT_VIDEO_PROVIDER = "xai";
const CREATE_ROTATION_STATUSES = new Set([HTTP_STATUS.UNAUTHORIZED, HTTP_STATUS.FORBIDDEN, HTTP_STATUS.RATE_LIMITED]);

async function resolveGetProvider(request, connectionId) {
  if (connectionId) {
    const conn = await getProviderConnectionById(connectionId).catch(() => null);
    if (conn?.provider && getVideoConfig(conn.provider)) return conn.provider;
  }
  const queried = new URL(request.url).searchParams.get("provider");
  if (queried && getVideoConfig(queried)) return queried;
  return DEFAULT_VIDEO_PROVIDER;
}

async function readForwardableBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const raw = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
    }
    return { raw, parsed, contentType };
  }
  const buf = Buffer.from(await request.arrayBuffer());
  return { raw: buf, parsed: null, contentType };
}

async function resolveVideoProvider(parsedBody) {
  if (!parsedBody?.model) return { provider: DEFAULT_VIDEO_PROVIDER, model: null };
  const modelStr = String(parsedBody.model);
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Combos are not supported for video generation") };
  if (!getVideoConfig(modelInfo.provider)) {
    if (!modelStr.includes("/")) return { provider: DEFAULT_VIDEO_PROVIDER, model: modelStr };
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${modelInfo.provider}' does not support video generation`) };
  }
  return { provider: modelInfo.provider, model: modelInfo.model };
}

function withConnectionHeader(response, connectionId) {
  if (!connectionId) return response;
  const headers = new Headers(response.headers);
  headers.set("x-9router-connection-id", String(connectionId));
  return new Response(response.body, { status: response.status, headers });
}

export async function handleVideoCreate(request, action) {
  const policyStartMs = performance.now();
  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Valid API key required");

  const bodyInfo = await readForwardableBody(request);
  if (bodyInfo.error) return bodyInfo.error;

  const resolved = await resolveVideoProvider(bodyInfo.parsed);
  if (resolved.error) return resolved.error;
  const { provider, model } = resolved;

  const keyAccessDenied = await enforceKeyAccessResolved(
    await getKeyAccessContext(request, apiKeyRecord),
    bodyInfo.parsed?.model ? String(bodyInfo.parsed.model) : "",
    provider,
    model
  );
  if (keyAccessDenied) return keyAccessDenied;

  const gov = await checkAndReserveGovernance(apiKeyRecord, { body: bodyInfo.parsed, provider, model: model || "" });
  if (!gov.allowed) return errorResponse(gov.status, gov.error, gov.headers);

  const trace = createTraceContext({
    request,
    endpoint: `/v1/videos/${action}`,
    body: bodyInfo.parsed || { multipart: true },
    apiKeyRecord,
    requestedModel: bodyInfo.parsed?.model || `${provider}/${model || ""}`,
    sourceFormat: "video",
    isStream: false,
    governanceRelease: gov.release,
  });
  trace.recordPolicySpan({ durationMs: performance.now() - policyStartMs, status: "success", httpStatus: 200 });

  let forwardBody = bodyInfo.raw;
  if (bodyInfo.parsed && model && bodyInfo.parsed.model !== model) {
    forwardBody = JSON.stringify({ ...bodyInfo.parsed, model });
  }

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const idempotencyKey = request.headers.get("idempotency-key") || null;
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });
    if (!credentials || credentials.allRateLimited) {
      const status = credentials?.allRateLimited ? (lastStatus || 503) : (excludeConnectionIds.size === 0 ? 400 : (lastStatus || 503));
      const msg = credentials?.allRateLimited ? `[${provider}/${model || "video"}] ${lastError || credentials.lastError || "Unavailable"}` : (excludeConnectionIds.size === 0 ? `No credentials for provider: ${provider}` : (lastError || "All accounts unavailable"));
      await trace.finalize({ provider, model: model || "", httpStatus: status, status: "error", errorMessage: msg });
      const res = credentials?.allRateLimited
        ? unavailableResponse(status, msg, credentials.retryAfter, credentials.retryAfterHuman)
        : errorResponse(status, msg);
      return trace.attachResponseHeaders(res, { provider, model: model || "", rateLimitHeaders: gov.headers });
    }

    const attemptStart = performance.now();
    const result = await handleVideoProxyCore({
      provider,
      action,
      rawBody: forwardBody,
      contentType: bodyInfo.contentType || null,
      idempotencyKey,
      credentials,
      signal: request.signal,
      log,
    });

    trace.recordAttemptSpan({
      provider, model: model || "", connectionId: credentials.connectionId, targetFormat: "video",
      startedAtMs: attemptStart, durationMs: performance.now() - attemptStart,
      httpStatus: result.success ? 200 : (result.status || 502), status: result.success ? "success" : "error",
      errorMessage: result.success ? null : sanitizeSecrets(result.error, credentials),
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, model);
      await trace.finalize({ provider, model: model || "", connectionId: credentials.connectionId, httpStatus: 200, status: "success" });
      return trace.attachResponseHeaders(withConnectionHeader(result.response, credentials.connectionId), {
        provider, model: model || "", rateLimitHeaders: gov.headers,
      });
    }

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      sanitizeSecrets(result.error, credentials),
      provider,
      model
    );
    if (shouldFallback && CREATE_ROTATION_STATUSES.has(result.status)) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    await trace.finalize({
      provider, model: model || "", connectionId: credentials.connectionId,
      httpStatus: result.status || 502, status: "error", errorMessage: sanitizeSecrets(result.error, credentials),
    });
    return trace.attachResponseHeaders(result.response, { provider, model: model || "", rateLimitHeaders: gov.headers });
  }
}

export async function handleVideoGet(request, requestId) {
  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Valid API key required");

  if (!requestId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing video request id");

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const provider = await resolveGetProvider(request, preferredConnectionId);
  const credentials = await getProviderCredentials(provider, null, null, { preferredConnectionId });
  if (!credentials || credentials.allRateLimited) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }

  const result = await handleVideoProxyCore({
    provider,
    requestId,
    credentials,
    signal: request.signal,
    log,
  });

  if (result.success) {
    await clearAccountError(credentials.connectionId, credentials, null);
    return withConnectionHeader(result.response, credentials.connectionId);
  }

  await markAccountUnavailable(credentials.connectionId, result.status, sanitizeSecrets(result.error, credentials), provider, null);
  return result.response;
}
