import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  ANTHROPIC_API_VERSION,
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
  selectAnthropicBeta,
  mergeAnthropicBeta,
} from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { stripUnsupportedParams } from "../translator/concerns/paramSupport.js";

const BEARER = { combined: true, header: "Authorization", scheme: "bearer" };
const XAPIKEY = { combined: true, header: "x-api-key", scheme: "raw" };
const AUTH_DESCRIPTORS = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, t]) => t.auth)
    .map(([id, t]) => [id, t.auth])
);

function setAuth(headers, spec, token) {
  if (!token) return;
  headers[spec.header] = spec.scheme === "bearer" ? `Bearer ${token}` : token;
}

function applyAuth(headers, desc, credentials) {
  if (desc.combined) {
    setAuth(headers, desc, credentials.apiKey || credentials.accessToken);
    if (desc.anthropicVersion && !headers["anthropic-version"]) {
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    }
    return;
  }
  if (credentials.apiKey) setAuth(headers, desc.apiKey, credentials.apiKey);
  else if (credentials.accessToken) setAuth(headers, desc.oauth, credentials.accessToken);
  if (desc.anthropicVersion && !headers["anthropic-version"]) {
    headers["anthropic-version"] = ANTHROPIC_API_VERSION;
  }
}

export class DefaultExecutor extends BaseExecutor {
  constructor(provider) {
    super(provider, PROVIDERS[provider] || PROVIDERS.gemini);
  }

  transformRequest(model, body, stream, credentials) {
    let transformed = this.applyJsonSchemaFallback(body);

    if (transformed && typeof transformed === "object") {
      if (stream !== true && transformed.stream_options !== undefined && transformed.stream !== true) {
        if (transformed === body) transformed = { ...transformed };
        delete transformed.stream_options;
      }
      if (this.config.quirks?.dropClientMetadata) {
        if (transformed === body) transformed = { ...transformed };
        delete transformed.client_metadata;
      }
      stripUnsupportedParams(this.provider, model, transformed);
    }

    return injectReasoningContent({ provider: this.provider, model, body: transformed });
  }

  applyJsonSchemaFallback(body) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return body;
    const rf = body?.response_format;
    if (rf?.type !== "json_schema" || !rf.json_schema?.schema) return body;

    const schemaJson = JSON.stringify(rf.json_schema.schema, null, 2);
    const prompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;

    const messages = Array.isArray(body.messages) ? body.messages.map((m) => ({ ...m })) : [];
    const sys = messages.find((m) => m.role === "system");
    if (sys) {
      if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${prompt}`;
      else if (Array.isArray(sys.content)) sys.content.push({ type: "text", text: `\n\n${prompt}` });
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages, response_format: { type: "json_object" } };
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const rt = credentials?.runtimeTransport;
    if (rt?.baseUrl) {
      return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
    }
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses"
        ? "/responses"
        : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    if (this.config.format === "gemini") {
      return `${this.config.baseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    }
    if (this.config.urlSuffix) {
      return `${this.config.baseUrl}${this.config.urlSuffix}`;
    }
    const url = this.config.baseUrl;
    if (url?.includes("{accountId}")) {
      const accountId = credentials?.providerSpecificData?.accountId;
      if (!accountId) throw new Error(`${this.provider} requires accountId in providerSpecificData`);
      return url.replace("{accountId}", accountId);
    }
    return url;
  }

  resolveAuthDescriptor() {
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      return {
        apiKey: { header: "x-api-key", scheme: "raw" },
        oauth: { header: "Authorization", scheme: "bearer" },
        anthropicVersion: true,
      };
    }
    if (this.config?.format === "claude") {
      return { ...XAPIKEY, anthropicVersion: true };
    }
    return BEARER;
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const rt = credentials?.runtimeTransport;
    const headers = { "Content-Type": "application/json", ...(rt ? rt.headers : this.config.headers) };
    const desc = rt?.auth || AUTH_DESCRIPTORS[this.provider] || this.resolveAuthDescriptor();
    applyAuth(headers, desc, credentials);

    const isClaudeModel = typeof model === "string" && /^claude-/.test(model);
    const clientBeta = credentials?.rawHeaders?.["anthropic-beta"];
    if (model && this.provider?.startsWith?.("anthropic-compatible-") && isClaudeModel) {
      headers["Anthropic-Beta"] = mergeAnthropicBeta(selectAnthropicBeta(model, body), clientBeta);
    } else if (this.provider === "anthropic" && clientBeta) {
      headers["Anthropic-Beta"] = mergeAnthropicBeta(headers["Anthropic-Beta"], clientBeta);
    }

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (!isOfficialAnthropic) {
        if (credentials.apiKey && !headers["Authorization"]) {
          headers["Authorization"] = `Bearer ${credentials.apiKey}`;
        }
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async refreshCredentials() {
    return null;
  }
}

export default DefaultExecutor;
