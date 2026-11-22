import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { authenticateApiKey } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess.js";
import { checkAndReserveGovernance } from "../services/governance.js";
import { createTraceContext } from "@/lib/telemetry/tracer.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

function exactEmbeddingUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.estimated === true) return null;
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const totalTokens = raw.total_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens <= 0 || completionTokens !== 0) return null;
  return { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: totalTokens || promptTokens };
}

export async function handleEmbeddings(request) {
  const policyStartMs = performance.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Valid API key required");

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  const { provider, model } = modelInfo;

  const keyAccessDenied = await enforceKeyAccessResolved(
    await getKeyAccessContext(request, apiKeyRecord),
    modelStr,
    provider,
    model
  );
  if (keyAccessDenied) return keyAccessDenied;

  const gov = await checkAndReserveGovernance(apiKeyRecord, { body, provider, model });
  if (!gov.allowed) return errorResponse(gov.status, gov.error, gov.headers);

  const trace = createTraceContext({
    request,
    endpoint: url.pathname,
    body,
    apiKeyRecord,
    requestedModel: modelStr,
    sourceFormat: "embeddings",
    isStream: false,
    governanceRelease: gov.release,
  });
  trace.recordPolicySpan({ durationMs: performance.now() - policyStartMs, status: "success", httpStatus: 200 });

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    if (!credentials || credentials.allRateLimited) {
      const status = credentials?.allRateLimited
        ? (lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE)
        : (excludeConnectionIds.size === 0 ? HTTP_STATUS.BAD_REQUEST : (lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE));
      const msg = credentials?.allRateLimited
        ? `[${provider}/${model}] ${lastError || credentials.lastError || "Unavailable"}`
        : (excludeConnectionIds.size === 0 ? `No credentials for provider: ${provider}` : (lastError || "All accounts unavailable"));
      await trace.finalize({ provider, model, httpStatus: status, status: "error", errorMessage: msg });
      const res = credentials?.allRateLimited
        ? unavailableResponse(status, msg, credentials.retryAfter, credentials.retryAfterHuman)
        : errorResponse(status, msg);
      return trace.attachResponseHeaders(res, { provider, model, rateLimitHeaders: gov.headers });
    }

    const attemptStart = performance.now();
    const result = await handleEmbeddingsCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials,
      log,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    trace.recordAttemptSpan({
      provider,
      model,
      connectionId: credentials.connectionId,
      targetFormat: "embeddings",
      startedAtMs: attemptStart,
      durationMs: performance.now() - attemptStart,
      httpStatus: result.success ? 200 : (result.status || 502),
      status: result.success ? "success" : "error",
      errorMessage: result.success ? null : result.error,
    });

    if (result.success) {
      const usage = exactEmbeddingUsage(result.usage);
      await trace.finalize({
        provider,
        model,
        connectionId: credentials.connectionId,
        isStream: false,
        httpStatus: 200,
        status: "success",
        usage,
      });
      return trace.attachResponseHeaders(result.response, { provider, model, rateLimitHeaders: gov.headers });
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    await trace.finalize({
      provider,
      model,
      connectionId: credentials.connectionId,
      httpStatus: result.status || 502,
      status: "error",
      errorMessage: result.error,
    });
    return trace.attachResponseHeaders(result.response, { provider, model, rateLimitHeaders: gov.headers });
  }
}
