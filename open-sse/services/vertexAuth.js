/**
 * Standalone Google Cloud Vertex AI authentication helpers.
 * Supports:
 * - Service Account JSON (JWT RS256 assertion -> OAuth2 access token)
 * - Google ADC authorized_user JSON (refresh_token -> OAuth2 access token)
 * Cached on globalThis so Next.js 16 separate bundles share the token cache.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

function getTokenCache() {
  if (!globalThis.__9r_vertexTokenCache) {
    globalThis.__9r_vertexTokenCache = new Map();
  }
  return globalThis.__9r_vertexTokenCache;
}

function getInflightMap() {
  if (!globalThis.__9r_vertexInflight) {
    globalThis.__9r_vertexInflight = new Map();
  }
  return globalThis.__9r_vertexInflight;
}

export function parseVertexSaJson(apiKey) {
  if (typeof apiKey !== "string") return null;
  try {
    const parsed = JSON.parse(apiKey);
    if (
      parsed.type === "service_account" &&
      parsed.client_email &&
      parsed.private_key &&
      parsed.project_id
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseVertexAdcJson(apiKey) {
  if (typeof apiKey !== "string") return null;
  try {
    const parsed = JSON.parse(apiKey);
    if (
      parsed.type === "authorized_user" &&
      parsed.client_id &&
      parsed.client_secret &&
      parsed.refresh_token
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function refreshVertexToken(saJson, log = null) {
  const cache = getTokenCache();
  const cacheKey = `sa:${saJson.client_email}:${saJson.project_id}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_LEAD_MS) {
    return { accessToken: cached.token, expiresAt: cached.expiresAt };
  }

  const inflight = getInflightMap();
  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const task = (async () => {
    try {
      const { SignJWT, importPKCS8 } = await import("jose");
      log?.debug?.("VERTEX_AUTH", `Minting Vertex SA token for ${saJson.client_email}`);
      const privateKey = await importPKCS8(
        saJson.private_key.replace(/\\n/g, "\n"),
        "RS256"
      );
      const now = Math.floor(Date.now() / 1000);

      const jwt = await new SignJWT({
        scope: "https://www.googleapis.com/auth/cloud-platform",
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(saJson.client_email)
        .setAudience(GOOGLE_TOKEN_URL)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);

      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        log?.error?.("VERTEX_AUTH", `Vertex token mint failed (${res.status}): ${err.slice(0, 200)}`);
        return null;
      }

      const { access_token, expires_in } = await res.json();
      if (!access_token) return null;
      const expiresAt = Date.now() + (expires_in ?? 3600) * 1000;

      cache.set(cacheKey, { token: access_token, expiresAt });
      log?.info?.("VERTEX_AUTH", `Vertex token minted for ${saJson.client_email}`);

      return { accessToken: access_token, expiresAt };
    } catch (error) {
      log?.error?.("VERTEX_AUTH", `Vertex token error: ${error.message}`);
      return null;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, task);
  return task;
}

export async function refreshGoogleToken(refreshToken, clientId, clientSecret, log = null) {
  if (!refreshToken) return null;
  const cache = getTokenCache();
  const cacheKey = `adc:${clientId}:${refreshToken.slice(-8)}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_LEAD_MS) {
    return { accessToken: cached.token, refreshToken, expiresAt: cached.expiresAt };
  }

  const inflight = getInflightMap();
  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const task = (async () => {
    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        log?.error?.("VERTEX_AUTH", `Google ADC token refresh failed (${response.status}): ${errorText.slice(0, 200)}`);
        return null;
      }

      const tokens = await response.json();
      if (!tokens.access_token) return null;
      const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
      cache.set(cacheKey, { token: tokens.access_token, expiresAt });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        expiresAt,
      };
    } catch (error) {
      log?.error?.("VERTEX_AUTH", `Google ADC token refresh error: ${error.message}`);
      return null;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, task);
  return task;
}

export async function refreshWithRetry(refreshFn, maxRetries = 2, log = null) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    try {
      const result = await refreshFn();
      if (result) return result;
    } catch (error) {
      log?.warn?.("VERTEX_AUTH", `Refresh attempt ${attempt + 1}/${maxRetries} failed: ${error.message}`);
    }
  }
  return null;
}
