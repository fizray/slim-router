import { getProviderConnections, authenticateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutex anchored on globalThis to prevent race conditions during account selection
const getMutexState = () => (globalThis.__9r_selectionMutex ??= { promise: Promise.resolve() });

export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;

  const mutex = getMutexState();
  const prevMutex = mutex.promise;
  let resolveMutex;
  mutex.promise = new Promise((resolve) => { resolveMutex = resolve; });

  try {
    await prevMutex;

    const providerId = resolveProviderId(provider);
    const connections = await getProviderConnections({ provider: providerId, isActive: true });

    if (connections.length === 0) {
      return null;
    }

    const availableConnections = connections.filter((c) => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    if (availableConnections.length === 0) {
      const lockedConns = connections.filter((c) => isModelLockActive(c, model));
      const expiries = lockedConns.map((c) => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null,
        };
      }
      return null;
    }

    const settings = await getSettings();
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
    }

    if (!connection) {
      if (strategy === "round-robin") {
        const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;
        const byRecency = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return 1;
          if (!b.lastUsedAt) return -1;
          return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
        });
        const current = byRecency[0];
        const currentCount = current?.consecutiveUseCount || 0;

        if (current && current.lastUsedAt && currentCount < stickyLimit) {
          connection = current;
          await updateProviderConnection(connection.id, {
            lastUsedAt: new Date().toISOString(),
            consecutiveUseCount: currentCount + 1,
          });
        } else {
          const sortedByOldest = [...availableConnections].sort((a, b) => {
            if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
            if (!a.lastUsedAt) return -1;
            if (!b.lastUsedAt) return 1;
            return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
          });
          connection = sortedByOldest[0];
          await updateProviderConnection(connection.id, {
            lastUsedAt: new Date().toISOString(),
            consecutiveUseCount: 1,
          });
        }
      } else {
        connection = availableConnections[0];
      }
    }

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      providerSpecificData: { ...(connection.providerSpecificData || {}) },
      connectionId: connection.id,
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      _connection: connection,
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId) return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider: resolveProviderId(provider) });
  const conn = connections.find((c) => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }

  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
  });

  log.warn("AUTH", `${connectionId.slice(0, 8)} locked for ${Math.round(cooldownMs / 1000)}s [${status}]`);
  return { shouldFallback: true, cooldownMs };
}

export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId) return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter((k) => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  const keysToClear = allLockKeys.filter((k) => {
    if (model && k === `modelLock_${model}`) return true;
    if (model && k === "modelLock___all") return true;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  const remainingActiveLocks = allLockKeys.filter((k) => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map((k) => [k, null]));
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

export function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) return xApiKey.trim();
  const googKey = request.headers.get("x-goog-api-key");
  if (googKey) return googKey.trim();
  try {
    return new URL(request.url).searchParams.get("key")?.trim() || null;
  } catch {
    return null;
  }
}

export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return Boolean(await authenticateApiKey(apiKey));
}
