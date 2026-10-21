// VOLT — `volt review`: a structured code review of your git diff or of
// specific files. The model reports findings in a parseable severity format;
// `--gate` makes the exit code 1 when any critical finding is present, so the
// command works as a CI gate. `-j` emits machine-readable JSON.
import { resolveProvider } from "./config.js";
import { chat } from "./providers.js";
import { fitContextWindow } from "./tokens.js";
import { costSummary, usageReported } from "./cost.js";
import { StreamPrinter } from "./render.js";
import { buildPrompt, gitDiff, readFileContext } from "./context.js";
import {
  paint,
  col,
  red,
  green,
  yellow,
  cyan,
  gray,
  bold,
  isColorSupported,
  formatDuration,
} from "./util.js";

const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const SEV_COLOR = { critical: red, high: red, medium: yellow, low: cyan, info: gray };

const REVIEW_SYSTEM = `You are a senior engineer doing a rigorous code review. Find real bugs, security issues, correctness problems, and readability wins. Report each finding on its own line in this exact format:
- [severity] location — description
where severity is one of: critical, high, medium, low, info. Be specific: name the file and line or symbol. End with a one-line Summary.`;

export function parseFindings(content) {
  const findings = [];
  const re = /^\s*[-*]\s*\[(critical|high|medium|low|info)\]\s*(.*)$/gim;
  let m;
  while ((m = re.exec(content)) !== null) {
    findings.push({ severity: m[1].toLowerCase(), text: m[2].trim() });
  }
  return findings;
}

export function severityCounts(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

export async function runReview({ config, opts, files }) {
  const provider = resolveProvider(opts.provider || config.providerName, {
    default_model: opts.model,
  });
  const model = opts.model || config.model || provider.default_model || "unknown";
  const json = Boolean(opts.flags?.has?.("json"));
  const quiet = Boolean(opts.flags?.has?.("quiet"));
  const plain = Boolean(opts.flags?.has?.("raw")) || !isColorSupported;
  const gate = Boolean(opts.flags?.has?.("gate"));
  const noStream = Boolean(opts.flags?.has?.("no-stream"));

  // context: explicit files, or the working-tree diff
  const blocks = [];
  if (files.length) {
    blocks.push(...readFileContext(files));
  } else {
    const d = await gitDiff();
    if (!d) {
      console.error(
        red("error: nothing to review — no files given and no git diff found (not a repo, or working tree clean)")
      );
      return 2;
    }
    blocks.push(d);
  }
  const label = files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "git diff";
  const prompt = "Review the code below.";

  const system = opts.system !== undefined ? opts.system : config.systemPrompt;
  const messages = [
    { role: "system", content: system ? `${REVIEW_SYSTEM}\n\n${system}` : REVIEW_SYSTEM },
    { role: "user", content: buildPrompt(prompt, blocks) },
  ];
  const fitted = fitContextWindow(messages, model);

  const started = Date.now();
  let content = "";
  let usage = null;
  const printer = new StreamPrinter({ width: process.stdout.columns, plain });

  if (!json) {
    process.stdout.write(
      paint(col.bold + col.purple, "⚡ review ") +
        paint(col.gray, `${label} · ${model} · answering…\n`)
    );
  }

  await chat({
    provider,
    model,
    messages: fitted,
    temperature: opts.temp !== undefined ? opts.temp : config.temperature,
    maxTokens: config.maxTokens,
    stream: config.stream && !json && !noStream,
    onDelta: (text) => {
      content += text;
      if (!json) printer.appendChunk(text);
    },
    onUsage: (u) => {
      usage = u;
    },
  });

  if (!json) printer.finish();

  const findings = parseFindings(content);
  const counts = severityCounts(findings);

  if (!json) {
    process.stdout.write("\n");
    if (!quiet) {
      const parts = SEVERITIES.map((s) => {
        const n = counts[s] || 0;
        if (!n) return null;
        return SEV_COLOR[s](`${n} ${s}`);
      }).filter(Boolean);
      process.stdout.write(
        paint(col.bold, "findings: ") +
          (parts.length ? parts.join(paint(col.gray, " · ")) : green("none")) +
          "\n"
      );
      const { label: costLabel } = costSummary(model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, Date.now() - started, usageReported(usage));
      process.stdout.write(
        paint(col.gray, `— ${costLabel} · ${formatDuration(Date.now() - started)} · ${model}`) + "\n"
      );
    }
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({
        model,
        provider: provider.name,
        findings,
        counts,
        content,
        usage: usage || null,
        durationMs: Date.now() - started,
      }) + "\n"
    );
  }

  if (gate && counts.critical > 0) return 1;
  return 0;
}
