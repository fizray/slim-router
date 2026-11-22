import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { extractThinking, stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/vertexAuth.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import {
  getModelTargetFormat,
  getModelSupportedFormats,
  getModelStrip,
  getModelUpstreamId,
  getModelType,
  PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { upstreamResponseHeaders } from "../utils/upstreamHeaders.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/db/index.js";
import { getExecutor } from "../executors/index.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";
import { defaultClaudeToolType, shouldDefaultClaudeToolType } from "../translator/concerns/toolCall.js";
import { resolveSessionId } from "../utils/sessionManager.js";

export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

export async function handleChatCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  onDisconnect,
  clientRawRequest,
  connectionId,
  userAgent,
  apiKey,
  ccFilterNaming,
  sourceFormatOverride,
  providerThinking,
  providerOverrides,
  traceContext = null,
}) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();
  const translateStartMs = performance.now();

  const sessionSeed = (() => {
    try {
      return resolveSessionId({ headers: clientRawRequest?.headers, body, connectionId, scope: provider });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession ? log.tagForSession(sessionSeed) : (log?.nextTag ? log.nextTag() : "");

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const modelTargetTransport = modelTargetFormat ? resolveTransport(provider, modelTargetFormat) : null;
  const useTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat))
    ? runtimeTransport
    : modelTargetTransport;
  const targetFormat = useTransport?.format || modelTargetFormat || getTargetFormat(provider, credentials);
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  const stripList = getModelStrip(alias, model);

  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const upstreamModel = getModelUpstreamId(alias, model, body);
  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.GEMINI;
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true;
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);

  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    try {
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: undefined });
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) {
      log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`);
    }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  if (passthrough) {
    translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) };
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model);
  } else {
    translatedBody = translateRequest(
      sourceFormat,
      targetFormat,
      upstreamModel,
      body,
      stream,
      credentials,
      provider,
      reqLogger,
      stripList,
      connectionId
    );
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._customToolNames;
    translatedBody.model = stripThinkingSuffix(upstreamModel);
    stripContinuityFields(translatedBody);
  }

  if (Array.isArray(translatedBody.tools)) {
    const { tools: deduped } = dedupeTools(translatedBody.tools, { clientTool, model, messages: translatedBody.messages });
    translatedBody.tools = deduped;
  }

  const finalFormat = passthrough ? sourceFormat : targetFormat;

  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter((msg) => msg.role !== "tool");
    delete translatedBody.tools;
  }

  if (shouldDefaultClaudeToolType(provider, finalFormat, translatedBody.tools, PROVIDERS)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }

  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody);

  const translateDurationMs = Math.round(performance.now() - translateStartMs);
  traceContext?.recordTranslateSpan?.({
    durationMs: translateDurationMs,
    sourceFormat,
    targetFormat: finalFormat,
    provider,
    model,
  });

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => {});

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log,
    provider,
    model,
    reqTag,
  });

  let providerResponse, providerUrl, providerHeaders, finalBody;
  let providerResponseFormat = targetFormat;
  const attemptStartMs = performance.now();

  try {
    const result = await executor.execute({
      model,
      body: translatedBody,
      stream,
      credentials,
      providerSessionId: sessionSeed,
      clientTool,
      signal: streamController.signal,
      log,
      proxyOptions: null,
      providerOverrides,
    });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const status = error.name === "AbortError" ? 499 : (String(error.message || "").includes("SSRF blocked") ? 403 : HTTP_STATUS.BAD_GATEWAY);
    traceContext?.recordAttemptSpan?.({
      provider,
      model,
      connectionId,
      targetFormat: finalFormat,
      startedAtMs: Math.round(attemptStartMs),
      durationMs: Math.round(performance.now() - attemptStartMs),
      httpStatus: status,
      status: error.name === "AbortError" ? "cancelled" : "error",
      errorMessage: error.message || String(error),
      upstreamRequest: translatedBody,
      upstreamUrl: providerUrl,
    });
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${status}` }).catch(() => {});
    saveRequestDetail(buildRequestDetail({
      provider,
      model,
      connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status, thinking: null },
      status: "error",
    })).catch(() => {});

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, status);
    return createErrorResult(status, errMsg);
  }

  // Handle 401/403 - try on-demand credential refresh (e.g. Vertex SA / ADC)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log), 2, log);
      if (newCredentials?.accessToken) {
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch {}
        }
        const retryResult = await executor.execute({
          model,
          body: translatedBody,
          stream,
          credentials,
          providerSessionId: sessionSeed,
          clientTool,
          signal: streamController.signal,
          log,
          proxyOptions: null,
          providerOverrides,
        });
        if (retryResult.response.ok) {
          providerResponse = retryResult.response;
          providerUrl = retryResult.url;
          providerHeaders = retryResult.headers;
          finalBody = retryResult.transformedBody;
          providerResponseFormat = retryResult.responseFormat || targetFormat;
        }
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);
    traceContext?.recordAttemptSpan?.({
      provider,
      model,
      connectionId,
      targetFormat: finalFormat,
      startedAtMs: Math.round(attemptStartMs),
      durationMs: Math.round(performance.now() - attemptStartMs),
      httpStatus: statusCode,
      status: "error",
      errorMessage: message,
      upstreamRequest: finalBody || translatedBody,
      upstreamUrl: providerUrl,
    });
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => {});
    saveRequestDetail(buildRequestDetail({
      provider,
      model,
      connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      status: "error",
    })).catch(() => {});

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs, upstreamResponseHeaders(providerResponse.headers));
  }

  const sharedCtx = {
    provider,
    model,
    body,
    stream,
    translatedBody,
    finalBody,
    requestStartTime,
    connectionId,
    apiKey,
    clientRawRequest,
    onRequestSuccess,
    reqTag,
    log,
    traceContext,
    attemptStartMs,
    providerUrl,
    targetFormat: finalFormat,
  };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => {});
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  if (!clientRequestedStreaming && (providerRequiresStreaming || providerResponseFormat === FORMATS.OPENAI_RESPONSES)) {
    const result = await handleForcedSSEToJson({
      ...sharedCtx,
      providerResponse,
      sourceFormat,
      targetFormat: providerResponseFormat,
      customToolNames,
      toolNameMap,
      trackDone,
      appendLog,
    });
    if (result) {
      streamController.handleComplete();
      return result;
    }
  }

  if (!stream) {
    const result = await handleNonStreamingResponse({
      ...sharedCtx,
      providerResponse,
      sourceFormat,
      targetFormat: providerResponseFormat,
      reqLogger,
      toolNameMap,
      customToolNames,
      trackDone,
      appendLog,
    });
    streamController.handleComplete();
    return result;
  }

  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({
    ...sharedCtx,
    providerResponse,
    sourceFormat,
    targetFormat: providerResponseFormat,
    userAgent,
    reqLogger,
    toolNameMap,
    customToolNames,
    streamController,
    onStreamComplete,
    streamDetailId,
    credentials,
  });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
