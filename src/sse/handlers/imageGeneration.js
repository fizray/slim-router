import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { authenticateApiKey, getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { checkAndReserveGovernance } from "../services/governance.js";
import { createTraceContext } from "@/lib/telemetry/tracer.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";

const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);

export async function handleImageGeneration(request) {
  const policyStartMs = performance.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Valid API key required");

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request, apiKeyRecord), modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  const comboModels = await getComboModels(modelStr);
  const initInfo = comboModels ? await getModelInfo(comboModels[0]) : await getModelInfo(modelStr);
  const gov = await checkAndReserveGovernance(apiKeyRecord, {
    body,
    provider: initInfo?.provider || "",
    model: initInfo?.model || modelStr,
  });
  if (!gov.allowed) return errorResponse(gov.status, gov.error, gov.headers);

  const trace = createTraceContext({
    request,
    endpoint: url.pathname,
    body,
    apiKeyRecord,
    requestedModel: modelStr,
    comboName: comboModels ? modelStr : "",
    sourceFormat: "image",
    isStream: false,
    governanceRelease: gov.release,
  });
  trace.recordPolicySpan({ durationMs: performance.now() - policyStartMs, status: "success", httpStatus: 200 });

  const settings = await getSettings();
  let response;
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    response = await handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { binaryOutput, preferredConnectionId, trace }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit: settings.comboStickyRoundRobinLimit,
    });
  } else {
    response = await handleSingleModelImage(body, modelStr, { binaryOutput, preferredConnectionId, trace });
  }

  if (response && !response.ok) {
    await trace.finalize({
      provider: initInfo?.provider || "",
      model: initInfo?.model || modelStr,
      httpStatus: response.status,
      status: "error",
      errorMessage: `Image generation failed (${response.status})`,
    });
  }

  return trace.attachResponseHeaders(response, { rateLimitHeaders: gov.headers });
}

async function handleSingleModelImage(body, modelStr, { binaryOutput, preferredConnectionId, trace } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  const { provider, model } = modelInfo;

  if (NO_AUTH_PROVIDERS.has(provider)) {
    const attemptStart = performance.now();
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    trace?.recordAttemptSpan?.({
      provider,
      model,
      targetFormat: "image",
      startedAtMs: attemptStart,
      durationMs: performance.now() - attemptStart,
      httpStatus: result.success ? 200 : (result.status || 502),
      status: result.success ? "success" : "error",
      errorMessage: result.success ? null : result.error,
    });
    if (result.success) {
      await trace?.finalize?.({ provider, model, httpStatus: 200, status: "success" });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const attemptStart = performance.now();
    let reportedUsage = null;
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials,
      binaryOutput,
      onUsage: (u) => { reportedUsage = u; },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    trace?.recordAttemptSpan?.({
      provider,
      model,
      connectionId: credentials.connectionId,
      targetFormat: "image",
      startedAtMs: attemptStart,
      durationMs: performance.now() - attemptStart,
      httpStatus: result.success ? 200 : (result.status || 502),
      status: result.success ? "success" : "error",
      errorMessage: result.success ? null : result.error,
    });

    if (result.success) {
      await trace?.finalize?.({
        provider,
        model,
        connectionId: credentials.connectionId,
        httpStatus: 200,
        status: "success",
        usage: reportedUsage,
      });
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
