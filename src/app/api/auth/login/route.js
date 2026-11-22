import { NextResponse } from "next/server";
import { buildAuthSetCookieHeader, verifyDashboardPassword } from "@/lib/auth/dashboardSession.js";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter.js";
import { jsonLogger } from "@/lib/logging/logger.js";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
        { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(lock.retryAfter) } }
      );
    }

    const body = await request.json().catch(() => ({}));
    const password = typeof body?.password === "string" ? body.password : "";
    const isValid = await verifyDashboardPassword(password);

    if (isValid) {
      recordSuccess(ip);
      const setCookie = await buildAuthSetCookieHeader(request);
      jsonLogger.info("auth.login_success", { ip });
      return NextResponse.json(
        { success: true },
        { headers: { ...NO_STORE_HEADERS, "Set-Cookie": setCookie } }
      );
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    jsonLogger.warn("auth.login_failed", { ip, locked: postLock.locked });

    if (postLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s.`, retryAfter: postLock.retryAfter },
        { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(postLock.retryAfter) } }
      );
    }

    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message || "Authentication failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
