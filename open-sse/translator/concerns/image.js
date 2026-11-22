// Build a base64 data URI from mime + base64 payload
import { MAX_IMAGE_BYTES, FETCH_TIMEOUT_MS, IMAGE_SIGNATURES } from "../../config/mediaConfig.js";
import { fetchPublicMedia } from "../../../src/shared/utils/ssrfGuard.js";

export function encodeDataUri(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;
export function parseDataUri(url) {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

function detectImageMime(buf) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (buf.length < offset + sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[offset + i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (verifyWebp && !(buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) {
      continue;
    }
    return mime;
  }
  return null;
}

/**
 * Tier 1 SSRF-hardened remote image fetcher (zero internal IP exceptions,
 * DNS-rebinding-safe via undici connect.lookup, manual redirect validation,
 * hard size cap, and magic-byte verification).
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  const { signal, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = options;
  if (!imageUrl || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
    return null;
  }

  const controller = new AbortController();
  const timeout = signal ? null : setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal || controller.signal;
  let closeAgent = null;

  try {
    const { response, close } = await fetchPublicMedia(imageUrl, { signal: fetchSignal }, { maxRedirects: 3 });
    closeAgent = close;
    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        return null;
      }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mimeType = detectImageMime(buf);
    if (!mimeType) return null;

    return { url: `data:${mimeType};base64,${buf.toString("base64")}`, mimeType };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (closeAgent) closeAgent();
  }
}
