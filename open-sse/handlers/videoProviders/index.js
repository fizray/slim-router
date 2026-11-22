// Video provider adapters — Google Vertex AI (Veo)
import vertex from "./vertex.js";

const ADAPTERS = { vertex };

export function getVideoAdapter(provider) {
  return ADAPTERS[provider] || null;
}
