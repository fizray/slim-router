import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getJwtSecret, getSessionTtlSeconds } from "@/lib/config/env.js";
import { getSettings, getCurrentSessionVersion } from "@/lib/db/repos/settingsRepo.js";
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const JWT_ISSUER = "9router";
const JWT_AUDIENCE = "9router-dashboard";

function getEncodedSecret() {
  return new TextEncoder().encode(getJwtSecret());
}

export function parseCookieHeader(cookieHeader) {
  const map = new Map();
  if (!cookieHeader) return map;
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) map.set(k, decodeURIComponent(v));
  }
  return map;
}

export function getAuthTokenFromRequest(request) {
  const cookieHeader = request?.headers?.get?.("cookie") || "";
  return parseCookieHeader(cookieHeader).get("auth_token") || null;
}

export function shouldUseSecureCookie(request) {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  if (request && hasTrustedPeerHeaders(request)) {
    return request.headers?.get?.("x-9r-proto") === "https";
  }
  return false;
}

export async function createDashboardAuthToken(claims = {}) {
  const sv = await getCurrentSessionVersion();
  const ttlSec = getSessionTtlSeconds();
  return new SignJWT({ authenticated: true, sv, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(getEncodedSecret());
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getEncodedSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const currentSv = await getCurrentSessionVersion();
    if (payload.sv !== currentSv) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function verifyDashboardAuthToken(token) {
  const session = await getDashboardAuthSession(token);
  return session !== null;
}

export async function buildAuthSetCookieHeader(request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  const ttlSec = getSessionTtlSeconds();
  const parts = [
    `auth_token=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${ttlSec}`,
  ];
  if (shouldUseSecureCookie(request)) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearAuthCookieHeader() {
  return "auth_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (!storedHash) return false;
  return bcrypt.compare(password, storedHash);
}
