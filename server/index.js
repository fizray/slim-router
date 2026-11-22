/**
 * Hardened Pure Node 26 HTTP Server (Zero Next.js).
 *
 * Serves:
 *  - Hardened Management APIs (/api/*) with JWT cookie auth, CSRF check, security headers
 *  - Multimodal Inference Gateway (/v1/*, /v1beta/*) with strict API key + governance + tracing
 *  - Built Vite + shadcn/ui SPA (dist/) with immutable asset caching & SPA fallback
 *
 * Run with: node --import ./server/loader.js server/index.js
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { assertRuntimeEnv, getTrustedProxyList } from "@/lib/config/env.js";
import { initDb, startDailyBackupScheduler, flushPayloadWorker } from "@/lib/db/index.js";
import { startModelCatalogSync } from "@/lib/modelCatalog/sync.js";
import { installCatalogSource } from "open-sse/providers/catalogOverride.js";
import { getAuthTokenFromRequest, verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";
import { jsonLogger } from "@/lib/logging/logger.js";
import { matchApiRoute } from "./router.js";

// Fail-closed runtime environment validation BEFORE opening any socket or DB
try {
  assertRuntimeEnv();
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
}

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");

// Parse CLI --port / --host flags or env
const args = process.argv.slice(2);
let port = parseInt(process.env.PORT || "20128", 10);
let hostname = process.env.HOSTNAME || "0.0.0.0";
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) port = parseInt(args[++i], 10);
  if ((args[i] === "--host" || args[i] === "-H") && args[i + 1]) hostname = args[++i];
}

// Per-process internal peer token for trusted client IP/proto stamping
const PEER_TOKEN = crypto.randomBytes(32).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

const TRUSTED_PROXY_IPS = new Set(getTrustedProxyList().map((s) => (s.startsWith("::ffff:") ? s.slice(7) : s)));

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
]);

function normalizeIp(ip) {
  if (!ip) return "";
  let s = String(ip).trim();
  if (s.startsWith("::ffff:")) s = s.slice(7);
  return s;
}

function isTrustedProxy(ip) {
  return TRUSTED_PROXY_IPS.has(normalizeIp(ip));
}

function resolveClientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || "");
  if (!socketIp || !isTrustedProxy(socketIp)) {
    return socketIp || "unknown";
  }
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const chain = xff.split(",").map((s) => normalizeIp(s)).filter(Boolean);
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(chain[i])) return chain[i];
    }
    if (chain.length > 0) return chain[0];
  }
  const realIp = normalizeIp(req.headers["x-real-ip"]);
  if (realIp) return realIp;
  return socketIp;
}

function resolveEffectiveProto(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || "");
  if (isTrustedProxy(socketIp)) {
    const xfp = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    if (xfp === "https" || xfp === "http") return xfp;
  }
  return req.socket?.encrypted ? "https" : "http";
}

function isInferencePath(pathname) {
  return (
    pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/v1beta/") ||
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/") ||
    pathname.startsWith("/api/v1beta/")
  );
}

function checkCsrfOrigin(req, effectiveProto) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  if (!host) return false;
  if (!origin && !referer) return true; // non-browser curl/API tools
  const check = (val) => {
    try {
      const u = new URL(val);
      return u.host.toLowerCase() === host && (u.protocol === "http:" || u.protocol === "https:");
    } catch {
      return false;
    }
  };
  if (origin) return check(origin);
  if (referer) return check(referer);
  return true;
}

function applySecurityHeaders(nodeRes) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!nodeRes.hasHeader(k)) nodeRes.setHeader(k, v);
  }
}

function sendJson(nodeRes, status, payload, extraHeaders = {}) {
  applySecurityHeaders(nodeRes);
  nodeRes.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  nodeRes.end(JSON.stringify(payload));
}

function buildWebRequest(req, effectiveProto, clientIp) {
  const host = req.headers.host || `127.0.0.1:${port}`;
  const url = `${effectiveProto}://${host}${req.url || "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  headers.set("x-9r-real-ip", clientIp);
  headers.set("x-9r-proto", effectiveProto);
  headers.set("x-9r-peer-token", PEER_TOKEN);

  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const init = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendWebResponse(nodeRes, webRes) {
  applySecurityHeaders(nodeRes);
  const status = webRes.status || 200;

  // Preserve multiple Set-Cookie headers cleanly
  const setCookies = typeof webRes.headers.getSetCookie === "function" ? webRes.headers.getSetCookie() : [];
  for (const [k, v] of webRes.headers.entries()) {
    if (k.toLowerCase() === "set-cookie") continue;
    nodeRes.setHeader(k, v);
  }
  if (setCookies.length > 0) {
    nodeRes.setHeader("Set-Cookie", setCookies);
  }

  nodeRes.writeHead(status);
  if (!webRes.body) {
    nodeRes.end();
    return;
  }

  // True zero-buffering streaming for SSE / media / JSON responses
  const nodeStream = Readable.fromWeb(webRes.body);
  nodeStream.on("error", () => {
    try { nodeRes.end(); } catch {}
  });
  nodeRes.on("close", () => {
    try { nodeStream.destroy(); } catch {}
  });
  nodeStream.pipe(nodeRes);
}

function tryServeStatic(pathname, nodeRes) {
  const safePath = path.posix.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const tryDirs = [DIST_DIR, PUBLIC_DIR];
  for (const base of tryDirs) {
    const filePath = path.join(base, safePath === "/" ? "index.html" : safePath);
    if (!filePath.startsWith(base)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        applySecurityHeaders(nodeRes);
        const cacheControl = safePath.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : ext === ".html"
            ? "no-cache"
            : "public, max-age=3600";
        nodeRes.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": stat.size,
          "Cache-Control": cacheControl,
        });
        fs.createReadStream(filePath).pipe(nodeRes);
        return true;
      }
    } catch {}
  }

  // SPA fallback to dist/index.html for client-side routes
  const indexHtml = path.join(DIST_DIR, "index.html");
  if (fs.existsSync(indexHtml)) {
    const stat = fs.statSync(indexHtml);
    applySecurityHeaders(nodeRes);
    nodeRes.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(indexHtml).pipe(nodeRes);
    return true;
  }
  return false;
}

async function handleRequest(req, res) {
  try {
    const clientIp = resolveClientIp(req);
    const effectiveProto = resolveEffectiveProto(req);
    const parsed = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsed.pathname;

    // 1. Check API & Inference routes
    const matched = await matchApiRoute(pathname);
    if (matched) {
      const method = (req.method || "GET").toUpperCase();

      // Management API security checks (inference endpoints enforce strict API key auth inside handlers)
      if (!isInferencePath(pathname) && !PUBLIC_API_PATHS.has(pathname)) {
        const webReqForAuth = { headers: { get: (k) => req.headers[k.toLowerCase()] || null } };
        const token = getAuthTokenFromRequest(webReqForAuth);
        const authed = await verifyDashboardAuthToken(token);
        if (!authed) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }
        if (!checkCsrfOrigin(req, effectiveProto)) {
          return sendJson(res, 403, { error: "Cross-origin request rejected (CSRF)" });
        }
      } else if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") {
        if (!checkCsrfOrigin(req, effectiveProto)) {
          return sendJson(res, 403, { error: "Cross-origin request rejected (CSRF)" });
        }
      }

      const handler = matched.mod[method] || (method === "HEAD" ? matched.mod.GET : null);
      if (!handler) {
        if (method === "OPTIONS" && isInferencePath(pathname)) {
          applySecurityHeaders(res);
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          });
          res.end();
          return;
        }
        return sendJson(res, 405, { error: `Method ${method} not allowed` });
      }

      const webReq = buildWebRequest(req, effectiveProto, clientIp);
      const webRes = await handler(webReq, { params: Promise.resolve(matched.params) });
      if (webRes instanceof Response) {
        await sendWebResponse(res, webRes);
      } else {
        sendJson(res, 200, webRes ?? { ok: true });
      }
      return;
    }

    // Return JSON 404 for unknown API/inference paths
    if (pathname.startsWith("/api/") || isInferencePath(pathname)) {
      return sendJson(res, 404, { error: "Not found" });
    }

    // 2. Serve Vite SPA static files
    if (!tryServeStatic(pathname, res)) {
      sendJson(res, 404, { error: "Frontend not built. Run `npm run build` first." });
    }
  } catch (err) {
    jsonLogger.error("server.unhandled_error", { error: err?.message || String(err), url: req.url });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    } else {
      try { res.end(); } catch {}
    }
  }
}

async function boot() {
  await initDb();
  await installCatalogSource().catch(() => {});
  startDailyBackupScheduler();
  startModelCatalogSync();

  const server = http.createServer(handleRequest);
  server.headersTimeout = 65_000;
  server.requestTimeout = 0; // allow long-running SSE streams & video jobs
  server.keepAliveTimeout = 60_000;

  server.listen(port, hostname, () => {
    jsonLogger.info("server.started", {
      host: hostname,
      port,
      node: process.version,
      sqlite: "node:sqlite",
      providers: ["vertex", "gemini", "vertex-partner"],
    });
  });

  const shutdown = async (signal) => {
    jsonLogger.info("server.shutdown", { signal });
    server.close(async () => {
      try { await flushPayloadWorker(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

boot().catch((err) => {
  console.error(`[FATAL] Boot failed: ${err?.stack || err}`);
  process.exit(1);
});
