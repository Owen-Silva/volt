// VOLT — Claude Code Stop hook. Claude Code invokes this (via the generated
// ~/.volt/claude/sync.js wrapper) every time a session stops, with a JSON
// payload on stdin: { session_id, transcript_path, cwd }.
//
// It reads the session transcript (JSONL) and appends the user/assistant
// messages to VOLT's session ledger (~/.volt/sessions/) in VOLT's own shape —
// with usage + model + cost_usd — so `volt cost`, `volt stats`, `volt search`
// and `volt sessions` automatically cover Claude Code sessions too. This is
// the "merge": both tools share one ledger.
//
// Idempotency: each message id is recorded in ~/.volt/claude/seen-<session>.json,
// so re-running the hook (session resumed + stopped again) never double-counts.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { VOLT_DIR } from "./config.js";
import { appendSessionLine } from "./sessions.js";
import { costSummary } from "./cost.js";

function textOfContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runStopHook({ session_id, transcript_path, cwd } = {}) {
  if (!transcript_path || !existsSync(transcript_path)) return;

  const stateDir = path.join(VOLT_DIR, "claude");
  mkdirSync(stateDir, { recursive: true });
  const seenFile = path.join(
    stateDir,
    `seen-${String(session_id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`
  );
  let seen = new Set();
  try {
    seen = new Set(JSON.parse(readFileSync(seenFile, "utf8")));
  } catch {
    /* first run for this session */
  }

  const proj = String(cwd || "").split(/[\\/]/).filter(Boolean).pop() || "claude";
  const name = `claude-${proj}-${String(session_id || "unknown").slice(0, 8)}`;
  let appended = 0;

  for (const [idx, line] of readFileSync(transcript_path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // malformed line — skip
    }
    const msg = rec?.message;
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    if (role !== "assistant" && role !== "user") continue;

    // index in the fallback keeps idempotency keys unique even when records
    // share a timestamp or have none
    const id = msg.id || `r${idx}:${rec.timestamp || Date.now()}`;
    if (seen.has(id)) continue;

    const content = textOfContent(msg.content);
    const usage =
      msg.usage && typeof msg.usage === "object"
        ? {
            input_tokens: msg.usage.input_tokens || 0,
            output_tokens: msg.usage.output_tokens || 0,
          }
        : null;
    const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : Date.now();
    const model = typeof msg.model === "string" ? msg.model : null;

    const entry = {
      role,
      content: content || (role === "assistant" ? "…" : ""),
      model,
      usage,
      ts,
    };
    if (role === "assistant" && usage && model) {
      const { usd } = costSummary(model, usage.input_tokens, usage.output_tokens, 0);
      entry.cost_usd = Number(usd.toFixed(6));
    }
    appendSessionLine(name, entry);
    seen.add(id);
    appended++;
  }

  if (appended) {
    writeFileSync(seenFile, JSON.stringify([...seen]) + "\n");
  }
}
