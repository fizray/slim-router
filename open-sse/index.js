// Patch global fetch with hardened SSRF + TLS transport (must be first)
import "./utils/proxyFetch.js";

// Config
export { PROVIDERS } from "./config/providers.js";
export { CLAUDE_SYSTEM_PROMPT } from "./config/appConstants.js";
export { CACHE_TTL, DEFAULT_MAX_TOKENS, COOLDOWN_MS, BACKOFF_CONFIG } from "./config/runtimeConfig.js";
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel,
  findModelName,
  getModelTargetFormat,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
} from "./config/providerModels.js";

// Translator
export { FORMATS } from "./translator/formats.js";
export {
  register,
  translateRequest,
  translateResponse,
  needsTranslation,
  initState,
  initTranslators,
} from "./translator/index.js";

// Services
export { detectFormat, getTargetFormat } from "./services/provider.js";
export { parseModel, resolveModelAliasFromMap, getModelInfoCore } from "./services/model.js";
export {
  checkFallbackError,
  isAccountUnavailable,
  getUnavailableUntil,
  filterAvailableAccounts,
} from "./services/accountFallback.js";
export {
  parseVertexSaJson,
  parseVertexAdcJson,
  refreshVertexToken,
  refreshGoogleToken,
  refreshWithRetry,
} from "./services/vertexAuth.js";

// Handlers
export { handleChatCore } from "./handlers/chatCore.js";
export { createStreamController, pipeWithDisconnect, createDisconnectAwareStream } from "./utils/streamHandler.js";

// Executors
export { getExecutor, hasSpecializedExecutor } from "./executors/index.js";

// Utils
export { errorResponse, formatProviderError } from "./utils/error.js";
export {
  createSSETransformStreamWithLogger,
  createPassthroughStreamWithLogger,
} from "./utils/stream.js";
