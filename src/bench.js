// VOLT — `volt bench`: measure the things VOLT optimizes for — cold start,
// provider round-trips, and time-to-first-token — so you can see the cost of
// every layer and compare providers/models.
import { resolveProvider } from "./config.js";
import { chat, fetchModels } from "./providers.js";
import { paint, col, green, red, gray, bold } from "./util.js";

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { result, ms };
}

export async function runBench({ config, opts }) {
  const json = Boolean(opts.flags?.has?.("json"));
  const provider = resolveProvider(opts.provider || config.providerName, {
    default_model: opts.model,
  });
  const model = opts.model || config.model || provider.default_model || "unknown";

  const out = { provider: provider.name, model, baseUrl: provider.baseUrl, checks: {} };

  if (!provider.baseUrl) {
    console.error(red("error: no base URL — set VOLT_BASE_URL or configure a provider"));
    return 2;
  }

  const row = (name, ms, extra = "") => {
    if (json) return;
    const msLabel = ms < 1 ? `${Math.round(ms * 100) / 100}ms` : `${Math.round(ms)}ms`;
    const color = ms < 300 ? green : ms < 1500 ? (t) => t : red;
    const tag = ms < 300 ? "fast" : ms < 1500 ? "ok" : "slow";
    process.stdout.write(`  ${name.padEnd(28)} ${color(msLabel.padEnd(8))} ${gray(tag)}${extra ? "  " + gray(extra) : ""}\n`);
  };

  if (!json) {
    process.stdout.write(
      paint(col.bold + col.purple, "⚡ bench ") +
        paint(col.gray, `${provider.name} · ${model} · ${provider.baseUrl}\n`)
    );
    process.stdout.write(gray("  (sample sizes are small — relative numbers matter)\n\n"));
  }

  // 1. model list round-trip
  try {
    const { result: models, ms } = await timed(() => fetchModels(provider));
    out.checks.models = { ok: true, ms: Math.round(ms), count: models.length };
    row("models round-trip", ms, `${models.length} models`);
  } catch (err) {
    out.checks.models = { ok: false, ms: 0, error: err.message };
    if (!json) process.stdout.write(`  ${red("models")} ${red("error: " + err.message)}\n`);
  }

  // 2. batched completion round-trip
  const probe = [{ role: "user", content: "Reply with the single word: pong." }];
  try {
    const { ms } = await timed(() =>
      chat({
        provider,
        model,
        messages: probe,
        temperature: 0,
        maxTokens: 32,
        stream: false,
        onDelta: () => {},
        onUsage: () => {},
      })
    );
    out.checks.roundTrip = { ok: true, ms: Math.round(ms) };
    row("completion round-trip", ms);
  } catch (err) {
    out.checks.roundTrip = { ok: false, ms: 0, error: err.message };
    if (!json) process.stdout.write(`  ${red("completion")} ${red("error: " + err.message)}\n`);
  }

  // 3. streaming: time-to-first-token
  try {
    let first = null;
    const { ms } = await timed(() =>
      chat({
        provider,
        model,
        messages: probe,
        temperature: 0,
        maxTokens: 64,
        stream: true,
        onDelta: () => {},
        onUsage: () => {},
      })
    );
    out.checks.stream = { ok: true, ms: Math.round(ms) };
    row("stream (ttft + drain)", ms);
  } catch (err) {
    out.checks.stream = { ok: false, ms: 0, error: err.message };
    if (!json) process.stdout.write(`  ${red("stream")} ${red("error: " + err.message)}\n`);
  }

  if (json) {
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }

  process.stdout.write("\n");
  process.stdout.write(
    gray("tip: compare providers with ") + bold("volt compare -m a -m b \"ping\"") + "\n"
  );
  return 0;
}
