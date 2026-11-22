import { PROVIDER_MODELS } from "@/shared/constants/models";
import { authenticateApiKey } from "@/lib/db/index.js";
import { extractApiKey } from "@/sse/services/auth.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

// GET /v1beta/models - Gemini compatible models list (strictly requires API key)
export async function GET(request) {
  try {
    const rawKey = extractApiKey(request);
    const apiKeyRecord = rawKey ? await authenticateApiKey(rawKey) : null;
    if (!apiKeyRecord) {
      return Response.json(
        { error: { code: 401, message: "Valid API key required", status: "UNAUTHENTICATED" } },
        { status: 401 }
      );
    }

    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent", "streamGenerateContent"] }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 1000000,
        outputTokenLimit: 65536,
      });
    }

    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      if (!Array.isArray(providerModels)) continue;
      for (const model of providerModels) {
        addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
        });

        if (provider === "gemini" || provider === "vertex") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Google model: ${model.name || model.id}`,
          });
        }
      }
    }

    return Response.json({ models });
  } catch (error) {
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
