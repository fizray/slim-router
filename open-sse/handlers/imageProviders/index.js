// Image provider adapter registry — Google AI Studio (Gemini)
import gemini from "./gemini.js";

const ADAPTERS = { gemini };

export function getImageAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function isImageProvider(provider) {
  return provider in ADAPTERS;
}
