/**
 * Two-tier DNS-rebinding-safe SSRF Guard using undici Agent connect.lookup.
 *
 * Tier 1 — fetchPublicMedia (end-user media URLs, e.g. image prefetch):
 *   Zero internal exceptions. Blocks loopback, RFC1918, CGNAT, link-local,
 *   IPv6 ULA/mapped/NAT64, and cloud metadata even if present in SELFHOSTED_HOST_ALLOWLIST.
 *
 * Tier 2 — fetchProviderUpstream (admin-configured provider/self-hosted URLs):
 *   Blocks all internal/private hosts EXCEPT exact host[:port] entries in
 *   SELFHOSTED_HOST_ALLOWLIST. Cloud metadata (169.254.169.254, fe80::/10) is
 *   ALWAYS blocked without exception.
 */

import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".localdomain"];

function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

const METADATA_V4_RANGES = [
  [ipv4ToInt("169.254.0.0"), 16], // AWS/GCP/Azure IMDS + link-local
];

const PRIVATE_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10], // CGNAT / Tailscale
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16],
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("224.0.0.0"), 4], // multicast
  [ipv4ToInt("240.0.0.0"), 4], // reserved
];

function matchRanges(ip, ranges) {
  return ranges.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

export function isMetadataIpv4(host) {
  const ip = ipv4ToInt(host);
  return ip !== null && matchRanges(ip, METADATA_V4_RANGES);
}

export function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  return ip !== null && matchRanges(ip, PRIVATE_V4_RANGES);
}

function parseHextets(s) {
  if (s === "") return [];
  const segs = s.split(":");
  const out = [];
  for (const seg of segs) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    out.push(parseInt(seg, 16));
  }
  return out;
}

function parseIPv6ToGroups(rawHost) {
  let host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);

  const v4TailMatch = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Groups = null;
  if (v4TailMatch) {
    const v4Int = ipv4ToInt(v4TailMatch[1]);
    if (v4Int === null) return null;
    v4Groups = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    host = host.slice(0, host.length - v4TailMatch[1].length);
    if (!host.endsWith("::") && host.endsWith(":")) {
      host = host.slice(0, -1);
    }
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const head = parseHextets(doubleColonParts[0]);
    const tail = parseHextets(doubleColonParts[1]);
    if (head === null || tail === null) return null;
    const v4Len = v4Groups ? v4Groups.length : 0;
    const missing = 8 - head.length - tail.length - v4Len;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail, ...(v4Groups || [])];
  } else {
    const all = parseHextets(host);
    if (all === null) return null;
    groups = [...all, ...(v4Groups || [])];
  }
  return groups.length === 8 ? groups : null;
}

function isMetadataIpv6Groups(g) {
  if (!g) return false;
  // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // IPv4-mapped / NAT64 embedding metadata IPv4
  const isZero = (n) => g[n] === 0;
  const low32 = ((g[6] << 16) | g[7]) >>> 0;
  if ([0, 1, 2, 3, 4].every(isZero) && g[5] === 0xffff) return matchRanges(low32, METADATA_V4_RANGES);
  if (g[0] === 0x0064 && g[1] === 0xff9b && [2, 3, 4, 5].every(isZero)) return matchRanges(low32, METADATA_V4_RANGES);
  return false;
}

function isBlockedIpv6Groups(g) {
  if (!g) return true;
  const isZero = (n) => g[n] === 0;
  if ([0, 1, 2, 3, 4, 5, 6].every(isZero) && g[7] === 1) return true; // ::1
  if (g.every((x) => x === 0)) return true; // ::
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const low32 = ((g[6] << 16) | g[7]) >>> 0;
  if ([0, 1, 2, 3, 4].every(isZero) && g[5] === 0xffff) return matchRanges(low32, PRIVATE_V4_RANGES);
  if (g[0] === 0x0064 && g[1] === 0xff9b && [2, 3, 4, 5].every(isZero)) return matchRanges(low32, PRIVATE_V4_RANGES);
  if ([0, 1, 2, 3, 4, 5].every(isZero) && low32 !== 0 && low32 !== 1) return matchRanges(low32, PRIVATE_V4_RANGES);
  return false;
}

export function normalizeHost(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

export function isMetadataIp(address) {
  const norm = normalizeHost(address);
  if (isMetadataIpv4(norm)) return true;
  if (norm.includes(":")) return isMetadataIpv6Groups(parseIPv6ToGroups(norm));
  return false;
}

export function isPrivateOrInternalIp(address) {
  const norm = normalizeHost(address);
  if (isBlockedIpv4(norm)) return true;
  if (norm.includes(":")) return isBlockedIpv6Groups(parseIPv6ToGroups(norm));
  return false;
}

function isBlockedHostnameLiteral(host) {
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return isPrivateOrInternalIp(host);
}

/**
 * Parse SELFHOSTED_HOST_ALLOWLIST env var.
 * Entries can be "hostname", "hostname:port", or "ip:port" (e.g. "ollama:11434,192.168.1.50:8000").
 */
export function parseSelfhostedAllowlist() {
  const raw = process.env.SELFHOSTED_HOST_ALLOWLIST || "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isSelfhostedUrlAllowed(parsedUrl) {
  const allowlist = parseSelfhostedAllowlist();
  if (allowlist.length === 0) return false;
  const host = normalizeHost(parsedUrl.hostname);
  // Metadata hosts are NEVER allowlisted.
  if (host === "metadata.google.internal" || host === "169.254.169.254" || isMetadataIp(host)) {
    return false;
  }
  const defaultPort = parsedUrl.protocol === "https:" ? "443" : "80";
  const port = parsedUrl.port || defaultPort;
  const hostPort = `${host}:${port}`;
  return allowlist.some((entry) => entry === hostPort || entry === host);
}

export function createSsrfSafeLookup({ allowPrivateForAllowlisted = false, parsedUrl = null } = {}) {
  const allowPrivate = allowPrivateForAllowlisted && parsedUrl && isSelfhostedUrlAllowed(parsedUrl);

  return function ssrfLookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options !== null ? { ...options, all: true } : { all: true };
    const normHost = normalizeHost(hostname);

    if (normHost === "metadata.google.internal" || isMetadataIp(normHost)) {
      return cb(new Error("SSRF blocked: cloud metadata host is forbidden"));
    }
    if (!allowPrivate && isBlockedHostnameLiteral(normHost)) {
      return cb(new Error("SSRF blocked: internal host is forbidden"));
    }

    dns.lookup(normHost, opts, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family || 4 }];
      if (!list.length) return cb(new Error("SSRF blocked: DNS resolution returned no addresses"));

      for (const rec of list) {
        if (isMetadataIp(rec.address)) {
          return cb(new Error("SSRF blocked: resolved to cloud metadata address"));
        }
        if (!allowPrivate && isPrivateOrInternalIp(rec.address)) {
          return cb(new Error("SSRF blocked: hostname resolves to an internal/private address"));
        }
      }

      if (typeof options === "object" && options?.all) {
        return cb(null, list);
      }
      return cb(null, list[0].address, list[0].family);
    });
  };
}

export function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Blocked URL: unsupported protocol");
  }
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHostnameLiteral(host)) {
    throw new Error("Blocked URL: internal host");
  }
}

export function assertUpstreamProviderUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Blocked URL: unsupported protocol");
  }
  const host = normalizeHost(parsed.hostname);
  if (host === "metadata.google.internal" || isMetadataIp(host)) {
    throw new Error("Blocked URL: cloud metadata host");
  }
  if (isBlockedHostnameLiteral(host) && !isSelfhostedUrlAllowed(parsed)) {
    throw new Error("Blocked URL: internal host not in SELFHOSTED_HOST_ALLOWLIST");
  }
}

export async function assertPublicUrlResolved(rawUrl) {
  assertPublicUrl(rawUrl);
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (ipv4ToInt(host) !== null || host.includes(":")) return;

  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    return;
  }
  for (const { address } of addresses) {
    if (isPrivateOrInternalIp(address)) {
      throw new Error("Blocked URL: hostname resolves to an internal host");
    }
  }
}

/**
 * Tier 1: Zero-exception public media fetch (DNS-rebinding-safe via undici connect.lookup + manual redirects).
 */
export async function fetchPublicMedia(url, init = {}, { maxRedirects = 3 } = {}) {
  let currentUrl = String(url);
  for (let hop = 0; ; hop++) {
    assertPublicUrl(currentUrl);
    const parsed = new URL(currentUrl);
    const agent = new Agent({
      connect: {
        rejectUnauthorized: true,
        lookup: createSsrfSafeLookup({ allowPrivateForAllowlisted: false, parsedUrl: parsed }),
      },
    });
    let res;
    try {
      res = await undiciFetch(currentUrl, { ...init, redirect: "manual", dispatcher: agent });
    } catch (err) {
      agent.close().catch(() => {});
      throw err;
    }

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    if (!location) {
      // Attach cleanup when caller finishes reading body
      if (!res.body) agent.close().catch(() => {});
      return { response: res, close: () => agent.close().catch(() => {}) };
    }

    try { await res.body?.cancel?.(); } catch {}
    agent.close().catch(() => {});
    if (hop >= maxRedirects) {
      throw new Error("SSRF blocked: too many redirects");
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}

// Backward-compatible export for callers expecting fetchPublic() -> Response
export async function fetchPublic(url, init = {}, opts = {}) {
  const { response } = await fetchPublicMedia(url, init, opts);
  return response;
}
