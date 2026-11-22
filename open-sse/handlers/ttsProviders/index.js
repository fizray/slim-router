// TTS provider registry — Google AI Studio (Gemini)
import gemini, { fetchGeminiVoices } from "./gemini.js";

const SPECIAL_ADAPTERS = { gemini };

export function getTtsAdapter(provider) {
  return SPECIAL_ADAPTERS[provider] || null;
}

export async function synthesizeViaConfig() {
  return null;
}

export const VOICE_FETCHERS = {
  gemini: fetchGeminiVoices,
};

export { fetchGeminiVoices };
