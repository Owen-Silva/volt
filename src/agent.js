// VOLT — agent mode: an autonomous loop that gives the model tools
// (run_command, read_file, write_file, list_dir) and iterates until the
// task is done, with streaming output, cost tracking, and Ctrl+C abort.
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { resolveProvider } from "./config.js";
import { chat } from "./providers.js";
import { costSummary, usageReported, UNREPORTED_LABEL } from "./cost.js";
import { StreamPrinter } from "./render.js";
import { buildPrompt } from "./context.js";
import { contextWindow, estimateTokens } from "./tokens.js";
import { loadPlugins, runHooks } from "./plugins.js";
import {
  paint,
  col,
  red,
  green,
  cyan,
  gray,
  dim,
  isTTY,
  isColorSupported,
  formatDuration,
  startSpinner,
} from "./util.js";

const MAX_TOOL_OUTPUT = 30000; // chars of tool output sent back to the model
const MAX_PREVIEW = 400; // chars of tool output shown in the terminal log

export const TOOLS = [
  {
    name: "run_command",
    description:
      "Run a shell command in the project directory and return its combined stdout+stderr. Use this for builds, tests, git operations, package installs, and anything that needs the shell. Prefer targeted commands; a command that exits non-zero returns its error output.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a text file from the project directory and return its contents (up to 64 KB). Use before editing a file you haven't seen.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project directory" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a text file inside the project directory. Parent directories are created automatically. Use to implement changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project directory" },
        content: { type: "string", description: "The full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description:
      "List the entries of a directory (defaults to the project root). Shows subdirectories with a trailing slash.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the project directory" },
      },
    },
  },
  {
    name: "grep",
    description:
      "Search file contents in the project for a regex pattern. Returns up to 60 matches as path:line: text. Use to find where things are defined or referenced before editing.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "Subdirectory to limit the search to (defaults to the project root)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description:
      "Find files by a glob pattern (supports **, *, ?) relative to the project root. Returns matching relative paths. Use to locate files before reading or editing them.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. **/*.test.js or src/**/*.js" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "edit_file",
    description:
      "Apply a precise text replacement inside a file (defaults to the first occurrence; set count to a number > 1 or \"all\" to replace every occurrence). Returns how many replacements were made. Prefer this over rewrite_file for small targeted changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project directory" },
        old: { type: "string", description: "Exact text to find (whitespace matters)" },
        new: { type: "string", description: "Replacement text" },
        count: { type: "string", description: "\"1\" (first only, default) or \"all\"" },
      },
      required: ["path", "old", "new"],
    },
  },
];

const TOOL_SCHEMA = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

function agentSystem(extra) {
  return (
    `You are VOLT agent, an autonomous coding assistant running in the user's terminal. ` +
    `You complete tasks by reasoning and using the provided tools. You work inside the ` +
    `project directory. Rules:\n` +
    `- Prefer the smallest number of tool calls that gets the job done.\n` +
    `- Use run_command to inspect state (ls, git status, cat, tests) before assuming.\n` +
    `- Prefer grep to locate code, read_file to understand it, and edit_file ` +
    `for small targeted changes (write_file for whole files).\n` +
    `- When you have finished the task, reply to the user directly with a clear summary ` +
    `of what you did and how to verify it. Do not call tools in that final reply.\n` +
    `- If a tool errors, read the error, adjust, and retry; don't give up after one failure.\n` +
    (extra ? `\n${extra}` : "")
  );
}

// Turn a glob pattern (** / * / ?) into an anchored regex. `**/` matches zero
// or more directory segments (so src/**/*.js also matches src/x.js).
function globToRegExp(glob) {
  const esc = (ch) => (/[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch);
  let s = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        s += "(?:.*/)?";
        i += 2;
      } else {
        s += ".*";
        i++;
      }
    } else if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else s += esc(c);
  }
  return new RegExp("^" + s + "$");
}

// Recursive, capped directory walk that yields file paths. Skips node_modules
// and .git; stops after `cap` files (or infinite if cap is 0).
function walkFiles(root, cap = 0) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 14 || (cap && out.length >= cap)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (cap && out.length >= cap) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

// Keep all tool paths inside the project directory so an agent can't wander.
function inside(cwd, p) {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the project directory: ${p}`);
  }
  return abs;
}

function runCommand(command, { cwd, signal, timeoutMs }) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(shell, args, {
      cwd,
      windowsHide: true,
      signal,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let out = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve({ ok: false, output: `[volt] command timed out after ${Math.round(timeoutMs / 1000)}s:\n${out.slice(-2000)}` });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, output: `[volt] could not start command: ${err.message}` });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const trimmed = out.trimEnd();
      resolve({ ok: code === 0, output: code === 0 ? trimmed : trimmed || `(exit code ${code})` });
    });
  });
}

async function callTool({ cwd, signal, timeoutMs }, name, rawArgs) {
  let args;
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return { ok: false, output: `[volt] tool arguments were not valid JSON: ${String(rawArgs).slice(0, 200)}` };
  }
  try {
    switch (name) {
      case "run_command": {
        if (!args.command || typeof args.command !== "string") {
          return { ok: false, output: "[volt] run_command requires a string \"command\"" };
        }
        const res = await runCommand(args.command, { cwd, signal, timeoutMs });
        return res;
      }
      case "read_file": {
        const abs = inside(cwd, args.path || "");
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          return { ok: false, output: `[volt] no such file: ${args.path}` };
        }
        let content = readFileSync(abs, "utf8");
        if (content.length > 64 * 1024) {
          content = content.slice(0, 64 * 1024) + "\n… [truncated by volt]";
        }
        return { ok: true, output: content };
      }
      case "write_file": {
        if (typeof args.path !== "string" || typeof args.content !== "string") {
          return { ok: false, output: '[volt] write_file requires string "path" and "content"' };
        }
        const abs = inside(cwd, args.path);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, args.content);
        return { ok: true, output: `wrote ${args.path} (${Buffer.byteLength(args.content)} bytes)` };
      }
      case "list_dir": {
        const abs = args.path ? inside(cwd, args.path) : cwd;
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          return { ok: false, output: `[volt] no such directory: ${args.path || "."}` };
        }
        const entries = readdirSync(abs, { withFileTypes: true });
        const lines = entries
          .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
          .sort((a, b) => (a.endsWith("/") === b.endsWith("/") ? a.localeCompare(b) : a.endsWith("/") ? -1 : 1));
        return { ok: true, output: lines.join("\n") || "(empty directory)" };
      }
      case "grep": {
        if (typeof args.pattern !== "string" || !args.pattern) {
          return { ok: false, output: '[volt] grep requires a string "pattern"' };
        }
        const root = args.path ? inside(cwd, args.path) : cwd;
        if (!existsSync(root) || !statSync(root).isDirectory()) {
          return { ok: false, output: `[volt] no such directory: ${args.path || "."}` };
        }
        let re;
        try {
          re = new RegExp(args.pattern, "i");
        } catch (err) {
          return { ok: false, output: `[volt] bad regex: ${err.message}` };
        }
        const hits = [];
        for (const f of walkFiles(root, 1000)) {
          let text;
          try {
            text = readFileSync(f, "utf8");
          } catch {
            continue;
          }
          if (text.includes("\0")) continue; // binary
          // normalize separators so patterns match on Windows too
          const rel = path.relative(cwd, f).split(path.sep).join("/");
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (hits.length >= 60) break;
            }
          }
          if (hits.length >= 60) break;
        }
        return {
          ok: hits.length > 0,
          output: hits.length ? hits.join("\n") : `no matches for /${args.pattern}/ in ${args.path || "."}`,
        };
      }
      case "glob": {
        if (typeof args.pattern !== "string" || !args.pattern) {
          return { ok: false, output: '[volt] glob requires a string "pattern"' };
        }
        let rx;
        try {
          rx = globToRegExp(args.pattern);
        } catch (err) {
          return { ok: false, output: `[volt] bad glob: ${err.message}` };
        }
        const hits = walkFiles(cwd, 500)
          .map((f) => path.relative(cwd, f).split(path.sep).join("/"))
          .filter((rel) => rx.test(rel))
          .sort();
        return {
          ok: hits.length > 0,
          output: hits.length ? hits.join("\n") : `no files match ${args.pattern}`,
        };
      }
      case "edit_file": {
        if (
          typeof args.path !== "string" ||
          typeof args.old !== "string" ||
          typeof args.new !== "string"
        ) {
          return { ok: false, output: '[volt] edit_file requires string "path", "old" and "new"' };
        }
        if (!args.old) return { ok: false, output: '[volt] edit_file "old" must not be empty' };
        const abs = inside(cwd, args.path);
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          return { ok: false, output: `[volt] no such file: ${args.path}` };
        }
        const orig = readFileSync(abs, "utf8");
        const all = args.count === "all" || (Number(args.count) || 0) > 1;
        let next;
        let found;
        if (all) {
          const parts = orig.split(args.old);
          if (parts.length === 1) {
            return { ok: false, output: `[volt] \"old\" text not found in ${args.path} — check exact whitespace` };
          }
          found = parts.length - 1;
          next = parts.join(args.new);
        } else {
          const idx = orig.indexOf(args.old);
          if (idx === -1) {
            return { ok: false, output: `[volt] \"old\" text not found in ${args.path} — check exact whitespace` };
          }
          found = 1;
          next = orig.slice(0, idx) + args.new + orig.slice(idx + args.old.length);
        }
        writeFileSync(abs, next);
        return { ok: true, output: `edited ${args.path}: replaced ${found} occurrence${found === 1 ? "" : "s"}` };
      }
      default:
        return { ok: false, output: `[volt] unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `[volt] ${err.message}` };
  }
}

function briefArgs(raw) {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 80) + "…" : t || "(no args)";
}

// Drop the oldest assistant(tool_calls)+tool message pairs while the
// conversation is over the model's context budget, keeping each pair intact
// so the API never sees an orphaned tool message.
function trimIfNeeded(messages, model) {
  const budget = contextWindow(model) - 4096;
  while (messages.reduce((a, m) => a + estimateTokens(m.content), 0) > budget) {
    const idx = messages.findIndex((m, i) => i > 0 && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length);
    if (idx === -1) break;
    // remove the assistant turn plus every tool message that follows it
    let end = idx + 1;
    while (end < messages.length && messages[end].role === "tool") end++;
    messages.splice(idx, end - idx);
    if (messages.length <= 2) break;
  }
  return messages;
}

export async function runAgent({ config, opts, prompt, contextBlocks }) {
  const provider = resolveProvider(opts.provider || config.providerName, {
    default_model: opts.model,
  });
  const model = opts.model || config.model || provider.default_model || "unknown";
  if (provider.family !== "openai") {
    throw new Error(
      `agent mode requires an OpenAI-compatible provider ("${provider.name}" uses the Anthropic protocol).\n` +
        "  hint: set VOLT_PROVIDER=openai (or ollama/groq/openrouter/deepseek…) for agent mode"
    );
  }

  const json = Boolean(opts.flags?.has?.("json"));
  const quiet = Boolean(opts.flags?.has?.("quiet"));
  const plain = Boolean(opts.flags?.has?.("raw")) || !isColorSupported;
  const noStream = Boolean(opts.flags?.has?.("no-stream"));
  const maxSteps = Math.max(1, Number(opts.steps ?? config.agent_steps ?? 10) || 10);
  const timeoutMs = Math.max(1000, Number(opts.commandTimeout ?? config.agent_command_timeout ?? 30000) || 30000);
  const cwd = process.cwd();
  const system = opts.system !== undefined ? opts.system : config.systemPrompt;

  const messages = await runHooks(await loadPlugins(), "beforeSend", [
    { role: "system", content: system ? agentSystem(system) : agentSystem(null) },
    { role: "user", content: buildPrompt(prompt, contextBlocks) },
  ], { model, provider: provider.name });

  const started = Date.now();
  const usageTotals = { input: 0, output: 0 };
  let costUsd = 0;
  let rounds = 0;
  let unreportedRounds = 0; // rounds whose provider sent no token counts
  let content = "";
  const toolCalls = [];
  const abort = new AbortController();
  let interrupted = false;

  const onSigint = () => abort.abort();
  process.on("SIGINT", onSigint);

  const header = () => {
    if (json) return;
    process.stdout.write(
      paint(col.bold + col.purple, "⚡ agent ") +
        paint(col.gray, `${model} · up to ${maxSteps} steps · answering…\n`)
    );
  };

  try {
    header();
    let steps = 0;
    let finished = false;

    while (steps < maxSteps && !finished && !abort.signal.aborted) {
      steps++;
      let roundUsage = null;
      let roundToolCalls = null;
      let assistantMsg = null;
      const printer = new StreamPrinter({ width: process.stdout.columns, plain });

      if (steps > 1 && !json) {
        process.stdout.write(paint(col.gray, `— step ${steps} —\n`));
      }

      try {
        await chat({
          provider,
          model,
          messages,
          temperature: opts.temp !== undefined ? opts.temp : config.temperature,
          maxTokens: config.maxTokens,
          stream: !json && !noStream && config.stream !== false,
          signal: abort.signal,
          tools: TOOL_SCHEMA,
          onDelta: (text) => {
            content += text;
            if (!json) printer.appendChunk(text);
          },
          onUsage: (u) => {
            roundUsage = u;
          },
          onToolCalls: (calls, raw) => {
            roundToolCalls = calls;
            assistantMsg = raw;
          },
        });
      } catch (err) {
        if (err.name === "AbortError") {
          interrupted = true;
          if (!json) printer.finish();
          break;
        }
        throw err;
      }

      if (!json) printer.finish();

      rounds++;
      if (usageReported(roundUsage)) {
        const inT = roundUsage.input_tokens ?? 0;
        const outT = roundUsage.output_tokens ?? 0;
        usageTotals.input += inT;
        usageTotals.output += outT;
        const { usd } = costSummary(model, inT, outT, Date.now() - started);
        costUsd += usd;
      } else {
        unreportedRounds++;
      }

      if (!roundToolCalls?.length) {
        finished = true;
        break;
      }

      // persist the assistant's tool-call message so the API sees a valid
      // conversation (tool messages must follow a matching tool_calls turn)
      messages.push({
        role: "assistant",
        content: assistantMsg?.content || "",
        tool_calls: roundToolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      for (const tc of roundToolCalls) {
        toolCalls.push({ name: tc.name, arguments: tc.arguments, id: tc.id });
        if (!json) {
          process.stdout.write(
            paint(col.blue, "▸ ") + cyan(tc.name) + " " + gray(briefArgs(tc.arguments)) + "\n"
          );
        }
        const res = await callTool({ cwd, signal: abort.signal, timeoutMs }, tc.name, tc.arguments);
        if (!json) {
          const preview = String(res.output || "").slice(0, MAX_PREVIEW);
          const lines = String(res.output || "").split("\n").length;
          const size = Buffer.byteLength(res.output || "");
          process.stdout.write(
            (res.ok ? paint(col.green, "  ✔ ") : paint(col.red, "  ✘ ")) +
              dim(`${size} bytes · ${lines} lines`) +
              "\n"
          );
          if (preview) process.stdout.write(dim(preview.slice(0, 1200)) + "\n");
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: res.ok ? String(res.output || "").slice(0, MAX_TOOL_OUTPUT) : res.output,
        });
        trimIfNeeded(messages, model);
      }
    }

    if (abort.signal.aborted) interrupted = true;
    if (!finished && !interrupted && !json) {
      process.stdout.write(
        paint(col.yellow, `⚠ reached ${maxSteps} steps — task may be incomplete\n`)
      );
    }
    if (interrupted && !json) {
      process.stdout.write(gray("\n(interrupted)\n"));
    }

    if (!json) {
      process.stdout.write("\n");
      if (!quiet) {
        let { label } = costSummary(model, usageTotals.input, usageTotals.output, Date.now() - started);
        if (unreportedRounds && unreportedRounds === rounds) label = UNREPORTED_LABEL;
        else if (unreportedRounds)
          label += ` (partial: ${unreportedRounds} of ${rounds} rounds had no usage from the provider)`;
        process.stdout.write(
          paint(
            col.gray,
            `— ${label} · ${steps} step${steps === 1 ? "" : "s"} · ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"} · ${formatDuration(Date.now() - started)} · ${model}`
          ) + "\n"
        );
      }
    }

    if (json) {
      process.stdout.write(
        JSON.stringify({
          model,
          provider: provider.name,
          steps,
          maxStepsReached: !finished && !interrupted,
          interrupted,
          content,
          toolCalls: toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })),
          usage: usageTotals,
          usageReported: unreportedRounds === 0,
          unreportedRounds,
          costUsd: unreportedRounds === rounds && rounds > 0 ? null : Number(costUsd.toFixed(6)),
          durationMs: Date.now() - started,
        }) + "\n"
      );
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
