// VOLT — one-shot ask mode: single prompt, optional context, streaming output.
import { resolveProvider } from "./config.js";
import { chat } from "./providers.js";
import { fitContextWindow } from "./tokens.js";
import { costSummary, usageReported } from "./cost.js";
import { StreamPrinter } from "./render.js";
import { buildUserContent } from "./context.js";
import { saveSession } from "./sessions.js";
import { loadPlugins, runHooks } from "./plugins.js";
import { appendHistory } from "./history.js";
import { paint, col, gray, isColorSupported, formatDuration } from "./util.js";

export async function askOnce({ config, opts, prompt, contextBlocks, images = [], history = null }) {
  const provider = resolveProvider(opts.provider || config.providerName, {
    default_model: opts.model,
  });
  const model = opts.model || config.model || provider.default_model || "unknown";
  const system = opts.system !== undefined ? opts.system : config.systemPrompt;

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  if (history?.length) messages.push(...history);
  messages.push({ role: "user", content: buildUserContent(prompt, contextBlocks, images) });

  const json = Boolean(opts.flags?.has?.("json"));
  const quiet = Boolean(opts.flags?.has?.("quiet"));
  const plain = Boolean(opts.flags?.has?.("raw")) || !isColorSupported;
  const noStream = Boolean(opts.flags?.has?.("no-stream"));

  const plugins = await loadPlugins();
  const hasAfterResponse = plugins.some((p) => typeof p.afterResponse === "function");
  // beforeSend can rewrite the conversation; afterResponse requires batching
  let finalMessages = await runHooks(plugins, "beforeSend", messages, {
    model,
    provider: provider.name,
  });
  const fitted = fitContextWindow(finalMessages, model);
  const stream = config.stream && !json && !noStream && !hasAfterResponse;

  const started = Date.now();
  let content = "";
  let usage = null;
  const printer = new StreamPrinter({ width: process.stdout.columns, plain });
  const abort = new AbortController();

  if (!json) {
    process.stdout.write(
      paint(col.bold + col.purple, "⚡ ") + paint(col.gray, `${model} · answering…\n`)
    );
  }

  await chat({
    provider,
    model,
    messages: fitted,
    temperature: opts.temp !== undefined ? opts.temp : config.temperature,
    maxTokens: config.maxTokens,
    stream,
    signal: abort.signal,
    onDelta: (text) => {
      content += text;
      if (!json && !hasAfterResponse) printer.appendChunk(text);
    },
    onUsage: (u) => {
      usage = u;
    },
  });

  // plugins may transform the final response (only when response was batched)
  if (hasAfterResponse) {
    content = await runHooks(plugins, "afterResponse", content, {
      model,
      provider: provider.name,
      usage,
    });
    if (!json) printer.appendChunk(content);
  }

  if (!json) {
    printer.finish();
    process.stdout.write("\n");
    if (!quiet) {
      const { label } = costSummary(
        model,
        usage?.input_tokens ?? 0,
        usage?.output_tokens ?? 0,
        Date.now() - started,
        usageReported(usage)
      );
      process.stdout.write(paint(col.gray, `— ${label} · ${formatDuration(Date.now() - started)}`) + "\n");
    }
  }

  if (opts.name || opts.flags?.has?.("new")) {
    const name =
      opts.name ||
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .filter(Boolean)
        .slice(0, 5)
        .join("-") ||
      "chat";
    const { usd: savedUsd } = costSummary(model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, 0);
    // unreported usage is saved as unknown (reported:false, cost null), never as a measured $0
    const assistantMsg = usageReported(usage)
      ? {
          role: "assistant",
          content,
          model,
          usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 },
          cost_usd: Number(savedUsd.toFixed(6)),
        }
      : {
          role: "assistant",
          content,
          model,
          usage: { input_tokens: 0, output_tokens: 0, reported: false },
          cost_usd: null,
        };
    saveSession(name, [...finalMessages, assistantMsg], { model });
  }

  appendHistory(prompt);

  if (json) {
    const { usd } = costSummary(
      model,
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      Date.now() - started
    );
    const reported = usageReported(usage);
    process.stdout.write(
      JSON.stringify({
        model,
        provider: provider.name,
        content,
        usage: reported ? usage : null,
        usageReported: reported,
        costUsd: reported ? Number(usd.toFixed(6)) : null,
        durationMs: Date.now() - started,
      }) + "\n"
    );
  }

  return 0;
}
