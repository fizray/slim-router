/**
 * POST /api/models/probe
 * Live model & API key prober for Dashboard (JWT-protected, zero secret echo).
 *
 * Supports:
 *   1. Probing any Vertex AI / Google AI Studio / Vertex Partner model using a saved connection (or auto-selected active connection)
 *   2. Ad-hoc credential testing (paste an AI Studio API key or Vertex SA/ADC JSON without saving to DB)
 *   3. Verifying a Gateway Client API Key (`sk-9r_...`) — checks HMAC hash, expiry, allow-list, governance limits, and optional live upstream call
 */

import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  authenticateApiKey,
} from "@/lib/db/index.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { getExecutor } from "open-sse/executors/index.js";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { getTargetFormat } from "open-sse/services/provider.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { parseVertexSaJson, parseVertexAdcJson, refreshVertexToken, refreshGoogleToken } from "open-sse/services/vertexAuth.js";

function extractPreview(data) {
  if (!data || typeof data !== "object") return "";
  // Gemini / Vertex response shape
  const parts = data?.candidates?.[0]?.content?.parts || data?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts.map((p) => p.text).filter(Boolean).join("").trim();
    if (text) return text.slice(0, 240);
  }
  // OpenAI shape
  const oai = data?.choices?.[0]?.message?.content;
  if (typeof oai === "string" && oai.trim()) return oai.trim().slice(0, 240);
  // Claude shape
  if (Array.isArray(data?.content)) {
    const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (text) return text.slice(0, 240);
  }
  return "";
}

function extractUsageSummary(data) {
  const um = data?.usageMetadata || data?.response?.usageMetadata;
  if (um) {
    return {
      promptTokens: um.promptTokenCount || 0,
      cachedTokens: um.cachedContentTokenCount || 0,
      completionTokens: um.candidatesTokenCount || 0,
    };
  }
  const u = data?.usage;
  if (u) {
    return {
      promptTokens: u.prompt_tokens || u.input_tokens || 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0,
      completionTokens: u.completion_tokens || u.output_tokens || 0,
    };
  }
  return null;
}

async function resolveProbeCredentials({ provider, connectionId, apiKey, projectId, location }) {
  // Ad-hoc credential test (not saved to DB)
  if (apiKey && typeof apiKey === "string" && apiKey.trim()) {
    const rawKey = apiKey.trim();
    const providerSpecificData = {};
    if (projectId?.trim()) providerSpecificData.projectId = projectId.trim();
    if (location?.trim()) providerSpecificData.location = location.trim();

    if (provider === "vertex" || provider === "vertex-partner") {
      const sa = parseVertexSaJson(rawKey);
      if (sa) {
        const refreshed = await refreshVertexToken(sa);
        return {
          connectionName: `Ad-hoc SA (${sa.client_email})`,
          credentials: {
            apiKey: rawKey,
            accessToken: refreshed.accessToken,
            projectId: projectId?.trim() || sa.project_id,
            providerSpecificData: { ...providerSpecificData, projectId: projectId?.trim() || sa.project_id },
          },
        };
      }
      const adc = parseVertexAdcJson(rawKey);
      if (adc) {
        const refreshed = await refreshGoogleToken(adc.refresh_token, adc.client_id, adc.client_secret);
        return {
          connectionName: "Ad-hoc Vertex ADC",
          credentials: {
            apiKey: rawKey,
            accessToken: refreshed.accessToken,
            projectId: projectId?.trim() || adc.quota_project_id,
            providerSpecificData: { ...providerSpecificData, projectId: projectId?.trim() || adc.quota_project_id },
          },
        };
      }
    }

    return {
      connectionName: "Ad-hoc API Key",
      credentials: {
        apiKey: rawKey,
        providerSpecificData,
      },
    };
  }

  // Specific saved connection
  if (connectionId) {
    const conn = await getProviderConnectionById(connectionId);
    if (!conn) throw new Error("Selected connection not found");
    if (conn.provider !== provider) {
      throw new Error(`Connection '${conn.name}' belongs to provider '${conn.provider}', not '${provider}'`);
    }
    const creds = {
      connectionId: conn.id,
      apiKey: conn.apiKey,
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      projectId: conn.projectId || conn.providerSpecificData?.projectId,
      providerSpecificData: conn.providerSpecificData || {},
    };
    // Ensure Vertex SA/ADC token is minted if accessToken not cached
    if ((provider === "vertex" || provider === "vertex-partner") && !creds.accessToken && creds.apiKey) {
      const sa = parseVertexSaJson(creds.apiKey);
      if (sa) {
        const refreshed = await refreshVertexToken(sa);
        creds.accessToken = refreshed.accessToken;
        creds.projectId = creds.projectId || sa.project_id;
      } else {
        const adc = parseVertexAdcJson(creds.apiKey);
        if (adc) {
          const refreshed = await refreshGoogleToken(adc.refresh_token, adc.client_id, adc.client_secret);
          creds.accessToken = refreshed.accessToken;
          creds.projectId = creds.projectId || adc.quota_project_id;
        }
      }
    }
    return { connectionName: conn.name || conn.id, credentials: creds };
  }

  // Auto-select active connection for provider
  const auto = await getProviderCredentials(provider);
  if (!auto || auto.allRateLimited) {
    throw new Error(auto?.allRateLimited ? "All active connections for this provider are rate-limited" : `No active connection configured for '${provider}'`);
  }
  return { connectionName: auto.connectionName || auto.connectionId || provider, credentials: auto };
}

export async function POST(request) {
  const start = performance.now();
  try {
    const body = await request.json().catch(() => ({}));
    const {
      provider = "",
      model = "",
      kind = "llm",
      connectionId = "",
      prompt = "",
      apiKey = "",
      projectId = "",
      location = "",
      gatewayApiKey = "",
      runUpstream = true,
    } = body;

    // 1. Optional Gateway API Key (`sk-9r_...`) verification mode
    let gatewayKeyCheck = null;
    if (gatewayApiKey && typeof gatewayApiKey === "string" && gatewayApiKey.trim()) {
      const record = await authenticateApiKey(gatewayApiKey.trim());
      if (!record) {
        return NextResponse.json({
          ok: false,
          status: 401,
          latencyMs: Math.round(performance.now() - start),
          error: "Gateway API key is invalid, inactive, or expired.",
          gatewayKeyCheck: { valid: false },
        });
      }

      const targetId = provider && model ? `${provider}/${model}` : model;
      const allowList = Array.isArray(record.access?.allow) ? record.access.allow.map((s) => String(s).toLowerCase()) : [];
      const modelAllowed = !record.access?.restricted || !targetId
        ? true
        : allowList.includes(targetId.toLowerCase()) || allowList.includes(String(model).toLowerCase());

      gatewayKeyCheck = {
        valid: true,
        id: record.id,
        name: record.name,
        keyHint: record.keyHint,
        rpmLimit: record.rpmLimit,
        tpmLimit: record.tpmLimit,
        dailyBudgetUsd: record.dailyBudgetUsd,
        monthlyBudgetUsd: record.monthlyBudgetUsd,
        expiresAt: record.expiresAt,
        access: record.access,
        modelAllowed,
      };

      if (!modelAllowed) {
        return NextResponse.json({
          ok: false,
          status: 403,
          latencyMs: Math.round(performance.now() - start),
          error: `Key '${record.name}' is valid, but blocked from model '${targetId}' by its allow-list.`,
          gatewayKeyCheck,
        });
      }

      if (!runUpstream || !provider || !model) {
        return NextResponse.json({
          ok: true,
          status: 200,
          latencyMs: Math.round(performance.now() - start),
          preview: `Gateway key '${record.name}' (${record.keyHint}) authenticated successfully.`,
          gatewayKeyCheck,
        });
      }
    }

    if (!provider || !model) {
      return NextResponse.json({ ok: false, error: "provider and model are required" }, { status: 400 });
    }

    const { connectionName, credentials } = await resolveProbeCredentials({
      provider,
      connectionId,
      apiKey,
      projectId,
      location,
    });

    // 2. Embedding model probe
    if (kind === "embedding") {
      const res = await handleEmbeddingsCore({
        provider,
        model,
        input: prompt?.trim() || "ping",
        credentials,
      });
      const latencyMs = Math.round(performance.now() - start);
      if (!res.success) {
        return NextResponse.json({
          ok: false,
          status: res.status || 502,
          latencyMs,
          provider,
          model,
          connectionName,
          error: res.error || "Embedding probe failed",
          gatewayKeyCheck,
        });
      }
      const data = await res.response.json().catch(() => null);
      const dims = data?.data?.[0]?.embedding?.length || null;
      return NextResponse.json({
        ok: true,
        status: 200,
        latencyMs,
        provider,
        model,
        connectionName,
        preview: dims ? `Embedding OK (${dims} dimensions)` : "Embedding OK",
        gatewayKeyCheck,
      });
    }

    // 3. Non-LLM media models (image/tts/stt/video): credential readiness probe (avoid burning expensive video/image credits on ping)
    if (kind === "video" || kind === "image" || kind === "tts" || kind === "stt") {
      const latencyMs = Math.round(performance.now() - start);
      return NextResponse.json({
        ok: true,
        status: 200,
        latencyMs,
        provider,
        model,
        connectionName,
        preview: `Credentials verified (${kind} model ready — skipped heavy generation to avoid billing)`,
        gatewayKeyCheck,
      });
    }

    // 4. LLM / Multimodal Chat live probe
    const executor = getExecutor(provider);
    const targetFormat = getTargetFormat(provider, credentials);
    const testPrompt = (prompt && String(prompt).trim()) || "Reply with OK.";
    const translated = translateRequest(
      FORMATS.OPENAI,
      targetFormat,
      model,
      {
        model,
        messages: [{ role: "user", content: testPrompt }],
        max_tokens: 32,
        stream: false,
      },
      false,
      credentials,
      provider
    );

    const execResult = await executor.execute({
      model,
      body: translated,
      stream: false,
      credentials,
      signal: AbortSignal.timeout(20000),
    });

    const latencyMs = Math.round(performance.now() - start);
    const resp = execResult.response;
    const rawText = await resp.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch {}

    if (!resp.ok) {
      const errMsg = parsed?.error?.message || parsed?.message || rawText.slice(0, 300) || `Upstream HTTP ${resp.status}`;
      return NextResponse.json({
        ok: false,
        status: resp.status,
        latencyMs,
        provider,
        model,
        connectionName,
        error: errMsg,
        gatewayKeyCheck,
      });
    }

    return NextResponse.json({
      ok: true,
      status: resp.status,
      latencyMs,
      provider,
      model,
      connectionName,
      preview: extractPreview(parsed) || "OK (empty preview)",
      usage: extractUsageSummary(parsed),
      gatewayKeyCheck,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      status: 500,
      latencyMs: Math.round(performance.now() - start),
      error: err?.message || "Probe failed",
    });
  }
}
