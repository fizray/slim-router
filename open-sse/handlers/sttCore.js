import { Buffer } from "node:buffer";
import { createErrorResult } from "../utils/error.js";
import { transcribeGeminiLive } from "./geminiLiveStt.js";
import { VertexExecutor } from "../executors/vertex.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

function resolveAudioContentType(file) {
  const t = (file.type || "").toLowerCase();
  if (t.startsWith("audio/")) return t;
  const name = typeof file.name === "string" ? file.name.toLowerCase() : "";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  const map = { mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm", aac: "audio/aac", opus: "audio/opus" };
  return map[ext] || "application/octet-stream";
}

async function upstreamError(res) {
  let txt = "";
  try { txt = await res.text(); } catch {}
  let msg = txt || `Upstream error (${res.status})`;
  try { const j = JSON.parse(txt); msg = j?.error?.message || j?.error || j?.message || msg; } catch {}
  return createErrorResult(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
}

function formatSttResponse(text, formData, usage = null, segments = null) {
  const fmt = typeof formData?.get === "function"
    ? String(formData.get("response_format") ?? "").trim().toLowerCase()
    : "";

  if (fmt === "text") {
    return {
      success: true,
      usage,
      response: new Response(String(text || ""), {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      }),
    };
  }

  const payload = fmt === "verbose_json"
    ? {
        task: "transcribe",
        language: (typeof formData?.get === "function" ? formData.get("language") : null) || "auto",
        text: String(text || ""),
        segments: Array.isArray(segments) ? segments : (text ? [{ id: 0, text: String(text) }] : []),
      }
    : { text: String(text || "") };

  return {
    success: true,
    usage,
    response: new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}

function extractGeminiTranscript(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }
  const candParts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(candParts)) {
    const joined = candParts.map((p) => p?.text).filter(Boolean).join("");
    if (joined) return joined;
  }
  if (Array.isArray(data?.outputs)) {
    const chunks = [];
    for (const out of data.outputs) {
      if (typeof out?.text === "string" && out.text) chunks.push(out.text);
      if (Array.isArray(out?.content)) {
        for (const c of out.content) {
          if (typeof c?.text === "string" && c.text) chunks.push(c.text);
          if (Array.isArray(c?.parts)) {
            for (const p of c.parts) {
              if (typeof p?.text === "string" && p.text) chunks.push(p.text);
            }
          }
        }
      }
    }
    if (chunks.length > 0) return chunks.join("");
  }
  return "";
}

function buildAudioParts(b64, mime, model, formData, camelCase = false) {
  const isDedicatedTranscribe = /transcribe/i.test(model || "");
  const lang = typeof formData?.get === "function" ? formData.get("language") : null;
  const userPrompt = typeof formData?.get === "function" ? formData.get("prompt") : null;
  const inlinePart = camelCase
    ? { inlineData: { mimeType: mime, data: b64 } }
    : { inline_data: { mime_type: mime, data: b64 } };

  if (isDedicatedTranscribe) {
    const parts = [inlinePart];
    const extra = [];
    if (typeof userPrompt === "string" && userPrompt.trim()) extra.push(userPrompt.trim());
    if (typeof lang === "string" && lang.trim()) extra.push(`Language: ${lang.trim()}.`);
    if (extra.length > 0) parts.unshift({ text: extra.join(" ") });
    return parts;
  }

  let promptText = userPrompt && typeof userPrompt === "string" && userPrompt.trim()
    ? userPrompt.trim()
    : "Generate a transcript of the speech. Return only the transcribed text, no commentary.";
  if (typeof lang === "string" && lang.trim()) promptText += ` Language: ${lang.trim()}.`;
  return [{ text: promptText }, inlinePart];
}

// Google AI Studio: generateContent with inline_data audio
async function transcribeGemini(cfg, file, model, token, formData, signal) {
  const buf = await file.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const mime = resolveAudioContentType(file);
  const parts = buildAudioParts(b64, mime, model, formData, false);

  const url = `${cfg.baseUrl}/${model}:generateContent`;
  const body = { contents: [{ role: "user", parts }] };
  if (/transcribe/i.test(model || "")) {
    body.generationConfig = { temperature: 0 };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": token },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = extractGeminiTranscript(data);
  return formatSttResponse(text, formData, data?.usageMetadata || null);
}

// Google AI Studio: Interactions API (/v1beta/interactions) for gemini-3.5-transcribe
// Automatically falls back to :generateContent if the model is not served on Interactions API.
async function transcribeGeminiInteractions(cfg, file, model, token, formData, signal) {
  const buf = await file.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const mime = resolveAudioContentType(file);
  const lang = typeof formData?.get === "function" ? formData.get("language") : null;
  const userPrompt = typeof formData?.get === "function" ? formData.get("prompt") : null;

  const interactionsBase = String(cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta/models")
    .replace(/\/models\/?$/, "");
  const url = `${interactionsBase}/interactions`;

  const input = [{ type: "audio", data: b64, mime_type: mime }];
  if (typeof userPrompt === "string" && userPrompt.trim()) {
    input.push({ type: "text", text: userPrompt.trim() });
  }

  const payload = { model, input };
  if (typeof lang === "string" && lang.trim()) {
    payload.generation_config = {
      transcription_config: {
        language_codes: [lang.trim()],
      },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": token },
    body: JSON.stringify(payload),
    signal,
  });

  if (res.ok) {
    const data = await res.json();
    const text = extractGeminiTranscript(data);
    return formatSttResponse(text, formData, data?.usageMetadata || data?.usage || null);
  }

  // Fallback to :generateContent if model is not supported on /v1beta/interactions
  const errClone = res.clone();
  const errTxt = await errClone.text().catch(() => "");
  if (res.status === 404 || (res.status === 400 && /not supported by the interactions api/i.test(errTxt))) {
    return await transcribeGemini(cfg, file, model, token, formData, signal);
  }

  return upstreamError(res);
}

// Google Vertex AI: generateContent via VertexExecutor (handles SA JSON, ADC OAuth, & raw API key)
async function transcribeVertex({ file, model, credentials, formData, signal }) {
  const buf = await file.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const mime = resolveAudioContentType(file);
  const parts = buildAudioParts(b64, mime, model, formData, true);

  const body = { contents: [{ role: "user", parts }] };
  if (/transcribe/i.test(model || "")) {
    body.generationConfig = { temperature: 0 };
  }

  const executor = new VertexExecutor("vertex");
  const { response } = await executor.execute({
    model,
    body,
    stream: false,
    credentials: { ...credentials },
    signal,
  });

  if (!response.ok) return upstreamError(response);
  const data = await response.json();
  const text = extractGeminiTranscript(data);
  return formatSttResponse(text, formData, data?.usageMetadata || null);
}

function resolveModelTransport(provider, model) {
  const key = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const models = PROVIDER_MODELS[key] || PROVIDER_MODELS[provider];
  if (!Array.isArray(models)) return null;
  const entry = models.find((m) => m && m.id === model && (m.kind || "llm") === "stt");
  const marker = typeof entry?.transport === "string" ? entry.transport.trim() : "";
  return marker || null;
}

export async function handleSttCore({ provider, model, formData, credentials, sttConfig, transport, signal }) {
  const file = formData.get("file");
  if (!file) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const cfg = sttConfig;
  if (!cfg) return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support STT`);

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return createErrorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for STT provider: ${provider}`);
  }

  const marker = (typeof transport === "string" && transport.trim()) ? transport.trim() : resolveModelTransport(provider, model);
  const effectiveFormat = marker || cfg.format;

  try {
    if (provider === "vertex" || effectiveFormat === "vertex-stt") {
      return await transcribeVertex({ file, model, credentials, formData, signal });
    }
    if (effectiveFormat === "gemini-live") {
      const live = await transcribeGeminiLive({ cfg, file, model, token, formData, mimeType: resolveAudioContentType(file) });
      return formatSttResponse(
        live.text,
        formData,
        null,
        live.chunks.map((segText, id) => ({ id, text: segText }))
      );
    }
    if (effectiveFormat === "gemini-interactions" || (/transcribe/i.test(model || "") && provider === "gemini")) {
      return await transcribeGeminiInteractions(cfg, file, model, token, formData, signal);
    }
    return await transcribeGemini(cfg, file, model, token, formData, signal);
  } catch (err) {
    return createErrorResult(err.status || HTTP_STATUS.BAD_GATEWAY, err.message || "STT request failed");
  }
}
