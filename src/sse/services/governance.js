/**
 * Per-API-Key Governance Engine (anchored on `globalThis.__9r_governance`).
 *
 * Enforces before touching upstream providers:
 * 1. Sliding-window RPM (Requests Per Minute) & TPM (Tokens Per Minute)
 * 2. Daily & Monthly USD Spend Budget Caps (per-key + global)
 * 3. In-flight pre-reservation (holds estimated tokens & USD while streaming
 *    requests are active so concurrent requests cannot race past budget caps)
 */

import { getApiKeySpendWindow, getGlobalSpendWindow } from "@/lib/db/repos/telemetryRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";

const WINDOW_MS = 60_000;
const SPEND_CACHE_TTL_MS = 5_000;

function getState() {
  if (!globalThis.__9r_governance) {
    globalThis.__9r_governance = {
      // keyId -> { reqTimestamps: number[], tokenEvents: { ts: number, tokens: number }[] }
      windows: new Map(),
      // keyId -> { inFlightUsd: number, inFlightTokens: number, cachedDailyUsd: number, cachedMonthlyUsd: number, cachedAt: number }
      budgets: new Map(),
      globalBudget: { inFlightUsd: 0, cachedDailyUsd: 0, cachedMonthlyUsd: 0, cachedAt: 0 },
    };
  }
  return globalThis.__9r_governance;
}

function getKeyWindow(keyId) {
  const st = getState();
  let win = st.windows.get(keyId);
  if (!win) {
    win = { reqTimestamps: [], tokenEvents: [] };
    st.windows.set(keyId, win);
  }
  const cutoff = Date.now() - WINDOW_MS;
  while (win.reqTimestamps.length && win.reqTimestamps[0] < cutoff) win.reqTimestamps.shift();
  while (win.tokenEvents.length && win.tokenEvents[0].ts < cutoff) win.tokenEvents.shift();
  return win;
}

function getKeyBudgetState(keyId) {
  const st = getState();
  let b = st.budgets.get(keyId);
  if (!b) {
    b = { inFlightUsd: 0, inFlightTokens: 0, cachedDailyUsd: 0, cachedMonthlyUsd: 0, cachedAt: 0 };
    st.budgets.set(keyId, b);
  }
  return b;
}

/**
 * Conservative pre-flight estimate of input tokens & USD cost for budget reservation.
 */
export async function estimateRequestReservation(body, provider, model) {
  let rawBytes = 512;
  try {
    rawBytes = typeof body === "string" ? Buffer.byteLength(body, "utf8") : Buffer.byteLength(JSON.stringify(body || {}), "utf8");
  } catch {}
  const estInputTokens = Math.max(16, Math.ceil(rawBytes / 4));
  const estOutputReserve = Math.min(Number(body?.max_tokens || body?.max_completion_tokens || 1024), 4096);
  const estTotalTokens = estInputTokens + estOutputReserve;

  let estUsd = 0.002; // conservative floor when pricing unknown
  try {
    const pricing = await getPricingForModel(provider, model);
    if (pricing) {
      const inRate = Number(pricing.input || 0);
      const outRate = Number(pricing.output || 0);
      estUsd = (estInputTokens / 1_000_000) * inRate + (estOutputReserve / 1_000_000) * outRate;
      if (estUsd <= 0) estUsd = 0.0001;
    }
  } catch {}

  return { estTokens: estTotalTokens, estUsd };
}

/**
 * Check RPM, TPM, and Budget caps, and reserve in-flight hold.
 * Returns `{ allowed: true, headers, release(actualCostUsd, actualTokens) }`
 * or `{ allowed: false, status, error, headers }`.
 */
export async function checkAndReserveGovernance(keyRecord, { body = null, provider = "", model = "" } = {}) {
  if (!keyRecord?.id) {
    return { allowed: true, headers: {}, release: () => {} };
  }

  const keyId = keyRecord.id;
  const bState = getKeyBudgetState(keyId);
  const st = getState();

  // Phase A: Perform all async lookups BEFORE entering the synchronous check-and-reserve critical section.
  const { estTokens, estUsd } = await estimateRequestReservation(body, provider, model);

  if (keyRecord.dailyBudgetUsd || keyRecord.monthlyBudgetUsd) {
    if (Date.now() - bState.cachedAt > SPEND_CACHE_TTL_MS) {
      const spend = await getApiKeySpendWindow(keyId);
      bState.cachedDailyUsd = spend.dailyUsd;
      bState.cachedMonthlyUsd = spend.monthlyUsd;
      bState.cachedAt = Date.now();
    }
  }

  const settings = await getSettings();
  if (settings.globalDailyBudgetUsd || settings.globalMonthlyBudgetUsd) {
    const gb = st.globalBudget;
    if (Date.now() - gb.cachedAt > SPEND_CACHE_TTL_MS) {
      const spend = await getGlobalSpendWindow();
      gb.cachedDailyUsd = spend.dailyUsd;
      gb.cachedMonthlyUsd = spend.monthlyUsd;
      gb.cachedAt = Date.now();
    }
  }

  // Phase B: Strictly synchronous check-and-reserve (ZERO awaits — prevents concurrent TOCTOU races).
  const now = Date.now();
  const win = getKeyWindow(keyId);

  // 1. RPM check
  const rpmLimit = keyRecord.rpmLimit || null;
  if (rpmLimit && win.reqTimestamps.length >= rpmLimit) {
    const oldest = win.reqTimestamps[0] || now;
    const retryAfter = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return {
      allowed: false,
      status: 429,
      error: `Rate limit exceeded: ${rpmLimit} requests/min`,
      errorCategory: "rate_limit",
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit-Requests": String(rpmLimit),
        "X-RateLimit-Remaining-Requests": "0",
      },
    };
  }

  // 2. TPM check (recent window tokens + in-flight hold)
  const tpmLimit = keyRecord.tpmLimit || null;
  const usedTokensInWindow = win.tokenEvents.reduce((acc, e) => acc + e.tokens, 0) + bState.inFlightTokens;
  if (tpmLimit && usedTokensInWindow + estTokens > tpmLimit) {
    const oldest = win.tokenEvents[0]?.ts || now;
    const retryAfter = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return {
      allowed: false,
      status: 429,
      error: `Token rate limit exceeded: ${tpmLimit} tokens/min`,
      errorCategory: "rate_limit",
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit-Tokens": String(tpmLimit),
        "X-RateLimit-Remaining-Tokens": String(Math.max(0, tpmLimit - usedTokensInWindow)),
      },
    };
  }

  // 3. Per-key Daily & Monthly Budget Cap check (actual spend + in-flight pre-reservation)
  if (keyRecord.dailyBudgetUsd && bState.cachedDailyUsd + bState.inFlightUsd + estUsd > keyRecord.dailyBudgetUsd) {
    return {
      allowed: false,
      status: 402,
      error: `Daily budget cap ($${keyRecord.dailyBudgetUsd.toFixed(2)}) reached for API key`,
      errorCategory: "policy_denied",
      headers: {},
    };
  }
  if (keyRecord.monthlyBudgetUsd && bState.cachedMonthlyUsd + bState.inFlightUsd + estUsd > keyRecord.monthlyBudgetUsd) {
    return {
      allowed: false,
      status: 402,
      error: `Monthly budget cap ($${keyRecord.monthlyBudgetUsd.toFixed(2)}) reached for API key`,
      errorCategory: "policy_denied",
      headers: {},
    };
  }

  // 4. Global Daily & Monthly Budget Cap check
  if (settings.globalDailyBudgetUsd || settings.globalMonthlyBudgetUsd) {
    const gb = st.globalBudget;
    if (settings.globalDailyBudgetUsd && gb.cachedDailyUsd + gb.inFlightUsd + estUsd > settings.globalDailyBudgetUsd) {
      return {
        allowed: false,
        status: 402,
        error: `Global daily budget cap ($${Number(settings.globalDailyBudgetUsd).toFixed(2)}) reached`,
        errorCategory: "policy_denied",
        headers: {},
      };
    }
    if (settings.globalMonthlyBudgetUsd && gb.cachedMonthlyUsd + gb.inFlightUsd + estUsd > settings.globalMonthlyBudgetUsd) {
      return {
        allowed: false,
        status: 402,
        error: `Global monthly budget cap ($${Number(settings.globalMonthlyBudgetUsd).toFixed(2)}) reached`,
        errorCategory: "policy_denied",
        headers: {},
      };
    }
  }

  // Reserve in-flight holds atomically in the same synchronous turn
  win.reqTimestamps.push(now);
  bState.inFlightTokens += estTokens;
  bState.inFlightUsd += estUsd;
  st.globalBudget.inFlightUsd += estUsd;

  const headers = {};
  if (rpmLimit) {
    headers["X-RateLimit-Limit-Requests"] = String(rpmLimit);
    headers["X-RateLimit-Remaining-Requests"] = String(Math.max(0, rpmLimit - win.reqTimestamps.length));
  }
  if (tpmLimit) {
    headers["X-RateLimit-Limit-Tokens"] = String(tpmLimit);
    headers["X-RateLimit-Remaining-Tokens"] = String(Math.max(0, tpmLimit - usedTokensInWindow - estTokens));
  }

  let released = false;
  function release(actualCostUsd = 0, actualTokens = 0) {
    if (released) return;
    released = true;
    bState.inFlightTokens = Math.max(0, bState.inFlightTokens - estTokens);
    bState.inFlightUsd = Math.max(0, bState.inFlightUsd - estUsd);
    st.globalBudget.inFlightUsd = Math.max(0, st.globalBudget.inFlightUsd - estUsd);

    if (actualTokens > 0) {
      const w = getKeyWindow(keyId);
      w.tokenEvents.push({ ts: Date.now(), tokens: actualTokens });
    }
    if (actualCostUsd > 0) {
      bState.cachedDailyUsd += actualCostUsd;
      bState.cachedMonthlyUsd += actualCostUsd;
      st.globalBudget.cachedDailyUsd += actualCostUsd;
      st.globalBudget.cachedMonthlyUsd += actualCostUsd;
    }
  }

  return { allowed: true, headers, release };
}

export function resetGovernanceForTests() {
  globalThis.__9r_governance = {
    windows: new Map(),
    budgets: new Map(),
    globalBudget: { inFlightUsd: 0, cachedDailyUsd: 0, cachedMonthlyUsd: 0, cachedAt: 0 },
  };
}
