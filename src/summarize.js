// VOLT — conversation summarization, shared by the REPL /compact command
// and the `volt summarize <session>` CLI command.
import { chat } from "./providers.js";
import { contentText } from "./util.js";

const SUMMARY_SYSTEM =
  "You are a precise conversation summarizer. Condense the developer " +
  "conversation below into a concise summary (bullets ok, under 250 words) " +
  "covering: the goal, key decisions, files touched, current state, and open " +
  "questions. Plain text only, no markdown headers.";

export async function summarizeMessages({ provider, model, messages, temperature }) {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "user" : "assistant"}: ${contentText(m.content).slice(0, 800)}`)
    .join("\n\n")
    .slice(-60000);
  let summary = "";
  let usage = null;
  await chat({
    provider,
    model,
    maxTokens: 1024,
    temperature: temperature ?? 0.2,
    stream: false,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: "Summarize this conversation:\n\n" + transcript },
    ],
    onDelta: (t) => (summary += t),
    onUsage: (u) => (usage = u),
  });
  return { summary: summary.trim(), usage };
}
