import {
  extractApiKey,
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
} from "../services/auth.js";
import { authenticateApiKey, getCustomModels } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess.js";
import { checkAndReserveGovernance } from "../services/governance.js";
import { createTraceContext } from "@/lib/telemetry/tracer.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

async function resolveCustomModelTransport(provider, model) {
  try {
    const customModels = await getCustomModels();
    const hit = customModels.find((c) => c && c.type === "stt" && c.providerAlias === provider && c.id === model && typeof c.transport === "string" && c.transport.trim());
    return hit ? hit.transport.trim() : null;
  } catch {
    return null;
  }
}

export async function handleStt(request) {
  const policyStartMs = performance.now();
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Valid API key required");

  const modelStr = formData.get("model");
  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  const file = formData.get("file");
  if (!file) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

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

  const gov = await checkAndReserveGovernance(apiKeyRecord, { body: { model: modelStr }, provider, model });
  if (!gov.allowed) return errorResponse(gov.status, gov.error, gov.headers);

  const trace = createTraceContext({
    request,
    endpoint: "/v1/audio/transcriptions",
    body: { model: modelStr, file: { name: file.name || "audio", type: file.type || "audio/wav", size: file.size || 0 } },
    apiKeyRecord,
    requestedModel: modelStr,
    sourceFormat: "stt",
    isStream: false,
    governanceRelease: gov.release,
  });
  trace.mediaCount = 1;
  trace.recordPolicySpan({ durationMs: performance.now() - policyStartMs, status: "success", httpStatus: 200 });

  const modelTransport = await resolveCustomModelTransport(provider, model);

  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const attemptStart = performance.now();
    const result = await handleSttCore({ provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport, signal: request.signal });
    trace.recordAttemptSpan({
      provider, model, targetFormat: "stt", startedAtMs: attemptStart, durationMs: performance.now() - attemptStart,
      httpStatus: result.success ? 200 : (result.status || 502), status: result.success ? "success" : "error", errorMessage: result.error,
    });
    await trace.finalize({ provider, model, httpStatus: result.success ? 200 : (result.status || 502), status: result.success ? "success" : "error", errorMessage: result.error });
    const res = result.success ? result.response : errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
    return trace.attachResponseHeaders(res, { provider, model, rateLimitHeaders: gov.headers });
  }

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    if (!credentials || credentials.allRateLimited) {
      const status = credentials?.allRateLimited ? (lastStatus || 503) : (excludeConnectionIds.size === 0 ? 400 : (lastStatus || 503));
      const msg = credentials?.allRateLimited ? `[${provider}/${model}] ${lastError || credentials.lastError || "Unavailable"}` : (excludeConnectionIds.size === 0 ? `No credentials for provider: ${provider}` : (lastError || "All accounts unavailable"));
      await trace.finalize({ provider, model, httpStatus: status, status: "error", errorMessage: msg });
      const res = credentials?.allRateLimited
        ? unavailableResponse(status, msg, credentials.retryAfter, credentials.retryAfterHuman)
        : errorResponse(status, msg);
      return trace.attachResponseHeaders(res, { provider, model, rateLimitHeaders: gov.headers });
    }

    const attemptStart = performance.now();
    const result = await handleSttCore({
      provider, model, formData, credentials,
      sttConfig: AI_PROVIDERS[provider]?.sttConfig,
      transport: modelTransport,
      signal: request.signal,
    });

    trace.recordAttemptSpan({
      provider, model, connectionId: credentials.connectionId, targetFormat: "stt",
      startedAtMs: attemptStart, durationMs: performance.now() - attemptStart,
      httpStatus: result.success ? 200 : (result.status || 502),
      status: result.success ? "success" : "error",
      errorMessage: result.success ? null : result.error,
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, model);
      await trace.finalize({ provider, model, connectionId: credentials.connectionId, httpStatus: 200, status: "success" });
      return trace.attachResponseHeaders(result.response, { provider, model, rateLimitHeaders: gov.headers });
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    await trace.finalize({ provider, model, connectionId: credentials.connectionId, httpStatus: result.status || 502, status: "error", errorMessage: result.error });
    return trace.attachResponseHeaders(result.response || errorResponse(result.status, result.error), { provider, model, rateLimitHeaders: gov.headers });
  }
}
