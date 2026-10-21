// VOLT — `volt cost`: aggregate tokens and spend across every saved session,
// per model. Every assistant message carries usage + cost_usd, so this needs
// no API calls — it's your personal spend ledger.
import { listSessions, loadSession } from "./sessions.js";
import { formatCost } from "./cost.js";
import { paint, col, green, gray, bold } from "./util.js";

export async function runCostReport({ json = false } = {}) {
  const sessions = listSessions();
  const perModel = new Map();
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let msgCount = 0;
  let unreported = 0; // messages saved with usage.reported === false (provider sent no counts)

  for (const s of sessions) {
    for (const m of loadSession(s.name) || []) {
      if (m.role === "assistant" && m.usage) {
        if (m.usage.reported === false) unreported++;
        const inT = m.usage.input_tokens || 0;
        const outT = m.usage.output_tokens || 0;
        const cost = m.cost_usd || 0;
        totalIn += inT;
        totalOut += outT;
        totalCost += cost;
        msgCount++;
        const key = m.model || "unknown";
        const e = perModel.get(key) || { in: 0, out: 0, cost: 0, n: 0 };
        e.in += inT;
        e.out += outT;
        e.cost += cost;
        e.n++;
        perModel.set(key, e);
      }
    }
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({
        sessions: sessions.length,
        messages: msgCount,
        unreportedMessages: unreported,
        totals: { inputTokens: totalIn, outputTokens: totalOut, costUsd: Number(totalCost.toFixed(6)) },
        perModel: [...perModel.entries()].map(([model, e]) => ({
          model,
          messages: e.n,
          inputTokens: e.in,
          outputTokens: e.out,
          costUsd: Number(e.cost.toFixed(6)),
        })),
      }) + "\n"
    );
    return 0;
  }

  if (!msgCount) {
    console.log(gray("no cost data yet — run `volt chat` or `volt ask -n <name>` to start tracking"));
    return 0;
  }

  console.log(paint(col.bold + col.purple, "⚡ cost ") + gray(`across ${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${msgCount} messages`));
  const rows = [...perModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const w = Math.max(...rows.map(([m]) => m.length), 8);
  for (const [model, e] of rows) {
    console.log(
      `  ${model.padEnd(w)}  ${gray(String(e.n).padStart(4) + " msgs")}  ${gray(`${e.in.toLocaleString()}→${e.out.toLocaleString()} tok`)}  ${green(formatCost(e.cost))}`
    );
  }
  console.log(
    `  ${bold("total".padEnd(w))}  ${gray(String(msgCount).padStart(4) + " msgs")}  ${gray(`${totalIn.toLocaleString()}→${totalOut.toLocaleString()} tok`)}  ${green(formatCost(totalCost))}`
  );
  if (unreported) console.log(gray(`  note: ${unreported} message${unreported === 1 ? "" : "s"} had no usage from the provider; their tokens and cost are unknown and not in these totals`));
  return 0;
}
