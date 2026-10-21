// VOLT — `volt compare`: run one question across several models in parallel
// and show each answer with cost and latency. Great for picking a model or
// sanity-checking answers. Use `-m a -m b` or `--models a,b`.
import { resolveProvider } from "./config.js";
import { chat } from "./providers.js";
import { fitContextWindow } from "./tokens.js";
import { costSummary, formatCost, usageReported } from "./cost.js";
import { renderMarkdown } from "./render.js";
import { buildUserContent } from "./context.js";
import {
  paint,
  col,
  red,
  cyan,
  gray,
  bold,
  isColorSupported,
  formatDuration,
} from "./util.js";

const MAX_MODELS = 5;

export async function runCompare({ config, opts, prompt, contextBlocks, images = [] }) {
  const json = Boolean(opts.flags?.has?.("json"));
  const raw = Boolean(opts.flags?.has?.("raw"));
  const quiet = Boolean(opts.flags?.has?.("quiet"));

  let models = opts.models?.length ? opts.models : [config.model || "unknown"];
  models = [...new Set(models)].slice(0, MAX_MODELS);
  const providerNames = opts.providers?.length ? opts.providers : null;

  const system = opts.system !== undefined ? opts.system : config.systemPrompt;
  const userContent = buildUserContent(prompt, contextBlocks, images);

  if (!json && !quiet) {
    process.stdout.write(
      paint(col.bold + col.purple, "⚡ compare ") +
        paint(col.gray, `${models.length} model${models.length === 1 ? "" : "s"} in parallel · ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}\n`)
    );
  }

  const results = await Promise.all(
    models.map(async (modelHint, i) => {
      const providerName = providerNames?.[i] || opts.provider || config.providerName;
      const provider = resolveProvider(providerName, { default_model: modelHint });
      const model = modelHint || provider.default_model || "unknown";
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: userContent });
      const fitted = fitContextWindow(messages, model);
      const started = Date.now();
      let content = "";
      let usage = null;
      let error = null;
      try {
        await chat({
          provider,
          model,
          messages: fitted,
          temperature: opts.temp !== undefined ? opts.temp : config.temperature,
          maxTokens: config.maxTokens,
          stream: false,
          onDelta: (t) => (content += t),
          onUsage: (u) => (usage = u),
        });
      } catch (err) {
        error = err.message;
      }
      const dur = Date.now() - started;
      const reported = usageReported(usage);
      const { usd, label } = costSummary(model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, dur, reported);
      return { model, provider: provider.name, content, usage: reported ? usage : null, usageReported: reported, costUsd: reported ? Number(usd.toFixed(6)) : null, durationMs: dur, costLabel: label, error };
    })
  );

  if (json) {
    process.stdout.write(
      JSON.stringify(
        results.map((r) => ({
          model: r.model,
          provider: r.provider,
          content: r.content,
          usage: r.usage,
          costUsd: r.costUsd,
          durationMs: r.durationMs,
          error: r.error,
        }))
      ) + "\n"
    );
    return 0;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (i > 0) process.stdout.write("\n");
    process.stdout.write(
      paint(col.bold + col.blue, `══ ${i + 1}. ${r.model} `) +
        paint(col.gray, `(${r.provider})`) +
        "\n" +
        paint(col.gray, "─".repeat(Math.min(process.stdout.columns || 60, 60))) +
        "\n"
    );
    if (r.error) {
      process.stdout.write(red("error: ") + r.error + "\n");
    } else {
      process.stdout.write((raw || !isColorSupported ? r.content : renderMarkdown(r.content)) + "\n");
    }
    if (!quiet) {
      process.stdout.write(
        paint(col.gray, `— ${r.costLabel} · ${formatDuration(r.durationMs)}`) + "\n"
      );
    }
  }
  return 0;
}
