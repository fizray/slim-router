/**
 * Hardened upstream fetch layer:
 * - Strict TLS (rejectUnauthorized: true) with zero insecure cert fallback
 * - Two-tier anti-DNS-rebinding SSRF guard via undici Agent connect.lookup
 * - Supports standard env HTTP_PROXY/HTTPS_PROXY/NO_PROXY
 * - Fresh-socket replay on stale keep-alive errors
 */

import {
  MEMORY_CONFIG,
  FRESH_RETRY_KEEPALIVE_TIMEOUT_MS,
  STALE_SOCKET_ERROR_CODES,
  NON_STALE_SOCKET_ERROR_CODES,
  STALE_SOCKET_ERROR_SUBSTRINGS,
  resolveKeepAliveTimeouts,
  isFreshSocketReplayEnabled,
} from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import {
  assertUpstreamProviderUrl,
  createSsrfSafeLookup,
  isSelfhostedUrlAllowed,
} from "../../src/shared/utils/ssrfGuard.js";

const TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsCertError(err) {
  const code = err?.cause?.code || err?.code;
  return TLS_CERT_ERRORS.has(code);
}

export function isStaleSocketError(error) {
  if (!error || error.name === "AbortError" || isTlsCertError(error)) return false;
  const code = error?.cause?.code || error?.code || "";
  if (NON_STALE_SOCKET_ERROR_CODES.has(code)) return false;
  if (STALE_SOCKET_ERROR_CODES.has(code)) return true;
  const msg = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
  return STALE_SOCKET_ERROR_SUBSTRINGS.some((sub) => msg.includes(sub));
}

function getDispatcherStore() {
  if (!globalThis.__9r_dispatchers) {
    globalThis.__9r_dispatchers = {
      direct: new Map(),
      proxy: new Map(),
    };
  }
  return globalThis.__9r_dispatchers;
}

export function resetDirectDispatchersForTests() {
  const store = getDispatcherStore();
  store.direct.clear();
  store.proxy.clear();
}

let undiciModule = null;
async function getUndici() {
  if (!undiciModule) undiciModule = await import("undici");
  return undiciModule;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;
  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;
  let protocol;
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return null;
  }
  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || null;
  }
  return process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || null;
}

function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;
  try {
    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    return `http://${normalizedInput}`;
  }
}

const TLS_ECDH_CURVE = process.env.NINEROUTER_TLS_ECDH_CURVE || "X25519";
const EYEBALLS_CONNECT = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 };

function evictOldest(cacheMap) {
  if (cacheMap.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
    const oldestKey = cacheMap.keys().next().value;
    const oldest = cacheMap.get(oldestKey);
    cacheMap.delete(oldestKey);
    oldest?.close?.().catch?.(() => {});
  }
}

async function getOrCreateDirectAgent(key, { keepAliveTimeout, keepAliveMaxTimeout, allowPrivate, parsedUrl }) {
  const store = getDispatcherStore();
  const cached = store.direct.get(key);
  if (cached) return cached;

  const { Agent } = await getUndici();
  evictOldest(store.direct);
  const agent = new Agent({
    connect: {
      ...EYEBALLS_CONNECT,
      ecdhCurve: TLS_ECDH_CURVE,
      rejectUnauthorized: true,
      lookup: createSsrfSafeLookup({ allowPrivateForAllowlisted: allowPrivate, parsedUrl }),
    },
    keepAliveTimeout,
    keepAliveMaxTimeout,
  });
  store.direct.set(key, agent);
  return agent;
}

export async function getDirectDispatcher(parsedUrl = null) {
  const { keepAliveTimeout, keepAliveMaxTimeout } = resolveKeepAliveTimeouts();
  const allowPrivate = parsedUrl ? isSelfhostedUrlAllowed(parsedUrl) : false;
  const hostScope = allowPrivate ? parsedUrl.host.toLowerCase() : "public";
  const key = `direct::${hostScope}::${keepAliveTimeout}::${keepAliveMaxTimeout}`;
  return getOrCreateDirectAgent(key, { keepAliveTimeout, keepAliveMaxTimeout, allowPrivate, parsedUrl });
}

export async function getFreshRetryDispatcher(parsedUrl = null) {
  const allowPrivate = parsedUrl ? isSelfhostedUrlAllowed(parsedUrl) : false;
  const hostScope = allowPrivate ? parsedUrl.host.toLowerCase() : "public";
  const key = `fresh::${hostScope}`;
  return getOrCreateDirectAgent(key, {
    keepAliveTimeout: FRESH_RETRY_KEEPALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: FRESH_RETRY_KEEPALIVE_TIMEOUT_MS,
    allowPrivate,
    parsedUrl,
  });
}

async function getDispatcher(proxyUrl, parsedUrl, forceFreshSocket = false) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    return forceFreshSocket ? getFreshRetryDispatcher(parsedUrl) : getDirectDispatcher(parsedUrl);
  }

  const store = getDispatcherStore();
  const key = `proxy::${normalized}`;
  if (!store.proxy.has(key)) {
    evictOldest(store.proxy);
    const { ProxyAgent } = await getUndici();
    const dispatcher = new ProxyAgent({
      uri: normalized,
      connect: EYEBALLS_CONNECT,
      requestTls: { ecdhCurve: TLS_ECDH_CURVE, rejectUnauthorized: true },
    });
    store.proxy.set(key, dispatcher);
  }
  return store.proxy.get(key);
}

function isBodyReplaySafe(body) {
  return !(body && typeof body.getReader === "function" && body.locked);
}

async function executeUpstreamFetch(url, options, proxyUrl, parsedUrl, forceFreshSocket = false) {
  const { fetch: undiciFetch } = await getUndici();
  const dispatcher = await getDispatcher(proxyUrl, parsedUrl, forceFreshSocket);
  try {
    return await undiciFetch(url, { ...options, redirect: "manual", dispatcher });
  } catch (err) {
    if (
      !proxyUrl &&
      !forceFreshSocket &&
      !options.signal?.aborted &&
      isBodyReplaySafe(options.body) &&
      isFreshSocketReplayEnabled() &&
      isStaleSocketError(err)
    ) {
      dbg("FETCH", `stale keep-alive socket (${err.cause?.code || err.code || err.message}), retrying fresh socket`);
      return await executeUpstreamFetch(url, options, proxyUrl, parsedUrl, true);
    }
    throw err;
  }
}

/**
 * Tier 2: Hardened upstream provider fetch with strict TLS, DNS-rebinding SSRF guard,
 * and manual redirect validation (max 3 hops).
 */
export async function fetchProviderUpstream(url, options = {}, proxyOptions = null) {
  let currentUrl = typeof url === "string" ? url : url.toString();
  const forceFreshSocket = proxyOptions?.forceFreshSocket === true || options?.forceFreshSocket === true;
  const maxRedirects = 3;

  for (let hop = 0; ; hop++) {
    assertUpstreamProviderUrl(currentUrl);
    const parsed = new URL(currentUrl);
    const proxyUrl = normalizeProxyUrl(getEnvProxyUrl(currentUrl));
    const res = await executeUpstreamFetch(currentUrl, options, proxyUrl, parsed, forceFreshSocket);

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    if (!location) return res;

    if (hop >= maxRedirects) {
      try { await res.body?.cancel?.(); } catch {}
      throw new Error("SSRF blocked: upstream exceeded max redirects");
    }
    const nextUrl = new URL(location, currentUrl).toString();
    assertUpstreamProviderUrl(nextUrl);
    try { await res.body?.cancel?.(); } catch {}
    currentUrl = nextUrl;
  }
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  return fetchProviderUpstream(url, options, proxyOptions);
}

async function patchedFetch(url, options = {}) {
  return fetchProviderUpstream(url, options, null);
}

if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
