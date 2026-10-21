// VOLT — lightweight token estimation + context-window budgeting.
// Estimates are heuristic (~4 chars/token, CJK ≈ 1 char/token) and
// dependency-free by design. Good enough to keep you inside the window.

export function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== "string") {
    text = Array.isArray(text)
      ? text.map((p) => (typeof p === "string" ? p : p.text || "")).join("\n")
      : JSON.stringify(text);
  }
  let t = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    t += c > 0x2ff ? 1.0 : 0.25;
  }
  return Math.max(1, Math.ceil(t));
}

// OpenAI multimodal messages carry content as [{type:"text",…},{type:"image_url",…}].
// Images are priced coarsely (~1k tokens each) so context budgeting still works.
const IMAGE_TOKENS = 1000;
export function messageTokens(m) {
  if (Array.isArray(m.content)) {
    const text = m.content
      .map((p) => (typeof p === "string" ? p : p.text || ""))
      .join("\n");
    const images = m.content.filter((p) => p.type === "image_url" || p.image_url).length;
    return estimateTokens(text) + images * IMAGE_TOKENS;
  }
  return estimateTokens(m.content);
}

const CONTEXT_WINDOWS = [
  { match: /gpt-4\.1/i, window: 1047576 },
  { match: /gpt-4o/i, window: 128000 },
  { match: /gpt-4/i, window: 8192 },
  { match: /o1|o3|o4/i, window: 200000 },
  { match: /claude/i, window: 200000 },
  { match: /deepseek-chat/i, window: 64000 },
  { match: /deepseek-reasoner/i, window: 64000 },
  { match: /llama/i, window: 131072 },
  { match: /mistral|mixtral/i, window: 32768 },
  { match: /gemma/i, window: 32768 },
  { match: /qwen/i, window: 32768 },
  { match: /command-r/i, window: 128000 },
  { match: /nemotron/i, window: 131072 },
];

export function contextWindow(model = "") {
  if (!model) return 128000;
  for (const { match, window } of CONTEXT_WINDOWS) {
    if (match.test(model)) return window;
  }
  return 128000;
}

/**
 * Trim a message list to fit the model's context window, dropping the oldest
 * non-system, non-final messages first. Efficiency by default: you never pay
 * for overflow, and you never get a silent 400 error.
 */
// Drop priority: oldest conversation turns first, then attached context
// (system messages after the first). Index 0 (the system prompt) and the
// final message are always kept.
function pickTrimIndex(out) {
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i].role !== "system") return i;
  }
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i].role === "system") return i;
  }
  return -1;
}

export function fitContextWindow(messages, model, reserve = 1024) {
  const budget = contextWindow(model) - reserve;
  let total = 0;
  for (const m of messages) total += messageTokens(m);
  if (total <= budget || messages.length <= 2) return messages;

  const out = [...messages];
  while (total > budget && out.length > 2) {
    const idx = pickTrimIndex(out);
    if (idx === -1) break;
    total -= messageTokens(out[idx]);
    out.splice(idx, 1);
  }
  if (out.length < messages.length) {
    out.push({
      role: "system",
      content: `[volt] Earlier context was trimmed automatically to stay inside ${model}'s context window.`,
    });
  }
  return out;
}
