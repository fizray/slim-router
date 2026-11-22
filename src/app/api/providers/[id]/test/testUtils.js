import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/index.js";
import { parseVertexSaJson, parseVertexAdcJson, refreshVertexToken, refreshGoogleToken } from "open-sse/services/vertexAuth.js";
import { fetchProviderUpstream } from "open-sse/utils/proxyFetch.js";

export async function testSingleConnection(id) {
  const conn = await getProviderConnectionById(id);
  if (!conn) return { valid: false, error: "Connection not found" };

  const provider = conn.provider;
  const now = new Date().toISOString();

  try {
    // Vertex AI & Vertex Partner: test Service Account JSON or ADC JSON token minting
    if (provider === "vertex" || provider === "vertex-partner") {
      const sa = parseVertexSaJson(conn.apiKey);
      if (sa) {
        const res = await refreshVertexToken(sa);
        if (!res?.accessToken) throw new Error("Failed to mint Vertex Service Account token");
        await updateProviderConnection(id, { testStatus: "active", lastTested: now, lastError: null, errorCode: null });
        return { valid: true, error: null, refreshed: true };
      }
      const adc = parseVertexAdcJson(conn.apiKey);
      if (adc) {
        const res = await refreshGoogleToken(adc.refresh_token, adc.client_id, adc.client_secret);
        if (!res?.accessToken) throw new Error("Failed to refresh Vertex ADC token");
        await updateProviderConnection(id, { testStatus: "active", lastTested: now, lastError: null, errorCode: null });
        return { valid: true, error: null, refreshed: true };
      }
      if (!conn.apiKey) throw new Error("Missing Vertex API key or Service Account JSON");
      await updateProviderConnection(id, { testStatus: "active", lastTested: now, lastError: null, errorCode: null });
      return { valid: true, error: null };
    }

    // Google AI Studio (Gemini): live probe /v1beta/models using x-goog-api-key header
    if (provider === "gemini") {
      if (!conn.apiKey) throw new Error("Missing Google AI Studio API key");
      const res = await fetchProviderUpstream("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
        method: "GET",
        headers: { "x-goog-api-key": conn.apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`Google AI Studio rejected key (HTTP ${res.status})`);
      }
      await updateProviderConnection(id, { testStatus: "active", lastTested: now, lastError: null, errorCode: null });
      return { valid: true, error: null };
    }

    throw new Error(`Unsupported provider: ${provider}`);
  } catch (err) {
    const message = err?.message || "Connection test failed";
    await updateProviderConnection(id, { testStatus: "error", lastTested: now, lastError: message });
    return { valid: false, error: message };
  }
}
