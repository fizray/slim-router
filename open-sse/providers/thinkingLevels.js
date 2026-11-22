// Resolve valid thinking levels for Vertex AI & Google AI Studio (Gemini + Vertex Partner models)
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";

const L = {
  base: ["none", "low", "medium", "high"],
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],
  gemini: ["minimal", "low", "medium", "high"],
};

const FORMAT_LEVELS = {
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  qwen: L.base,
  deepseek: ["none", "high", "max"],
};

const PATTERN_THINKING = [
  { pattern: "*gemini-4*", levels: ["low", "medium", "high"] },
  { pattern: "*claude*4.6*", levels: ["none", "low", "medium", "high", "max"] },
  { pattern: "*claude*4-6*", levels: ["none", "low", "medium", "high", "max"] },
];

export function getThinkingLevels(provider, model) {
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const hit = PATTERN_THINKING.find((entry) =>
    (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, model)
  );
  let levels = hit?.levels || FORMAT_LEVELS[caps.thinkingFormat] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}
