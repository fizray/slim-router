import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodeById,
  getProviderNodes,
  maskConnectionForApi,
} from "@/lib/db/index.js";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";
import { assertUpstreamProviderUrl } from "@/shared/utils/ssrfGuard.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const connections = await getProviderConnections();
    const nodes = await getProviderNodes().catch(() => []);
    const nodeNameMap = Object.fromEntries(nodes.filter((n) => n.id && n.name).map((n) => [n.id, n.name]));

    const safeConnections = connections.map((c) => {
      const isCompatible = isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider);
      const name = isCompatible
        ? (c.name || nodeNameMap[c.provider] || c.providerSpecificData?.nodeName || c.provider)
        : c.name;
      return {
        ...maskConnectionForApi(c),
        name,
      };
    });

    return NextResponse.json({ connections: safeConnections }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to fetch providers" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const provider = normalizeProviderId(body.provider);
    const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body;

    const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
    const isValidProvider = APIKEY_PROVIDERS[provider] ||
      supportsApiKeyMode ||
      isOpenAICompatibleProvider(provider) ||
      isAnthropicCompatibleProvider(provider) ||
      isCustomEmbeddingProvider(provider);

    if (!provider || !isValidProvider) {
      return NextResponse.json({ error: "Invalid or unsupported provider" }, { status: 400 });
    }

    const apiKeySubstitute = AI_PROVIDERS[provider]?.apiKeyOptionalWith;
    const hasApiKeySubstitute = !!(apiKeySubstitute && body.providerSpecificData?.[apiKeySubstitute]);

    if (!apiKey && !hasApiKeySubstitute && provider !== "ollama-local") {
      return NextResponse.json({ error: "API key or credential is required" }, { status: 400 });
    }

    // Validate custom baseUrl against Tier-2 SSRF policy
    const rawBaseUrl = body.providerSpecificData?.baseUrl;
    if (rawBaseUrl) {
      assertUpstreamProviderUrl(rawBaseUrl);
    }

    let providerSpecificData = normalizeProviderSpecificData(provider, body.providerSpecificData || {});
    if (isOpenAICompatibleProvider(provider) || isAnthropicCompatibleProvider(provider) || isCustomEmbeddingProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (node) {
        providerSpecificData = {
          ...providerSpecificData,
          baseUrl: providerSpecificData.baseUrl || node.baseUrl,
          nodeName: node.name,
          prefix: node.prefix,
          apiType: node.apiType,
        };
      }
    }

    const connection = await createProviderConnection({
      provider,
      authType: "apikey",
      name: name || displayName || `${provider} key`,
      apiKey: apiKey || "",
      priority,
      globalPriority,
      defaultModel,
      testStatus: testStatus || "active",
      providerSpecificData,
    });

    return NextResponse.json({ connection: maskConnectionForApi(connection) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to create provider connection" }, { status: 400 });
  }
}
