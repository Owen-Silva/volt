// VOLT — `volt stats`: a usage dashboard across every saved session.
// Reads the local session ledger (no API calls): message counts, tokens,
// spend, per-model breakdown, and activity.
import { listSessions, loadSession } from "./sessions.js";
import { formatCost } from "./cost.js";
import { paint, col, green, gray, bold } from "./util.js";

export async function runStats({ json = false } = {}) {
  const sessions = listSessions();
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let userMsgs = 0;
  let assistantMsgs = 0;
  let unreported = 0; // assistant messages saved with usage.reported === false
  let toolMsgs = 0;
  const perModel = new Map();
  const perDay = new Map();
  let firstTs = Infinity;
  let lastTs = 0;

  for (const s of sessions) {
    const metaTs = new Date(s.updatedAt).getTime();
    if (metaTs < firstTs) firstTs = metaTs;
    if (metaTs > lastTs) lastTs = metaTs;
    let seededMetaDay = false;
    for (const m of loadSession(s.name) || []) {
      const ts = m.ts || 0;
      if (ts) {
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
      if (m.role === "assistant") {
        assistantMsgs++;
        if (m.usage?.reported === false) unreported++;
        const inT = m.usage?.input_tokens || 0;
        const outT = m.usage?.output_tokens || 0;
        const cost = m.cost_usd || 0;
        totalIn += inT;
        totalOut += outT;
        totalCost += cost;
        const key = m.model || "unknown";
        const e = perModel.get(key) || { in: 0, out: 0, cost: 0, n: 0 };
        e.in += inT;
        e.out += outT;
        e.cost += cost;
        e.n++;
        perModel.set(key, e);
      } else if (m.role === "user") userMsgs++;
      else if (m.role === "tool") toolMsgs++;
      if (ts) {
        const day = new Date(ts).toISOString().slice(0, 10);
        perDay.set(day, (perDay.get(day) || 0) + 1);
      } else if (!seededMetaDay && metaTs) {
        // older saves lack message timestamps — count the session once
        seededMetaDay = true;
        const day = new Date(metaTs).toISOString().slice(0, 10);
        perDay.set(day, (perDay.get(day) || 0) + 1);
      }
    }
  }

  const totalMsgs = userMsgs + assistantMsgs + toolMsgs;

  if (json) {
    process.stdout.write(
      JSON.stringify({
        sessions: sessions.length,
        messages: { total: totalMsgs, user: userMsgs, assistant: assistantMsgs, tool: toolMsgs },
        tokens: { input: totalIn, output: totalOut, total: totalIn + totalOut },
        costUsd: Number(totalCost.toFixed(6)),
        unreportedMessages: unreported,
        models: [...perModel.entries()].map(([model, e]) => ({
          model,
          messages: e.n,
          inputTokens: e.in,
          outputTokens: e.out,
          costUsd: Number(e.cost.toFixed(6)),
        })),
        activity: [...perDay.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([day, n]) => ({ day, messages: n })),
        firstActivity: firstTs === Infinity ? null : new Date(firstTs).toISOString(),
        lastActivity: lastTs === 0 ? null : new Date(lastTs).toISOString(),
      }) + "\n"
    );
    return 0;
  }

  if (!sessions.length) {
    console.log(gray("no sessions yet — run `volt chat` to start one"));
    return 0;
  }

  console.log(
    paint(col.bold + col.purple, "⚡ stats ") +
      gray(`across ${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${totalMsgs} messages`)
  );
  const rows = [...perModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  if (rows.length) {
    console.log(bold("per model"));
    const w = Math.max(...rows.map(([m]) => m.length), 8);
    for (const [model, e] of rows) {
      console.log(
        `  ${model.padEnd(w)}  ${gray(String(e.n).padStart(4) + " msgs")}  ${gray(
          `${e.in.toLocaleString()}→${e.out.toLocaleString()} tok`
        )}  ${green(formatCost(e.cost))}`
      );
    }
  }
  console.log(bold("totals"));
  console.log(
    `  ${String(totalIn.toLocaleString()).padStart(10)} tokens in · ${totalOut.toLocaleString()} out · ${green(
      formatCost(totalCost)
    )}`
  );
  if (unreported) console.log(gray(`  note: ${unreported} message${unreported === 1 ? "" : "s"} had no usage from the provider; their tokens and cost are unknown and not in these totals`));
  const days = [...perDay.entries()].sort((a, b) => b[1] - a[1]);
  if (days.length) {
    const [busy, n] = days[0];
    console.log(gray(`  busiest day: ${busy} (${n} messages)`));
  }
  if (lastTs > 0) {
    const daysActive = Math.max(1, Math.round((lastTs - firstTs) / 86400000));
    console.log(gray(`  active across ${daysActive} day${daysActive === 1 ? "" : "s"}`));
  }
  return 0;
}
