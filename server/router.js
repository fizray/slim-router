/**
 * Explicit API & Multimodal Inference Route Table (Pure Node 26 — zero Next.js).
 * Maps URL paths (including /v1/* and /v1beta/* aliases) to Web-standard route modules.
 */

const EXACT_ROUTES = new Map([
  // Health & Auth
  ["/api/health", () => import("@/app/api/health/route.js")],
  ["/api/auth/login", () => import("@/app/api/auth/login/route.js")],
  ["/api/auth/logout", () => import("@/app/api/auth/logout/route.js")],
  ["/api/auth/status", () => import("@/app/api/auth/status/route.js")],

  // Analytics & Tracing
  ["/api/analytics/overview", () => import("@/app/api/analytics/overview/route.js")],
  ["/api/analytics/performance", () => import("@/app/api/analytics/performance/route.js")],
  ["/api/analytics/cost", () => import("@/app/api/analytics/cost/route.js")],
  ["/api/analytics/cache", () => import("@/app/api/analytics/cache/route.js")],
  ["/api/analytics/reliability", () => import("@/app/api/analytics/reliability/route.js")],
  ["/api/analytics/traces", () => import("@/app/api/analytics/traces/route.js")],

  // Management APIs
  ["/api/providers", () => import("@/app/api/providers/route.js")],
  ["/api/keys", () => import("@/app/api/keys/route.js")],
  ["/api/combos", () => import("@/app/api/combos/route.js")],
  ["/api/models", () => import("@/app/api/models/route.js")],
  ["/api/models/alias", () => import("@/app/api/models/alias/route.js")],
  ["/api/models/custom", () => import("@/app/api/models/custom/route.js")],
  ["/api/models/disabled", () => import("@/app/api/models/disabled/route.js")],
  ["/api/models/catalog-sync", () => import("@/app/api/models/catalog-sync/route.js")],
  ["/api/pricing", () => import("@/app/api/pricing/route.js")],
  ["/api/settings", () => import("@/app/api/settings/route.js")],
  ["/api/settings/database", () => import("@/app/api/settings/database/route.js")],
  ["/api/backups", () => import("@/app/api/backups/route.js")],
  ["/api/media-providers/tts/voices", () => import("@/app/api/media-providers/tts/voices/route.js")],

  // Multimodal Inference (/v1/* and /api/v1/*)
  ["/v1", () => import("@/app/api/v1/route.js")],
  ["/api/v1", () => import("@/app/api/v1/route.js")],
  ["/v1/models", () => import("@/app/api/v1/models/route.js")],
  ["/api/v1/models", () => import("@/app/api/v1/models/route.js")],
  ["/v1/models/info", () => import("@/app/api/v1/models/info/route.js")],
  ["/api/v1/models/info", () => import("@/app/api/v1/models/info/route.js")],
  ["/v1/chat/completions", () => import("@/app/api/v1/chat/completions/route.js")],
  ["/api/v1/chat/completions", () => import("@/app/api/v1/chat/completions/route.js")],
  ["/v1/messages", () => import("@/app/api/v1/messages/route.js")],
  ["/api/v1/messages", () => import("@/app/api/v1/messages/route.js")],
  ["/v1/messages/count_tokens", () => import("@/app/api/v1/messages/count_tokens/route.js")],
  ["/api/v1/messages/count_tokens", () => import("@/app/api/v1/messages/count_tokens/route.js")],
  ["/v1/responses", () => import("@/app/api/v1/responses/route.js")],
  ["/api/v1/responses", () => import("@/app/api/v1/responses/route.js")],
  ["/v1/responses/compact", () => import("@/app/api/v1/responses/compact/route.js")],
  ["/api/v1/responses/compact", () => import("@/app/api/v1/responses/compact/route.js")],
  ["/v1/embeddings", () => import("@/app/api/v1/embeddings/route.js")],
  ["/api/v1/embeddings", () => import("@/app/api/v1/embeddings/route.js")],
  ["/v1/images/generations", () => import("@/app/api/v1/images/generations/route.js")],
  ["/api/v1/images/generations", () => import("@/app/api/v1/images/generations/route.js")],
  ["/v1/audio/speech", () => import("@/app/api/v1/audio/speech/route.js")],
  ["/api/v1/audio/speech", () => import("@/app/api/v1/audio/speech/route.js")],
  ["/v1/audio/transcriptions", () => import("@/app/api/v1/audio/transcriptions/route.js")],
  ["/api/v1/audio/transcriptions", () => import("@/app/api/v1/audio/transcriptions/route.js")],
  ["/v1/audio/voices", () => import("@/app/api/v1/audio/voices/route.js")],
  ["/api/v1/audio/voices", () => import("@/app/api/v1/audio/voices/route.js")],
  ["/v1/videos/generations", () => import("@/app/api/v1/videos/generations/route.js")],
  ["/api/v1/videos/generations", () => import("@/app/api/v1/videos/generations/route.js")],
  ["/v1/videos/edits", () => import("@/app/api/v1/videos/edits/route.js")],
  ["/api/v1/videos/edits", () => import("@/app/api/v1/videos/edits/route.js")],
  ["/v1/videos/extensions", () => import("@/app/api/v1/videos/extensions/route.js")],
  ["/api/v1/videos/extensions", () => import("@/app/api/v1/videos/extensions/route.js")],

  // Native Gemini /v1beta/*
  ["/v1beta/models", () => import("@/app/api/v1beta/models/route.js")],
  ["/api/v1beta/models", () => import("@/app/api/v1beta/models/route.js")],
]);

const DYNAMIC_ROUTES = [
  {
    re: /^\/api\/analytics\/traces\/([^/]+)$/,
    params: (m) => ({ traceId: decodeURIComponent(m[1]) }),
    load: () => import("@/app/api/analytics/traces/[traceId]/route.js"),
  },
  {
    re: /^\/api\/providers\/([^/]+)\/test$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
    load: () => import("@/app/api/providers/[id]/test/route.js"),
  },
  {
    re: /^\/api\/providers\/([^/]+)\/models$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
    load: () => import("@/app/api/providers/[id]/models/route.js"),
  },
  {
    re: /^\/api\/providers\/([^/]+)$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
    load: () => import("@/app/api/providers/[id]/route.js"),
  },
  {
    re: /^\/api\/keys\/([^/]+)$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
    load: () => import("@/app/api/keys/[id]/route.js"),
  },
  {
    re: /^\/api\/combos\/([^/]+)$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
    load: () => import("@/app/api/combos/[id]/route.js"),
  },
  {
    re: /^(?:\/api)?\/v1\/videos\/([^/]+)$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
    load: () => import("@/app/api/v1/videos/[id]/route.js"),
  },
  {
    re: /^(?:\/api)?\/v1\/models\/(.+)$/,
    params: (m) => ({ model: m[1].split("/").map(decodeURIComponent) }),
    load: () => import("@/app/api/v1/models/[...model]/route.js"),
  },
  {
    re: /^(?:\/api)?\/v1beta\/models\/(.+)$/,
    params: (m) => ({ path: m[1].split("/").map(decodeURIComponent) }),
    load: () => import("@/app/api/v1beta/models/[...path]/route.js"),
  },
];

const moduleCache = new Map();

async function loadCached(key, loader) {
  let mod = moduleCache.get(key);
  if (!mod) {
    mod = await loader();
    moduleCache.set(key, mod);
  }
  return mod;
}

export async function matchApiRoute(pathname) {
  const clean = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const exact = EXACT_ROUTES.get(clean);
  if (exact) {
    const mod = await loadCached(clean, exact);
    return { mod, params: {} };
  }

  for (let i = 0; i < DYNAMIC_ROUTES.length; i++) {
    const entry = DYNAMIC_ROUTES[i];
    const m = clean.match(entry.re);
    if (m) {
      const mod = await loadCached(`dyn:${i}`, entry.load);
      return { mod, params: entry.params(m) };
    }
  }
  return null;
}
