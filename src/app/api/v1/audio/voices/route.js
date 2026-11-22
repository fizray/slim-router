import { listTtsVoices } from "@/lib/ttsVoices.js";
import { authenticateApiKey } from "@/lib/db/index.js";
import { extractApiKey } from "@/sse/services/auth.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/audio/voices?provider=gemini[&lang=xx]
export async function GET(request) {
  const rawKey = extractApiKey(request);
  const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
  if (!apiKeyRecord) {
    return Response.json({ error: { message: "Valid API key required", type: "authentication_error" } }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "gemini";
    const lang = searchParams.get("lang");
    if (provider !== "gemini") {
      return Response.json(
        { error: { message: "Only 'gemini' TTS voices are supported", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    const data = await listTtsVoices("gemini", lang);
    const rawVoices = lang ? (data.voices || []) : Object.values(data.byLang || {}).flatMap((l) => l.voices || []);
    const out = rawVoices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang || "",
      gender: v.gender || "",
      model: `gemini/${v.id}`,
    }));
    return Response.json({ object: "list", data: out }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    return Response.json({ error: { message: err.message || "Failed", type: "server_error" } }, { status: 502 });
  }
}
