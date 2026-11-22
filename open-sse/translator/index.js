import { FORMATS } from "./formats.js";
import { ensureToolCallIds, fixMissingToolResponses } from "./concerns/toolCall.js";
import { prepareClaudeRequest, ensureTrailingUserTurn } from "./formats/claude.js";
import { filterToOpenAIFormat } from "./formats/openai.js";
import { normalizeThinkingConfig } from "../services/provider.js";
import { applyThinking, captureThinking } from "./concerns/thinkingUnified.js";
import { captureSessionId } from "../utils/sessionManager.js";
import { ensureStreamToolCallIds } from "../utils/streamHelpers.js";
import { PROVIDERS } from "../providers/index.js";
import { ROLE, GEMINI_ROLE } from "./schema/roles.js";

var requestRegistry;
var responseRegistry;

export function register(from, to, requestFn, responseFn) {
  requestRegistry ??= new Map();
  responseRegistry ??= new Map();
  const key = `${from}:${to}`;
  if (requestFn) requestRegistry.set(key, requestFn);
  if (responseFn) responseRegistry.set(key, responseFn);
}

function ensureInitialized() {}

function stripContentTypes(body, stripList = []) {
  if (!stripList.length || !body.messages || !Array.isArray(body.messages)) return;
  const imageTypes = new Set(["image_url", "image"]);
  const audioTypes = new Set(["audio_url", "input_audio"]);
  const shouldStrip = (type) => {
    if (imageTypes.has(type)) return stripList.includes("image");
    if (audioTypes.has(type)) return stripList.includes("audio");
    return false;
  };
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((part) => !shouldStrip(part.type));
    if (msg.content.length === 0) msg.content = "";
  }
}

function detectClientLastRole(body) {
  if (Array.isArray(body?.messages)) return body.messages[body.messages.length - 1]?.role;
  const items = Array.isArray(body?.contents) ? body.contents : Array.isArray(body?.input) ? body.input : null;
  if (!items) return undefined;
  const role = items[items.length - 1]?.role;
  return role === ROLE.ASSISTANT || role === GEMINI_ROLE.MODEL ? ROLE.ASSISTANT : undefined;
}

export function translateRequest(
  sourceFormat,
  targetFormat,
  model,
  body,
  stream = true,
  credentials = null,
  provider = null,
  reqLogger = null,
  stripList = [],
  connectionId = null
) {
  ensureInitialized();
  let result = body;
  const clientLastRole = detectClientLastRole(body);

  stripContentTypes(result, stripList);
  normalizeThinkingConfig(result);
  ensureToolCallIds(result);
  fixMissingToolResponses(result);

  const thinkingIntent = captureThinking(result);
  const clientSessionId = captureSessionId(result, credentials, connectionId, targetFormat);
  if (credentials) credentials._clientSessionId = clientSessionId;

  const translationOptions = {
    preserveCacheControl: targetFormat === FORMATS.OPENAI && !!PROVIDERS[provider]?.quirks?.preserveCacheControl,
  };

  if (sourceFormat !== targetFormat) {
    const directFn = requestRegistry.get(`${sourceFormat}:${targetFormat}`);
    if (directFn) {
      result = directFn(model, result, stream, credentials, translationOptions);
    } else {
      if (sourceFormat !== FORMATS.OPENAI) {
        const toOpenAI = requestRegistry.get(`${sourceFormat}:${FORMATS.OPENAI}`);
        if (toOpenAI) {
          result = toOpenAI(model, result, stream, credentials, translationOptions);
          reqLogger?.logOpenAIRequest?.(result);
        }
      }
      if (targetFormat !== FORMATS.OPENAI) {
        const fromOpenAI = requestRegistry.get(`${FORMATS.OPENAI}:${targetFormat}`);
        if (fromOpenAI) {
          result = fromOpenAI(model, result, stream, credentials);
        }
      }
    }
  }

  applyThinking(targetFormat, model, result, provider, thinkingIntent);

  if (targetFormat === FORMATS.OPENAI) {
    result = filterToOpenAIFormat(result, translationOptions);
  }

  if (targetFormat === FORMATS.CLAUDE) {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    result = prepareClaudeRequest(result, provider, apiKey, connectionId, credentials?.rawHeaders, clientSessionId);
    if (Array.isArray(result?.messages)) {
      result.messages = ensureTrailingUserTurn(result.messages, clientLastRole);
    }
  }

  return result;
}

export function translateResponse(targetFormat, sourceFormat, chunk, state) {
  ensureInitialized();
  if (sourceFormat === targetFormat) {
    if (state && chunk && typeof chunk === "object") {
      if (!state.streamToolCallIds) state.streamToolCallIds = new Map();
      ensureStreamToolCallIds(chunk, state.streamToolCallIds);
    }
    return [chunk];
  }

  let results = [chunk];
  let openaiResults = null;

  const directFn = responseRegistry.get(`${targetFormat}:${sourceFormat}`);
  if (directFn) {
    const converted = directFn(chunk, state);
    return converted ? (Array.isArray(converted) ? converted : [converted]) : [];
  }

  if (targetFormat !== FORMATS.OPENAI) {
    const toOpenAI = responseRegistry.get(`${targetFormat}:${FORMATS.OPENAI}`);
    if (toOpenAI) {
      results = [];
      const converted = toOpenAI(chunk, state);
      if (converted) {
        results = Array.isArray(converted) ? converted : [converted];
        openaiResults = results;
      }
    }
  }

  if (sourceFormat !== FORMATS.OPENAI) {
    const fromOpenAI = responseRegistry.get(`${FORMATS.OPENAI}:${sourceFormat}`);
    if (fromOpenAI) {
      const finalResults = [];
      for (const r of results) {
        const converted = fromOpenAI(r, state);
        if (converted) {
          finalResults.push(...(Array.isArray(converted) ? converted : [converted]));
        }
      }
      results = finalResults;
    }
  }

  if (openaiResults && sourceFormat !== FORMATS.OPENAI && targetFormat !== FORMATS.OPENAI) {
    results._openaiIntermediate = openaiResults;
  }

  return results;
}

export function needsTranslation(sourceFormat, targetFormat) {
  return sourceFormat !== targetFormat;
}

export function initState(sourceFormat) {
  const base = {
    messageId: null,
    model: null,
    textBlockStarted: false,
    thinkingBlockStarted: false,
    inThinkingBlock: false,
    currentBlockIndex: null,
    toolCalls: new Map(),
    streamToolCallIds: new Map(),
    finishReason: null,
    finishReasonSent: false,
    usage: null,
    contentBlockIndex: -1,
  };

  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return {
      ...base,
      seq: 0,
      responseId: `resp_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      started: false,
      msgTextBuf: {},
      msgItemAdded: {},
      msgContentAdded: {},
      msgItemDone: {},
      reasoningId: "",
      reasoningIndex: -1,
      reasoningBuf: "",
      reasoningPartAdded: false,
      reasoningDone: false,
      inThinking: false,
      funcArgsBuf: {},
      funcNames: {},
      funcCallIds: {},
      funcItemAdded: {},
      funcArgsDone: {},
      funcItemDone: {},
      customToolNames: new Set(),
      responsesUsage: null,
      completionPending: false,
      completedSent: false,
    };
  }

  return base;
}

export function initTranslators() {
  ensureInitialized();
}

// Static side-effect imports (OpenAI / Responses / Claude <-> Gemini & Vertex AI)
import "./request/claude-to-openai.js";
import "./request/openai-to-claude.js";
import "./request/gemini-to-openai.js";
import "./request/openai-to-gemini.js";
import "./request/openai-to-vertex.js";
import "./request/openai-responses.js";
import "./response/claude-to-openai.js";
import "./response/openai-to-claude.js";
import "./response/gemini-to-openai.js";
import "./response/openai-responses.js";
