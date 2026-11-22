import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { authenticateApiKey } from "@/lib/db/index.js";
import { extractApiKey } from "@/sse/services/auth.js";

const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  video: "/v1/videos/generations",
};

function lookup(fullId, requestedKind) {
  if (!fullId || !fullId.includes("/")) return null;
  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;

  const list = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
  const m = requestedKind
    ? list.find((x) => x.id === modelId && getModelKind(x, "llm") === requestedKind)
    : list.find((x) => x.id === modelId);
  if (!m) return null;

  const kind = getModelKind(m, "llm");
  const out = {
    id: `${alias}/${m.id}`,
    name: m.name || m.id,
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (m.params) out.params = m.params;
  if (m.capabilities) out.capabilities = m.capabilities;
  if (m.dimensions) out.dimensions = m.dimensions;
  if (m.contextWindow) out.contextWindow = m.contextWindow;
  if (kind === "tts" && providerId === "gemini") out.voicesUrl = "/v1/audio/voices?provider=gemini";
  return out;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

export async function GET(request) {
  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) {
    return Response.json({ error: { message: "Valid API key required", type: "authentication_error" } }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const kind = searchParams.get("kind");
  if (!id) {
    return Response.json(
      { error: { message: "Missing required query param: id (e.g. ?id=vertex/gemini-2.5-pro)", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  const info = lookup(id, kind);
  if (!info) {
    return Response.json({ error: { message: `Model not found: ${id}`, type: "not_found" } }, { status: 404 });
  }
  return Response.json(info, { headers: { "Access-Control-Allow-Origin": "*" } });
}
