// Pure pricing math utilities — ZERO hardcoded prices!
// Live pricing is synced from https://models.dev/api.json into config.sqlite (kv scope 'pricing_synced')
// and can be overridden per model in config.sqlite (kv scope 'pricing') via Dashboard UI or PATCH /api/pricing.

export const FREE_MODEL_NAMESPACES = [];

export const ZERO_PRICING = {
  input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0,
};

export const MODEL_PRICING = {};
export const PROVIDER_PRICING = {};
export const PATTERN_PRICING = [];

export function isFreeModel() {
  return false;
}

export function matchPattern(pattern, model) {
  const regex = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "i"
  );
  return regex.test(model);
}

export function getPricingForModel() {
  return null;
}

export function getDefaultPricing() {
  return {};
}

export function formatCost(cost) {
  if (cost === null || cost === undefined || isNaN(cost)) return "$0.00";
  return `$${cost.toFixed(2)}`;
}

export function calculateCostFromTokens(tokens, pricing) {
  if (!tokens || !pricing) return 0;
  let cost = 0;
  const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
  cost += nonCachedInput * ((Number(pricing.input) || 0) / 1_000_000);
  if (cachedTokens > 0) {
    cost += cachedTokens * ((Number(pricing.cached ?? pricing.input) || 0) / 1_000_000);
  }
  const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
  cost += outputTokens * ((Number(pricing.output) || 0) / 1_000_000);
  const reasoningTokens = tokens.reasoning_tokens || 0;
  if (reasoningTokens > 0) {
    cost += reasoningTokens * ((Number(pricing.reasoning ?? pricing.output) || 0) / 1_000_000);
  }
  if (cacheCreationTokens > 0) {
    cost += cacheCreationTokens * ((Number(pricing.cache_creation ?? pricing.input) || 0) / 1_000_000);
  }
  return cost;
}
