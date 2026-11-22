import { Buffer } from "node:buffer";
import { createErrorResult } from "../utils/error.js";
import { transcribeGeminiLive } from "./geminiLiveStt.js";
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

function jsonResponse(obj) {
  return {
    success: true,
    response: new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}

// Gemini: generateContent with inline_data audio + transcription prompt
async function transcribeGemini(cfg, file, model, token, formData) {
  const buf = await file.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const mime = resolveAudioContentType(file);
  const lang = formData.get("language");
  const userPrompt = formData.get("prompt");
  let promptText = userPrompt && typeof userPrompt === "string" && userPrompt.trim()
    ? userPrompt.trim()
    : "Generate a transcript of the speech. Return only the transcribed text, no commentary.";
  if (typeof lang === "string" && lang.trim()) promptText += ` Language: ${lang.trim()}.`;

  const url = `${cfg.baseUrl}/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": token },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mime, data: b64 } }] }],
    }),
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  return jsonResponse({ text });
}

function resolveModelTransport(provider, model) {
  const key = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const models = PROVIDER_MODELS[key] || PROVIDER_MODELS[provider];
  if (!Array.isArray(models)) return null;
  const entry = models.find((m) => m && m.id === model && (m.kind || "llm") === "stt");
  const marker = typeof entry?.transport === "string" ? entry.transport.trim() : "";
  return marker || null;
}

export async function handleSttCore({ provider, model, formData, credentials, sttConfig, transport }) {
  const file = formData.get("file");
  if (!file) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const cfg = sttConfig;
  if (!cfg) return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support STT`);

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return createErrorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for STT provider: ${provider}`);
  }

  const marker = (typeof transport === "string" && transport.trim()) ? transport.trim() : resolveModelTransport(provider, model);

  try {
    if ((marker || cfg.format) === "gemini-live") {
      const live = await transcribeGeminiLive({ cfg, file, model, token, formData, mimeType: resolveAudioContentType(file) });
      const fmt = typeof formData?.get === "function"
        ? String(formData.get("response_format") ?? "").trim().toLowerCase()
        : "";
      if (fmt === "verbose_json") {
        return jsonResponse({ text: live.text, segments: live.chunks.map((segText, id) => ({ id, text: segText })) });
      }
      return jsonResponse({ text: live.text });
    }
    return await transcribeGemini(cfg, file, model, token, formData);
  } catch (err) {
    return createErrorResult(err.status || HTTP_STATUS.BAD_GATEWAY, err.message || "STT request failed");
  }
}
