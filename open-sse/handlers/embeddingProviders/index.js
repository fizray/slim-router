// Embeddings provider adapter registry — Google AI Studio (Gemini)
import gemini from "./gemini.js";

const ADAPTERS = {
  gemini,
  google_ai_studio: gemini,
};

export function getEmbeddingAdapter(provider) {
  return ADAPTERS[provider] || null;
}
