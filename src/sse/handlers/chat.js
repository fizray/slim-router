import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { authenticateApiKey, getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { checkAndReserveGovernance } from "../services/governance.js";
import { createTraceContext } from "@/lib/telemetry/tracer.js";

export async function handleChat(request, clientRawRequest = null) {
  const policyStartMs = performance.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  if (!clientRawRequest) {
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries()),
    };
  }

  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Mandatory HMAC API key authentication (zero loopback bypass)
  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Valid API key required");
  }

  if (!modelStr) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  const sourceFormat = detectFormatByEndpoint(url.pathname, body);
  const comboModels = await getComboModels(modelStr);
  const initialModelInfo = comboModels ? await getModelInfo(comboModels[0]) : await getModelInfo(modelStr);

  // Per-key access control
  const keyAccess = await getKeyAccessContext(request, apiKeyRecord);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) {
    const deniedTrace = createTraceContext({
      request,
      endpoint: url.pathname,
      body,
      apiKeyRecord,
      requestedModel: modelStr,
      comboName: comboModels ? modelStr : "",
      sourceFormat,
      isStream: body.stream !== false,
    });
    deniedTrace.recordPolicySpan({
      durationMs: performance.now() - policyStartMs,
      status: "error",
      httpStatus: 403,
      errorCategory: "policy_denied",
      errorMessage: `Model "${modelStr}" not allowed for key`,
    });
    await deniedTrace.finalize({
      httpStatus: 403,
      status: "error",
      errorMessage: `Model "${modelStr}" not allowed for key`,
    });
    return deniedTrace.attachResponseHeaders(keyAccessDenied);
  }

  // Per-key & global governance (RPM, TPM, Daily/Monthly USD budget + in-flight reservation)
  const gov = await checkAndReserveGovernance(apiKeyRecord, {
    body,
    provider: initialModelInfo?.provider || "",
    model: initialModelInfo?.model || modelStr,
  });
  if (!gov.allowed) {
    const govTrace = createTraceContext({
      request,
      endpoint: url.pathname,
      body,
      apiKeyRecord,
      requestedModel: modelStr,
      comboName: comboModels ? modelStr : "",
      sourceFormat,
      isStream: body.stream !== false,
    });
    govTrace.recordPolicySpan({
      durationMs: performance.now() - policyStartMs,
      status: "error",
      httpStatus: gov.status,
      errorCategory: gov.errorCategory,
      errorMessage: gov.error,
    });
    await govTrace.finalize({
      httpStatus: gov.status,
      status: "error",
      errorMessage: gov.error,
    });
    const res = errorResponse(gov.status, gov.error, gov.headers);
    return govTrace.attachResponseHeaders(res, { rateLimitHeaders: gov.headers });
  }

  const traceContext = createTraceContext({
    request,
    endpoint: url.pathname,
    body,
    apiKeyRecord,
    requestedModel: modelStr,
    comboName: comboModels ? modelStr : "",
    sourceFormat,
    isStream: body.stream !== false,
    governanceRelease: gov.release,
  });
  traceContext.recordPolicySpan({
    durationMs: performance.now() - policyStartMs,
    status: "success",
    httpStatus: 200,
  });

  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, false);
  if (bypassResponse) {
    await traceContext.finalize({ httpStatus: 200, status: "success" });
    return traceContext.attachResponseHeaders(bypassResponse.response || bypassResponse, { rateLimitHeaders: gov.headers });
  }

  const settings = await getSettings();
  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  let response;
  try {
    if (comboModels) {
      const comboStrategies = settings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};

      response = await handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKeyRecord.id, null, traceContext),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId,
        sessionSticky: comboCfg.sessionSticky !== false,
      });
    } else {
      response = await handleSingleModelChat(
        body,
        modelStr,
        clientRawRequest,
        request,
        apiKeyRecord.id,
        contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null,
        traceContext
      );
    }
  } catch (err) {
    await traceContext.finalize({
      httpStatus: 500,
      status: "error",
      errorMessage: err.message || String(err),
    });
    const res = errorResponse(500, err.message || "Internal routing error");
    return traceContext.attachResponseHeaders(res, { rateLimitHeaders: gov.headers });
  }

  // Ensure error responses finalize trace & release governance hold
  if (response && !response.ok) {
    await traceContext.finalize({
      provider: initialModelInfo?.provider || "",
      model: initialModelInfo?.model || modelStr,
      httpStatus: response.status,
      status: "error",
      errorMessage: `Request failed with HTTP ${response.status}`,
    });
  }

  return traceContext.attachResponseHeaders(response, {
    provider: initialModelInfo?.provider || "",
    model: initialModelInfo?.model || "",
    rateLimitHeaders: gov.headers,
  });
}

async function handleSingleModelChat(
  body,
  modelStr,
  clientRawRequest = null,
  request = null,
  apiKeyId = null,
  requestedModel = null,
  traceContext = null
) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || chatSettings.comboStrategy || "fallback";
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKeyId, null, traceContext),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit: chatSettings.comboStickyRoundRobinLimit,
      });
    }
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  const userAgent = request?.headers?.get("user-agent") || "";
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      requestedModel: requestedModel || model,
    });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        return unavailableResponse(
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          `[${provider}/${model}] ${errorMsg}`,
          credentials.retryAfter,
          credentials.retryAfterHuman,
          lastHeaders
        );
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;

    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey: apiKeyId,
      ccFilterNaming: false,
      providerThinking,
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      traceContext,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
      result.resetsAtMs
    );

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
