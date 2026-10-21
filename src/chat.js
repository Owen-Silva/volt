// VOLT — interactive chat REPL with streaming markdown rendering,
// slash commands, session persistence, and context attachment.
import * as readline from "node:readline";

import { resolveProvider, ensureDirs, readJson, USER_CONFIG_PATH } from "./config.js";
import { chat, fetchModels } from "./providers.js";
import { fitContextWindow, contextWindow, estimateTokens } from "./tokens.js";
import { costSummary, formatCost, usageReported } from "./cost.js";
import { StreamPrinter, renderMarkdown } from "./render.js";
import { readFileContext, gitDiff, readClipboard } from "./context.js";
import {
  loadSession,
  saveSession,
  listSessions,
  deleteSession,
  appendSessionLine,
} from "./sessions.js";
import { resolveTemplate, listTemplates } from "./templates.js";
import { loadPlugins, runHooks } from "./plugins.js";
import { loadHistory, saveHistory } from "./history.js";
import { login, logout } from "./login.js";
import { summarizeMessages } from "./summarize.js";
import { extensionForFamily } from "./local-providers.js";
import {
  paint,
  col,
  red,
  green,
  yellow,
  cyan,
  gray,
  bold,
  isTTY,
  formatDuration,
  formatAge,
  contentText,
  startSpinner,
  VERSION,
} from "./util.js";

const COMMANDS = [
  ["/help", "show this help"],
  ["/model [name]", "show or switch model"],
  ["/models", "list models from the current provider"],
  ["/provider [name]", "show or switch provider"],
  ["/temp [0–2]", "show or set temperature"],
  ["/system [text]", "set system prompt (empty clears)"],
  ["/attach <files…>", "add files as context"],
  ["/diff", "attach git diff as context"],
  ["/clip", "attach clipboard as context"],
  ["/ctx", "show attached context"],
  ["/unattach", "remove all context"],
  ["/clear", "clear conversation (keep context)"],
  ["/reset", "reset conversation + context"],
  ["/cost", "show token / cost totals"],
  ["/compact", "summarize & shrink the conversation"],
  ["/tokens", "show context-window usage"],
  ["/template [name|list]", "apply a prompt template"],
  ["/login [provider] [key]", "sign in / switch API key (saves & verifies)"],
  ["/logout", "remove the saved API key"],
  ["/export", "export this conversation as markdown"],
  ["/save <name>", "save this session"],
  ["/load <name>", "load a session"],
  ["/sessions", "list saved sessions"],
  ["/delete <name>", "delete a session"],
  ["/exit", "quit volt"],
];


function completer(line) {
  if (!line.startsWith("/")) return [[], line];
  const hits = COMMANDS.map((c) => c[0].split(" ")[0]).filter((c) =>
    c.startsWith(line)
  );
  return [hits.length ? hits : [], line];
}


export async function interactiveChat({ config, opts }) {
  ensureDirs();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: loadHistory(),
    removeHistoryDuplicates: true,
    completer,
    terminal: isTTY,
  });
  rl.setPrompt(paint(col.purple, "⚡ ") + paint(col.bold, "volt") + paint(col.gray, " ❯ "));

  const state = {
    model: opts.model || config.model || "unknown",
    temp: opts.temp !== undefined ? opts.temp : config.temperature,
    provider: opts.provider || config.providerName,
    system: opts.system !== undefined ? opts.system : config.systemPrompt || "",
    messages: [],
    contextBlocks: opts.contextBlocks || [],
    totalUsage: { input: 0, output: 0 },
    costUsd: 0,
    unreportedTurns: 0, // turns whose provider sent no token counts
    sessionName: opts.sessionName || opts.name || null,
    busy: false,
    queue: [],
    abort: null,
    closed: false,
    newSession: Boolean(opts.flags?.has?.("new") || opts.newSession),
    pending: null, // multi-line continuation buffer
    plugins: [],
  };
  state.plugins = await loadPlugins();

  // session resume
  let resumedCount = 0;
  if (state.newSession) {
    state.sessionName = null;
  } else if (state.sessionName) {
    const existing = loadSession(state.sessionName);
    if (existing) {
      state.messages = existing;
      resumedCount = existing.length;
    }
  } else if (opts.resume) {
    const list = listSessions();
    if (list.length) {
      state.sessionName = list[0].name;
      state.messages = loadSession(state.sessionName) || [];
      resumedCount = state.messages.length;
    }
  }

  const note = (m) => process.stdout.write(paint(col.gray, "⚡ ") + m + "\n");

  // rl.prompt() throws "readline was closed" once stdin hits EOF (piped
  // input) — guard every call so an EOF mid-turn can't crash the loop.
  const safePrompt = () => {
    try {
      rl.prompt();
    } catch {
      /* interface closed */
    }
  };

  function banner() {
    process.stdout.write(
      "\n" +
        paint(col.bold + col.purple, "⚡ VOLT " + VERSION) +
        paint(col.gray, " — terminal AI copilot\n")
    );
    process.stdout.write(
      paint(col.gray, "  ") +
        cyan(state.provider) +
        paint(col.gray, " · ") +
        cyan(state.model) +
        paint(col.gray, ` · temp ${state.temp}`) +
        paint(col.gray, " · /help for commands") +
        "\n"
    );
  }

  function appendToSession(msg) {
    if (state.sessionName) appendSessionLine(state.sessionName, msg);
  }

  function autoName(input) {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .filter(Boolean)
      .slice(0, 6)
      .join("-") || "chat";
  }

  function buildPayload() {
    const out = [];
    if (state.system) out.push({ role: "system", content: state.system });
    if (state.contextBlocks.length) {
      out.push({
        role: "system",
        content: "Context attached by the user from the terminal:\n\n" + state.contextBlocks.join("\n\n"),
      });
    }
    out.push(...state.messages);
    return out;
  }

  async function sendTurn(input) {
    if (state.newSession && !state.sessionName) {
      state.sessionName = autoName(input);
      note("session: " + cyan(state.sessionName));
    }
    const userMsg = { role: "user", content: input, ts: Date.now() };
    state.messages.push(userMsg);
    appendToSession(userMsg);

    const provider = resolveProvider(state.provider);
    const preSend = await runHooks(state.plugins, "beforeSend", buildPayload(), {
      model: state.model,
      provider: provider.name,
    });
    const payload = fitContextWindow(preSend, state.model);
    const started = Date.now();
    let content = "";
    let usage = null;
    const printer = new StreamPrinter({ width: process.stdout.columns, plain: false });
    const abort = new AbortController();
    state.abort = abort;
    let firstToken = false;
    const stopSpin = startSpinner(`waiting on ${state.model}…`);
    let interrupted = false;

    try {
      await chat({
        provider,
        model: state.model,
        messages: payload,
        temperature: state.temp,
        maxTokens: config.maxTokens,
        stream: config.stream,
        signal: abort.signal,
        onDelta: (text) => {
          if (!firstToken) {
            firstToken = true;
            stopSpin();
          }
          content += text;
          printer.appendChunk(text);
        },
        onUsage: (u) => {
          usage = u;
        },
      });
    } catch (err) {
      if (err.name === "AbortError") {
        interrupted = true;
        stopSpin();
        if (!content) {
          printer.clearLine();
          process.stdout.write(gray("(interrupted — nothing received)\n"));
          state.abort = null;
          return;
        }
      } else {
        stopSpin();
        printer.clearLine();
        state.abort = null;
        throw err;
      }
    }
    stopSpin();
    printer.finish();
    process.stdout.write("\n");

    const dur = Date.now() - started;
    const reported = usageReported(usage);
    const inT = reported ? (usage.input_tokens ?? 0) : 0;
    const outT = reported ? (usage.output_tokens ?? 0) : 0;
    state.totalUsage.input += inT;
    state.totalUsage.output += outT;
    if (!reported) state.unreportedTurns++;
    const { usd, label } = costSummary(state.model, inT, outT, dur, reported);
    state.costUsd += usd;
    process.stdout.write(
      paint(
        col.gray,
        `— ${label} · ${formatDuration(dur)} · ${state.model}${interrupted ? " · interrupted" : ""}`
      ) + "\n"
    );

    const assistantMsg = {
      role: "assistant",
      content,
      model: state.model,
      // unreported usage is saved as unknown, never as a measured $0
      usage: reported
        ? { input_tokens: inT, output_tokens: outT }
        : { input_tokens: 0, output_tokens: 0, reported: false },
      cost_usd: reported ? Number(usd.toFixed(6)) : null,
      ts: Date.now(),
    };
    state.messages.push(assistantMsg);
    appendToSession(assistantMsg);
    state.abort = null;
  }

  function printCommandHelp() {
    process.stdout.write(bold("commands\n"));
    const w = Math.max(...COMMANDS.map((c) => displayWidthOf(c[0])));
    for (const [cmd, desc] of COMMANDS) {
      process.stdout.write(
        "  " + cyan(cmd.padEnd(w)) + paint(col.gray, "  " + desc) + "\n"
      );
    }
  }

  function displayWidthOf(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, "").length;
  }

  function printSessions() {
    const list = listSessions();
    if (!list.length) {
      note("no sessions yet — conversations are saved automatically");
      return;
    }
    process.stdout.write(bold("sessions\n"));
    const w = Math.max(...list.map((s) => s.name.length), 8);
    for (const s of list) {
      process.stdout.write(
        `  ${cyan(s.name.padEnd(w))}${paint(col.gray, `  ${s.count} msgs · ${formatAge(s.updatedAt)}`)}\n`
      );
    }
  }

  async function handleSlash(input) {
    const [cmdRaw, ...rest] = input.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/help":
      case "/?":
        printCommandHelp();
        break;
      case "/model":
        if (arg) {
          state.model = arg;
          note(`model → ${cyan(arg)}`);
        } else note(`model: ${cyan(state.model)}`);
        break;
      case "/models": {
        const p = resolveProvider(state.provider);
        const ext = extensionForFamily(p.family);
        if (ext && ext.modelsStatus) {
          note(ext.modelsStatus("chat").text);
          break;
        }
        note(`fetching models from ${p.baseUrl}…`);
        try {
          const models = await fetchModels(p);
          if (!models.length) note("no models returned");
          else
            models.forEach((m, i) =>
              note(`${i + 1}. ${m}${m === state.model ? gray(" (current)") : ""}`)
            );
        } catch (err) {
          note(red("could not fetch models: ") + err.message);
        }
        break;
      }
      case "/provider":
        if (arg) {
          state.provider = arg;
          const p = resolveProvider(arg);
          note(`provider → ${cyan(arg)}` + (p.default_model ? ` (default model ${p.default_model})` : ""));
        } else note(`provider: ${cyan(state.provider)}`);
        break;
      case "/temp":
        if (arg) {
          const t = Number(arg);
          if (Number.isNaN(t) || t < 0 || t > 2) note("temperature must be between 0 and 2");
          else {
            state.temp = t;
            note(`temperature → ${t}`);
          }
        } else note(`temperature: ${state.temp}`);
        break;
      case "/system":
        state.system = arg;
        note(arg ? `system prompt set (${arg.length} chars)` : "system prompt cleared");
        break;
      case "/attach":
        if (!arg) note("usage: /attach <file…>");
        else {
          const blocks = readFileContext(arg.split(/\s+/));
          if (blocks.length) {
            state.contextBlocks.push(...blocks);
            note(`attached ${blocks.length} file(s)`);
          }
        }
        break;
      case "/diff": {
        const d = await gitDiff();
        if (d) {
          state.contextBlocks.push(d);
          note("attached git diff");
        } else note("no git diff found (not a repo, or working tree clean)");
        break;
      }
      case "/clip": {
        const c = await readClipboard();
        if (c && c.trim()) {
          state.contextBlocks.push("### Clipboard\n\n```\n" + c.slice(0, 16000) + "\n```");
          note(`attached clipboard (${c.length} chars)`);
        } else note("clipboard empty or unavailable");
        break;
      }
      case "/ctx":
        if (!state.contextBlocks.length) note("no context attached");
        else
          state.contextBlocks.forEach((b, i) =>
            note(`${i + 1}. ${b.split("\n")[0]} (${b.length} chars)`)
          );
        break;
      case "/unattach":
        state.contextBlocks = [];
        note("context removed");
        break;
      case "/clear":
        state.messages = [];
        note("conversation cleared (context kept)");
        break;
      case "/reset":
        state.messages = [];
        state.contextBlocks = [];
        note("everything reset");
        break;
      case "/cost":
        note(
          `session: ${state.totalUsage.input}→${state.totalUsage.output} tokens · ${green(formatCost(state.costUsd))}` +
            (state.unreportedTurns
              ? ` (partial: ${state.unreportedTurns} turn${state.unreportedTurns === 1 ? "" : "s"} had no usage from the provider)`
              : "")
        );
        break;
      case "/tokens": {
        const total = buildPayload().reduce((a, m) => a + estimateTokens(m.content), 0);
        const win = contextWindow(state.model);
        note(`context: ~${total.toLocaleString()} / ${win.toLocaleString()} tokens (${Math.round((total / win) * 100)}%)`);
        break;
      }
      case "/template":
        if (!arg || arg === "list") {
          const names = listTemplates().map((t) => t.name);
          note(names.length ? `templates: ${cyan(names.join(", "))}` : "no templates");
          break;
        }
        {
          const t = resolveTemplate(arg);
          if (!t) note(`no template "${arg}" — see /template list`);
          else {
            if (t.system) state.system = t.system;
            note(
              `template "${cyan(arg)}" applied` +
                (t.system ? " (system prompt set)" : "") +
                (t.prompt ? " (one-shot prompt wrapper)" : "")
            );
          }
          break;
        }
      case "/login": {
        const parts = arg.split(/\s+/);
        const provider = parts[0] || state.provider;
        const token = parts.slice(1).join(" ");
        // login() prompts on stdin — pause the REPL's line reader for it,
        // and always resume even if login() throws so the REPL can't freeze
        rl.pause();
        let code;
        try {
          code = await login({ provider, token, quiet: false });
        } finally {
          try {
            rl.resume();
          } catch {
            /* interface closed */
          }
        }
        if (code === 0 || code === 1) {
          const fresh = readJson(USER_CONFIG_PATH, {});
          state.provider = provider;
          state.model = fresh.model || resolveProvider(provider).default_model || state.model;
          note(`now using ${cyan(provider)} · ${cyan(state.model)}`);
        }
        break;
      }
      case "/logout":
        await logout({ quiet: false });
        break;
      case "/compact": {
        if (state.messages.length < 3) {
          note("nothing to compact yet — need at least 3 messages");
          break;
        }
        const provider = resolveProvider(state.provider);
        note("compacting — summarizing earlier messages…");
        try {
          const cut = state.messages.length - 2;
          const { summary, usage } = await summarizeMessages({
            provider,
            model: state.model,
            messages: state.messages.slice(0, cut),
            temperature: state.temp,
          });
          if (!summary) throw new Error("summary came back empty");
          state.messages = [
            {
              role: "system",
              content: "Summary of the earlier conversation (compacted):\n" + summary,
              ts: Date.now(),
            },
            ...state.messages.slice(cut),
          ];
          if (usageReported(usage)) {
            state.totalUsage.input += usage.input_tokens || 0;
            state.totalUsage.output += usage.output_tokens || 0;
          }
          note(
            green("✓ ") +
              `compacted ${cut} messages into a summary — ${state.messages.length} messages remain`
          );
        } catch (err) {
          note(red("compact failed: ") + err.message);
        }
        break;
      }
      case "/export": {
        if (!state.messages.length) {
          note("nothing to export yet");
          break;
        }
        const name = state.sessionName || "unsaved";
        process.stdout.write(`# Session: ${name}\n\n`);
        for (const m of state.messages) {
          const text = contentText(m.content);
          if (m.role === "user") process.stdout.write(`## you\n\n${text}\n\n`);
          else process.stdout.write(`## volt\n\n${text}\n\n`);
        }
        note(`exported ${state.messages.length} messages as markdown`);
        break;
      }
      case "/save":
        if (!arg) note("usage: /save <name>");
        else {
          saveSession(arg, state.messages, { model: state.model });
          note(`saved "${cyan(arg)}" (${state.messages.length} messages)`);
        }
        break;
      case "/load":
        if (!arg) note("usage: /load <name>");
        else {
          const msgs = loadSession(arg);
          if (!msgs) note(`no session "${arg}"`);
          else {
            state.messages = msgs;
            note(`loaded "${cyan(arg)}" (${msgs.length} messages)`);
          }
        }
        break;
      case "/sessions":
        printSessions();
        break;
      case "/delete":
        if (!arg) note("usage: /delete <name>");
        else note(deleteSession(arg) ? `deleted "${arg}"` : `no session "${arg}"`);
        break;
      case "/paste": {
        const c = await readClipboard();
        if (c && c.trim()) {
          note("pasted clipboard into conversation");
          await sendTurn(c.trim());
        } else note("clipboard empty or unavailable");
        break;
      }
      case "/exit":
      case "/quit":
      case "/q":
        state.closed = true;
        process.stdout.write("\n" + gray("⚡ goodbye\n"));
        rl.close();
        break;
      default:
        note(`unknown command ${cmdRaw} — try /help`);
    }
  }

  async function handleTurn(raw) {
    let input = raw;
    if (state.pending !== null) {
      input = state.pending + "\n" + raw;
      state.pending = null;
    }
    const trimmed = input.trim();
    if (!trimmed) {
      safePrompt();
      return;
    }
    // multi-line continuation: a trailing backslash (stripped) or an open
    // ``` code fence keeps collecting lines (whitespace-tolerant check)
    if (!trimmed.startsWith("/")) {
      const probe = input.replace(/\s+$/, "");
      let cont = false;
      if (/[^\\]\\$/.test(probe) || /^\\$/.test(probe)) {
        input = probe.replace(/\\+$/, "");
        cont = true;
      } else if ((probe.match(/```/g) || []).length % 2 === 1) {
        cont = true;
      }
      if (cont) {
        const firstCont = state.pending === null;
        state.pending = input;
        if (firstCont) note("… multi-line input (closes when the code fence ends)");
        safePrompt();
        return;
      }
    }
    input = trimmed;
    if (input.startsWith("/")) {
      await handleSlash(input);
      if (!state.closed) safePrompt();
      return;
    }
    state.busy = true;
    try {
      await sendTurn(input);
    } catch (err) {
      process.stdout.write("\n" + red("error: ") + err.message + "\n");
    } finally {
      state.busy = false;
      if (!state.closed) safePrompt();
      if (state.closed) rl.close();
    }
  }

  rl.on("SIGINT", () => {
    if (state.abort) {
      state.abort.abort();
      return;
    }
    process.stdout.write("\n" + gray("⚡ goodbye\n"));
    saveHistory(rl.history);
    process.exit(130);
  });

  // print resumed history (last exchange) so the session feels continuous
  if (resumedCount) {
    const start = Math.max(0, state.messages.length - 4);
    note(`resumed session "${cyan(state.sessionName)}" (${state.messages.length} messages)`);
    for (let i = start; i < state.messages.length; i++) {
      const m = state.messages[i];
      const text = contentText(m.content);
      if (m.role === "user") process.stdout.write(cyan("you › ") + text + "\n\n");
      else process.stdout.write(renderMarkdown(text) + "\n\n");
    }
    // nudge to compact long sessions before the context window fills
    const total = state.messages.reduce((a, m) => a + estimateTokens(m.content), 0);
    // estimate against the model the session was actually recorded with
    const lastModel = [...state.messages].reverse().find((m) => m.role === "assistant" && m.model)?.model;
    const win = contextWindow(lastModel || state.model);
    if (total > win * 0.5) {
      note(
        yellow(`session is ~${Math.round((total / win) * 100)}% of the context window — run /compact to summarize older messages`)
      );
    }
  }

  banner();
  rl.prompt();

  for await (const line of rl) {
    if (state.closed) break;
    if (state.busy) {
      state.queue.push(line);
      continue;
    }
    await handleTurn(line);
    while (state.queue.length && !state.closed) {
      const q = state.queue.shift();
      if (q.trim()) await handleTurn(q);
      else safePrompt();
    }
  }

  // EOF with an unfinished continuation: send what we have rather than drop it
  if (state.pending !== null && !state.closed) {
    const last = state.pending;
    state.pending = null;
    state.busy = true;
    try {
      await sendTurn(last);
    } catch (err) {
      process.stdout.write("\n" + red("error: ") + err.message + "\n");
    } finally {
      state.busy = false;
    }
  }

  saveHistory(rl.history);
  process.stdout.write("\n");
  return 0;
}
