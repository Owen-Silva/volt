// VOLT — model pricing (USD per 1M tokens) used for live cost tracking.
// Unknown models report $0 and are flagged so you know the estimate is off.

const PRICING = [
  { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
  { match: /gpt-4o\b/i, input: 2.5, output: 10 },
  { match: /gpt-4\.1-nano/i, input: 0.1, output: 0.4 },
  { match: /gpt-4\.1-mini/i, input: 0.4, output: 1.6 },
  { match: /gpt-4\.1/i, input: 2, output: 8 },
  { match: /gpt-4/i, input: 30, output: 60 },
  { match: /claude-sonnet-4-5/i, input: 3, output: 15 },
  { match: /claude-haiku/i, input: 1, output: 5 },
  { match: /claude-opus/i, input: 15, output: 75 },
  { match: /claude/i, input: 3, output: 15 },
  { match: /deepseek-reasoner/i, input: 0.55, output: 2.19 },
  { match: /deepseek-chat/i, input: 0.27, output: 1.1 },
  { match: /gemini-2\.5-pro/i, input: 1.25, output: 10 },
  { match: /gemini-2\.5-flash/i, input: 0.3, output: 2.5 },
  { match: /gemini/i, input: 0.5, output: 1.5 },
  { match: /o3|o4/i, input: 2, output: 8 },
];

export function pricingFor(model = "") {
  for (const p of PRICING) if (p.match.test(model)) return p;
  return { input: 0, output: 0, unknown: true };
}

export function costFor(model, inputTokens, outputTokens) {
  const p = pricingFor(model);
  return {
    usd: (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output,
    unknown: p.unknown,
  };
}

export function formatCost(usd) {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// usage objects from providers carry reported:false when the provider sent no
// token counts; missing usage (e.g. an interrupted stream) counts the same.
// Those must never be shown or saved as a measured 0 tokens / $0.00.
export function usageReported(usage) {
  return Boolean(usage) && usage.reported !== false;
}

export const UNREPORTED_LABEL = "usage not reported by provider · cost unknown";

export function costSummary(model, inTokens, outTokens, ms, reported = true) {
  if (!reported) return { usd: 0, unknown: true, unreported: true, label: UNREPORTED_LABEL };
  const { usd, unknown } = costFor(model, inTokens, outTokens);
  const parts = [`${inTokens}→${outTokens} tok`];
  parts.push(unknown ? "cost unknown" : formatCost(usd));
  return { usd, unknown, label: parts.join(" · ") };
}
