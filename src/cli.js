// VOLT — CLI argument parsing and command dispatch.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getConfig,
  resolveProvider,
  saveUserConfig,
  deleteUserConfigKey,
  readJson,
  USER_CONFIG_PATH,
} from "./config.js";
import { VERSION, paint, col, green, red, gray, cyan, bold, formatAge, contentText } from "./util.js";
import { askOnce } from "./ask.js";
import { interactiveChat } from "./chat.js";
import { doctor } from "./doctor.js";
import { fetchModels } from "./providers.js";
import {
  readFileContext,
  gitDiff,
  readClipboard,
  readImageParts,
  buildUserContent,
} from "./context.js";
import { estimateTokens, messageTokens, contextWindow, fitContextWindow } from "./tokens.js";
import { completionsFor } from "./completions.js";
import { readStdin, hasStdinData } from "./util.js";
import {
  listSessions,
  deleteSession,
  loadSession,
  renameSession,
  slugify,
} from "./sessions.js";
import { renderMarkdown } from "./render.js";
import { runAgent } from "./agent.js";
import { runReview } from "./review.js";
import { runSearch } from "./search.js";
import { runCompare } from "./compare.js";
import { runBench } from "./bench.js";
import { runCostReport } from "./cost-report.js";
import { loadHistory } from "./history.js";
import { login, logout } from "./login.js";
import { extensionFor, extensionForFamily, extensionHelp } from "./local-providers.js";
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  syncClaudeCommands,
} from "./claude-install.js";
import { summarizeMessages } from "./summarize.js";
import { runStats } from "./stats.js";
import { checkUpgrade } from "./upgrade.js";
import {
  listTemplates,
  resolveTemplate,
  saveTemplate,
  deleteTemplate,
  applyTemplate,
} from "./templates.js";

const FLAGS = {
  help: ["-h", "--help"],
  version: ["-v", "--version"],
  model: ["-m", "--model"],
  provider: ["-p", "--provider"],
  temp: ["-t", "--temp", "--temperature"],
  "max-tokens": ["--max-tokens"],
  system: ["-s", "--system"],
  context: ["-c", "--context"],
  diff: ["--diff"],
  clip: ["--clip"],
  name: ["-n", "--name"],
  resume: ["--resume"],
  new: ["--new"],
  raw: ["-r", "--raw"],
  json: ["-j", "--json"],
  "no-stream": ["--no-stream"],
  quiet: ["-q", "--quiet"],
  sessions: ["--sessions"],
  template: ["--template"],
  steps: ["--steps"],
  "command-timeout": ["--command-timeout"],
  gate: ["--gate"],
  check: ["--check"],
  models: ["--models"],
  providers: ["--providers"],
  image: ["-i", "--image"],
  continue: ["--continue"],
};

const VALUE_FLAGS = new Set([
  "model",
  "provider",
  "temp",
  "max-tokens",
  "system",
  "context",
  "name",
  "template",
  "steps",
  "command-timeout",
  "models",
  "providers",
  "image",
]);

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { context: [], flags: new Set() };
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a.length > 1) {
      let name = a;
      let inline = null;
      const eq = a.indexOf("=");
      if (eq !== -1) {
        name = a.slice(0, eq);
        inline = a.slice(eq + 1);
      }
      let flag = null;
      for (const [key, aliases] of Object.entries(FLAGS)) {
        if (aliases.includes(name)) {
          flag = key;
          break;
        }
      }
      if (!flag) throw new UsageError(`unknown flag: ${name}`);
      if (VALUE_FLAGS.has(flag)) {
        let val = inline;
        if (val === null) {
          val = argv[++i];
          if (val === undefined) throw new UsageError(`flag ${name} requires a value`);
        }
        if (flag === "context") {
          opts.context.push(
            ...val.split(",").map((s) => s.trim()).filter(Boolean)
          );
        } else if (flag === "models" || flag === "providers") {
          // --models a,b (or repeated -m) both feed opts.models
          const key = flag === "models" ? "models" : "providers";
          opts[key] = [...(opts[key] || []), ...val.split(",").map((s) => s.trim()).filter(Boolean)];
        } else {
          opts[flag] = val;
          if (flag === "model") opts.models = [...(opts.models || []), val];
          if (flag === "provider") opts.providers = [...(opts.providers || []), val];
          if (flag === "image") opts.images = [...(opts.images || []), val];
        }
      } else {
        if (inline !== null) throw new UsageError(`flag ${name} does not take a value`);
        opts.flags.add(flag);
      }
    } else {
      positionals.push(a);
    }
    i++;
  }
  return { opts, positionals };
}

function printHelp() {
  process.stdout.write(
    `
${paint(col.bold + col.purple, "⚡ VOLT")} ${gray("v" + VERSION)} — a terminal AI copilot.

${bold("usage")}
  volt                        start an interactive session
  volt "question"             one-shot ask
  volt ask "question"         one-shot ask (explicit)
  echo "..." | volt           ask with piped input
  volt -c file.ts "explain"   attach a file as context
  volt --diff "review"        attach the git diff
  volt chat <session>         chat, resuming a saved session
  volt login anthropic        save your Claude key & verify it
${extensionHelp("usage")}  volt install claude         merge VOLT's features into Claude Code

${bold("flags")}
  -m, --model <name>      model to use            -p, --provider <name>  provider preset
  -t, --temp <0–2>        sampling temperature    -s, --system <text>    system prompt
  -c, --context <files>   comma-separated files   --diff                 attach git diff
  --clip                  attach clipboard        -n, --name <name>      session name
  --resume                resume latest session   --new                  fresh session
  -r, --raw               plain output            -j, --json             JSON output
  --no-stream             non-streaming           -q, --quiet            no footer stats
  --template <name>       apply a prompt template  --steps <n>            agent: max steps
  --gate                  review: exit 1 on critical findings
  --sessions              list sessions           -h, --help             this help
  -v, --version           print version

${bold("commands")}
  ask        one-shot question      doctor    diagnose setup & connectivity
  chat       interactive session    models    list provider models
  agent      autonomous agent loop  review    structured code review
  search     search your sessions   template  manage prompt templates
  compare    answer across models    bench     latency benchmark
  config     view / set config      sessions  manage saved sessions
  login      save a provider key    logout    remove the saved key
  summarize  summarize a session    cost      aggregate spend
  stats      usage dashboard        upgrade   check for a newer version
  install    merge VOLT into Claude Code  uninstall  undo that merge

${bold("examples")}

  volt agent "add error handling to src/ and run the tests"
  volt review --gate          # review git diff; fail on critical findings
  volt review src/a.js src/b.js
  volt search "retry logic"   # find past conversations
  volt --diff --template commit "my changes"
  volt compare -m gpt-4o-mini -m gpt-4o "which is better?"
  volt bench
  volt template save pr "Summarize this PR. {prompt}"
  volt login anthropic       # sign in with your Claude API key
${extensionHelp("examples")}  volt login openai sk-...   # or any provider, one-shot

${bold("providers")}
  openai · anthropic · ollama · groq · openrouter · deepseek · mistral ·
  together · lmstudio · cerebras · openai_compatible (custom base URL)
${extensionHelp("providers")}
${bold("environment")}
  VOLT_PROVIDER    provider preset        VOLT_MODEL       model name
  VOLT_API_KEY     OpenAI-compatible key  VOLT_ANTHROPIC_API_KEY  Anthropic key
  ANTHROPIC_API_KEY  Anthropic key (used when VOLT_ANTHROPIC_API_KEY is unset)
  VOLT_BASE_URL    custom API base URL    VOLT_TEMPERATURE sampling temperature

${gray("Interactive: /help /model /temp /provider /system /template /attach /diff /clip /ctx /clear /reset /cost /tokens /save /load /sessions /exit")}
`
  );
  return 0;
}

function setNestedPath(obj, dottedKey, value) {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function coerce(raw) {
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return raw;
}

function runConfig(args, opts) {
  const [sub, key, ...vals] = args;
  if (opts.flags.has("json") && !sub) {
    // sanitized effective config — never includes the API key itself
    const c = getConfig();
    process.stdout.write(
      JSON.stringify({
        provider: c.providerName,
        model: c.model,
        baseUrl: c.baseUrl,
        temperature: c.temperature,
        maxTokens: c.maxTokens,
        stream: c.stream,
        systemPrompt: c.systemPrompt,
        hasApiKey: Boolean(c.apiKey),
      }) + "\n"
    );
    return 0;
  }
  if (sub === "path") {
    console.log(USER_CONFIG_PATH);
    return 0;
  }
  if (sub === "set" && key) {
    const value = coerce(vals.join(" "));
    const current = readJson(USER_CONFIG_PATH, {});
    saveUserConfig(setNestedPath(current, key, value));
    console.log(green("✓ ") + `${key} = ${JSON.stringify(value)}  →  ${USER_CONFIG_PATH}`);
    return 0;
  }
  if (sub === "get" && key) {
    const cfg = readJson(USER_CONFIG_PATH, {});
    const val = key.split(".").reduce((o, k) => (o == null ? o : o[k]), cfg);
    console.log(val === undefined ? gray("(unset)") : typeof val === "string" ? val : JSON.stringify(val));
    return 0;
  }
  if (sub === "unset" && key) {
    console.log(
      deleteUserConfigKey(key)
        ? green("✓ ") + `unset ${key}`
        : gray(`${key} is not set in the user config`)
    );
    return 0;
  }
  const cfg = getConfig();
  console.log(`${bold("provider")}:        ${cfg.providerName}`);
  console.log(`${bold("model")}:           ${cfg.model}`);
  console.log(`${bold("base url")}:        ${cfg.baseUrl}`);
  console.log(`${bold("auth")}:            ${authStatus(cfg)}`);
  console.log(`${bold("temperature")}:     ${cfg.temperature}`);
  console.log(`${bold("max tokens")}:      ${cfg.maxTokens}`);
  console.log(`${bold("stream")}:          ${cfg.stream}`);
  console.log(`${bold("system prompt")}:   ${cfg.systemPrompt ? JSON.stringify(cfg.systemPrompt.slice(0, 80)) : "(none)"}`);
  console.log(gray(`config file: ${USER_CONFIG_PATH} (${existsSync(USER_CONFIG_PATH) ? "exists" : "defaults in use"})`));
  return 0;
}

// One-line auth status for `volt config` (never prints the key itself).
function authStatus(cfg) {
  const ext = extensionForFamily(cfg.provider.family);
  if (ext && ext.authStatus) return ext.authStatus;
  if (cfg.apiKey) return "api key set";
  if (cfg.provider.family === "anthropic") {
    return "MISSING: no Anthropic API key (set ANTHROPIC_API_KEY or run `volt login anthropic`)";
  }
  if (/localhost|127\.0\.0\.1/.test(cfg.baseUrl || "")) return "no api key (local server)";
  return "MISSING: no api key set (run `volt login <provider>`)";
}

async function runModels(config, opts) {
  const provider = resolveProvider(opts.provider || config.providerName);
  // A local provider extension with no HTTP model list reports its own status.
  const ext = extensionForFamily(provider.family);
  if (ext && ext.modelsStatus) {
    const st = ext.modelsStatus("cli");
    console.log(st.ok ? st.text : gray(st.text));
    return 0;
  }
  if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl || "")) {
    console.error(gray(`note: no api key for "${provider.name}" — models may fail`));
  }
  const models = await fetchModels(provider);
  if (!models.length) {
    console.error(gray(`no models returned by ${provider.baseUrl}`));
  }
  for (const m of models) {
    console.log(m === config.model ? `${m} ${green("(default)")}` : m);
  }
  return 0;
}

async function runSessions(config, opts, args) {
  const [sub, name] = args;
  if (sub === "resume" || sub === "load") {
    return interactiveChat({ config, opts: { ...opts, sessionName: name, resume: true } });
  }
  if (sub === "delete") {
    if (!name) {
      console.error(red("usage: volt sessions delete <name>"));
      return 2;
    }
    console.log(deleteSession(name) ? green("✓ ") + `deleted "${name}"` : red("✘ ") + `no session "${name}"`);
    return 0;
  }
  if (sub === "rename") {
    const [newName] = args.slice(2);
    if (!name || !newName) {
      console.error(red("usage: volt sessions rename <old> <new>"));
      return 2;
    }
    if (slugify(name) === slugify(newName)) {
      console.error(red(`"${name}" and "${newName}" are the same session`));
      return 1;
    }
    const r = renameSession(name, newName);
    if (r === null) {
      console.error(red(`a session named "${newName}" already exists`));
      return 1;
    }
    console.log(
      r ? green("✓ ") + `renamed "${name}" → "${newName}"` : red("✘ ") + `no session "${name}"`
    );
    return r ? 0 : 1;
  }
  if (sub === "show") {
    const msgs = loadSession(name);
    if (!msgs) {
      console.error(red(`no session "${name}"`));
      return 1;
    }
    for (const m of msgs) {
      const text = contentText(m.content);
      if (m.role === "user") console.log(cyan("you › ") + text + "\n");
      else console.log(renderMarkdown(text) + "\n");
    }
    return 0;
  }
  if (sub === "export") {
    const msgs = loadSession(name);
    if (!msgs) {
      console.error(red(`no session "${name}"`));
      return 1;
    }
    console.log(`# Session: ${name}\n`);
    for (const m of msgs) {
      const text = contentText(m.content);
      if (m.role === "user") console.log(`## you\n\n${text}\n`);
      else console.log(`## volt\n\n${text}\n`);
    }
    return 0;
  }
  const list = listSessions();
  if (!list.length) {
    console.log(gray("no sessions yet — run `volt chat` to start one"));
    return 0;
  }
  if (opts.flags.has("json")) {
    process.stdout.write(JSON.stringify(list) + "\n");
    return 0;
  }
  console.log(bold("sessions"));
  const w = Math.max(...list.map((s) => s.name.length), 8);
  for (const s of list) {
    console.log(
      `  ${s.name.padEnd(w)}  ${gray(`${s.count} msgs · ${formatAge(s.updatedAt)}`)}`
    );
  }
  return 0;
}

// Collect file / git-diff / clipboard / stdin context shared by ask, agent, review.
async function collectContext(opts) {
  const blocks = [];
  if (opts.context?.length) blocks.push(...readFileContext(opts.context));
  if (opts.flags.has("diff")) {
    const d = await gitDiff();
    if (d) blocks.push(d);
    else console.error(gray("note: no git diff found"));
  }
  if (opts.flags.has("clip")) {
    const c = await readClipboard();
    if (c && c.trim()) blocks.push("### Clipboard\n\n```\n" + c.slice(0, 16000) + "\n```");
    else console.error(gray("note: clipboard empty or unavailable"));
  }
  return blocks;
}

// Apply --template to the prompt/system, if any. Returns an error code or null.
function applyTemplateOpts(opts, prompt) {
  if (!opts.template) return { prompt, code: null };
  const t = resolveTemplate(opts.template);
  if (!t) {
    console.error(red(`error: no template "${opts.template}" — see \`volt template list\``));
    return { prompt, code: 2 };
  }
  const applied = applyTemplate(t, prompt);
  if (opts.system === undefined && applied.system) opts.system = applied.system;
  return { prompt: applied.prompt, code: null };
}

// Shared prompt resolution for ask / agent / compare: positionals + stdin +
// context blocks + template. Returns { prompt, blocks } or an error code.
async function resolveInput(opts, positionals, contextFallback) {
  let prompt = positionals.join(" ");
  const blocks = await collectContext(opts);
  let stdin = "";
  if (hasStdinData()) stdin = (await readStdin()).trimEnd();
  if (!prompt && stdin) prompt = stdin;
  else if (stdin) blocks.push("### Stdin\n\n```\n" + stdin + "\n```");
  const tpl = applyTemplateOpts(opts, prompt);
  if (tpl.code) return { code: tpl.code };
  prompt = tpl.prompt;
  const images = opts.images?.length ? readImageParts(opts.images) : [];
  if (!prompt && blocks.length) prompt = contextFallback;
  // an image counts as input: image-only asks get a sensible default prompt
  if (!prompt && images.length && !blocks.length) prompt = "Describe this image.";
  if (!prompt && !blocks.length && !images.length) return { missing: true };
  return { prompt, blocks, images };
}

async function runAsk(config, opts, positionals) {
  const input = await resolveInput(opts, positionals, "Respond to the attached context.");
  if (input.code) return input.code;
  if (input.missing) {
    console.error(red("error: no prompt — usage: volt ask \"question\" (or pipe input)"));
    return 2;
  }
  // --continue: follow up on an existing session in one shot
  let history = null;
  if (opts.flags.has("continue")) {
    const list = listSessions();
    const target = opts.name
      ? (loadSession(opts.name) ? opts.name : null)
      : list[0]?.name || null;
    if (!target) {
      console.error(gray("note: no session to continue — starting fresh"));
    } else {
      history = loadSession(target);
      console.error(gray(`continuing session "${target}" (${history.length} messages)`));
    }
  }
  return askOnce({
    config,
    opts,
    prompt: input.prompt,
    contextBlocks: input.blocks,
    images: input.images,
    history,
  });
}

async function runChat(config, opts, positionals) {
  // Note: piped stdin is left for the REPL itself (each line becomes input),
  // so context comes from -c / --diff / --clip / slash commands.
  const blocks = await collectContext(opts);
  if (opts.template) {
    const t = resolveTemplate(opts.template);
    if (!t) {
      console.error(red(`error: no template "${opts.template}"`));
      return 2;
    }
    if (opts.system === undefined && t.system) opts.system = t.system;
  }
  return interactiveChat({
    config,
    opts: {
      ...opts,
      contextBlocks: blocks,
      sessionName: opts.name || positionals[0] || null,
    },
  });
}

async function runAgentCmd(config, opts, positionals) {
  const input = await resolveInput(opts, positionals, "Complete the task using the attached context.");
  if (input.code) return input.code;
  if (input.missing) {
    console.error(red("error: no task — usage: volt agent \"task description\" (or pipe input)"));
    return 2;
  }
  if (input.images?.length) {
    console.error(gray("note: agent mode is text-only — image(s) ignored"));
  }
  return runAgent({ config, opts, prompt: input.prompt, contextBlocks: input.blocks });
}

async function runCompareCmd(config, opts, positionals) {
  const input = await resolveInput(opts, positionals, "Answer using the attached context.");
  if (input.code) return input.code;
  if (input.missing) {
    console.error(red("error: no question — usage: volt compare \"question\" (use -m a -m b to pick models)"));
    return 2;
  }
  return runCompare({ config, opts, prompt: input.prompt, contextBlocks: input.blocks, images: input.images });
}

function runBenchCmd(config, opts) {
  return runBench({ config, opts });
}

async function runContextCmd(config, opts, positionals) {
  // `volt context` — dry run: show exactly what would be sent, and its token
  // budget, without calling the API.
  const input = await resolveInput(opts, positionals, "Respond to the attached context.");
  if (input.code) return input.code;
  if (input.missing) {
    console.error(red("usage: volt context [question] (-c / --diff / -i to attach)"));
    return 2;
  }
  const json = opts.flags.has("json");
  const model = opts.model || config.model || "unknown";
  const system = opts.system !== undefined ? opts.system : config.systemPrompt;
  const win = contextWindow(model);
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  if (input.blocks.length) {
    messages.push({
      role: "system",
      content: "Context attached by the user from the terminal:\n\n" + input.blocks.join("\n\n"),
    });
  }
  messages.push({ role: "user", content: buildUserContent(input.prompt, [], input.images) });

  const total = messages.reduce((a, m) => a + messageTokens(m), 0);
  const fitted = fitContextWindow(messages, model);
  const afterTrim = fitted.reduce((a, m) => a + messageTokens(m), 0);
  const trimmed = afterTrim < total;

  if (!json) {
    console.log(paint(col.bold + col.purple, "⚡ context ") + gray(`${model} · ${win.toLocaleString()} token window`));
    for (const m of messages) {
      if (m.role === "system" && m.content.startsWith("Context attached")) continue; // blocks listed below
      const preview = contentText(m.content).split("\n")[0].slice(0, 80);
      console.log(`  ${cyan(m.role.padEnd(9))} ${messageTokens(m).toLocaleString().padStart(6)} tok  ${gray(preview)}`);
    }
    for (const b of input.blocks) {
      console.log(`  ${gray("· block")}  ${estimateTokens(b).toLocaleString().padStart(6)} tok  ${gray(b.split("\n")[0].slice(0, 80))}`);
    }
    for (const img of input.images) {
      console.log(`  ${gray("· image")}  ${String(1000).padStart(6)} tok  ${gray(img.path)}`);
    }
    console.log(
      `  ${bold("total")}  ${total.toLocaleString().padStart(6)} tok · ${Math.round((total / win) * 100)}% of window` +
        (trimmed ? paint(col.yellow, ` · would trim ${(total - afterTrim).toLocaleString()} tok`) : "")
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        model,
        window: win,
        totalTokens: total,
        afterTrimTokens: afterTrim,
        trimmed,
        messages: messages.map((m) => ({
          role: m.role,
          tokens: messageTokens(m),
          preview: contentText(m.content).split("\n")[0].slice(0, 80),
        })),
      }) + "\n"
    );
  }
  return 0;
}

async function runTokensCmd(positionals) {
  let text = positionals.join(" ");
  if (!text && hasStdinData()) text = (await readStdin()).trimEnd();
  if (!text) {
    console.error(red("usage: volt tokens <text> (or pipe input)"));
    return 2;
  }
  console.log(`${estimateTokens(text)} tokens · ${text.length} chars`);
  return 0;
}

function runCompletionsCmd(args) {
  const shell = args[0];
  if (!shell) {
    process.stdout.write(completionsFor(null));
    return 0;
  }
  const script = completionsFor(shell);
  if (!script) {
    console.error(red(`unsupported shell "${shell}" — try bash, zsh or fish`));
    return 1;
  }
  process.stdout.write(script);
  return 0;
}

async function runSummarizeCmd(config, opts, positionals) {
  const name = positionals[0];
  const msgs = name ? loadSession(name) : null;
  if (!msgs) {
    console.error(red(`no session "${name || ""}" — usage: volt summarize <session>`));
    return 2;
  }
  const provider = resolveProvider(opts.provider || config.providerName);
  const model = opts.model || config.model;
  const json = opts.flags.has("json");
  const { summary, usage } = await summarizeMessages({
    provider,
    model,
    messages: msgs,
    temperature: opts.temp,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ session: name, model, summary, usage }) + "\n");
    return 0;
  }
  console.log(bold(`summary of "${name}"`) + gray(` (${msgs.length} messages)`));
  console.log(summary + "\n");
  if (usage)
    console.log(
      gray(
        usage.reported === false
          ? `— usage not reported by provider · ${model}`
          : `— ${usage.input_tokens}→${usage.output_tokens} tok · ${model}`
      )
    );
  return 0;
}

function runHistoryCmd(opts, args) {
  const json = opts.flags.has("json");
  const parsed = Number(args[0]);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  const h = loadHistory();
  if (json) {
    process.stdout.write(JSON.stringify({ entries: h.slice(-limit) }) + "\n");
    return 0;
  }
  if (!h.length) {
    console.log(gray("no history yet — prompts are recorded after each answer"));
    return 0;
  }
  console.log(bold("history"));
  const start = Math.max(0, h.length - limit);
  for (let i = h.length - 1; i >= start; i--) {
    console.log(`  ${gray(String(h.length - i).padStart(3))}  ${h[i]}`);
  }
  return 0;
}

async function runLoginCmd(args, opts) {
  // volt login [provider] [api-key] — provider defaults to anthropic
  const provider = args[0] || "anthropic";
  const token = args.slice(1).join(" ");
  return login({ provider, token, quiet: opts.flags.has("quiet") });
}

function runInitCmd(config) {
  const p = path.join(process.cwd(), ".volt.json");
  if (existsSync(p)) {
    console.error(red(`${p} already exists`));
    return 1;
  }
  const content = {
    provider: config.providerName,
    model: config.model,
    temperature: config.temperature,
    ...(config.systemPrompt ? { system_prompt: config.systemPrompt } : {}),
  };
  writeFileSync(p, JSON.stringify(content, null, 2) + "\n");
  console.log(green("✓ ") + `wrote ${p}`);
  console.log(gray("  project config overrides defaults — edit it or use `volt config`"));
  return 0;
}

async function runReviewCmd(config, opts, positionals) {
  const tpl = applyTemplateOpts(opts, "");
  if (tpl.code) return tpl.code;
  return runReview({ config, opts, files: positionals });
}

function runSearchCmd(opts, positionals) {
  const query = positionals.join(" ");
  if (!query) {
    console.error(red("usage: volt search <query>"));
    return 2;
  }
  return runSearch(query, { json: opts.flags.has("json") });
}

function runTemplateCmd(args, opts) {
  const [sub, name, ...rest] = args;
  if (!sub || sub === "list") {
    const list = listTemplates();
    if (!list.length) {
      console.log(gray("no templates — run `volt template save <name> \"prompt\"` to add one"));
      return 0;
    }
    console.log(bold("templates"));
    const w = Math.max(...list.map((t) => t.name.length), 8);
    for (const t of list) {
      console.log(
        `  ${cyan(t.name.padEnd(w))}  ${gray(
          (t.builtin ? "builtin" : "user") +
            (t.system ? " · system" : "") +
            (t.prompt ? " · prompt" : "")
        )}`
      );
    }
    return 0;
  }
  if (sub === "show") {
    const t = resolveTemplate(name);
    if (!t) {
      console.error(red(`no template "${name}"`));
      return 1;
    }
    console.log(bold(`${t.name} ${gray(t.builtin ? "(builtin)" : "(user)")}`));
    if (t.system) console.log(`${bold("system:")} ${t.system}`);
    if (t.prompt) console.log(`${bold("prompt:")} ${t.prompt}`);
    return 0;
  }
  if (sub === "save") {
    if (!name) {
      console.error(red("usage: volt template save <name> [prompt text]"));
      return 2;
    }
    const prompt = rest.join(" ");
    const system = opts.system;
    if (!prompt && !system) {
      console.error(red("nothing to save — give a prompt text and/or --system \"…\""));
      return 2;
    }
    saveTemplate(name, {
      ...(prompt ? { prompt } : {}),
      ...(system ? { system } : {}),
    });
    console.log(green("✓ ") + `template "${name}" saved`);
    // if VOLT is merged into Claude Code, expose the new template there too
    if (syncClaudeCommands()) {
      console.log(gray(`  → Claude Code: /volt-${slugify(name)} ready (restart claude or reload to use it)`));
    }
    return 0;
  }
  if (sub === "rm" || sub === "delete") {
    if (!name) {
      console.error(red("usage: volt template rm <name>"));
      return 2;
    }
    const removed = deleteTemplate(name);
    console.log(
      removed
        ? green("✓ ") + `template "${name}" deleted`
        : red("✘ ") + `no user template "${name}" (builtins can't be deleted)`
    );
    if (removed && syncClaudeCommands()) {
      console.log(gray("  → Claude Code commands refreshed"));
    }
    return 0;
  }
  console.error(red(`unknown template subcommand "${sub}" — try list, show, save, rm`));
  return 2;
}

// Commands where the auto-detect hint is worth showing (interactions, not
// pure-info commands like config/sessions/history).
const HINT_COMMANDS = new Set([
  "ask",
  "chat",
  "agent",
  "a",
  "review",
  "compare",
  "summarize",
  "context",
  "ctx",
  "models",
  "doctor",
]);

const COMMANDS = new Set([
  "ask",
  "chat",
  "doctor",
  "models",
  "config",
  "sessions",
  "agent",
  "a",
  "review",
  "search",
  "template",
  "compare",
  "bench",
  "context",
  "ctx",
  "tokens",
  "completions",
  "init",
  "login",
  "logout",
  "install",
  "uninstall",
  "summarize",
  "cost",
  "stats",
  "upgrade",
  "history",
  "help",
  "version",
]);

export async function main(argv) {
  let opts, positionals;
  try {
    ({ opts, positionals } = parseArgs(argv));
  } catch (err) {
    console.error(red("error: ") + err.message);
    console.error(`  run ${bold("volt --help")} for usage`);
    return 2;
  }

  const flags = opts.flags;
  if (flags.has("help")) return printHelp();
  if (flags.has("version")) {
    console.log(`volt ${VERSION}`);
    return 0;
  }
  if (flags.has("sessions")) {
    return runSessions(getConfig(), opts, []);
  }

  const cmd = COMMANDS.has(positionals[0])
    ? positionals.shift()
    : positionals.length
      ? "ask"
      : hasStdinData()
        ? "ask"
        : "chat";
  if (cmd === "help") return printHelp();
  if (cmd === "version") {
    console.log(`volt ${VERSION}`);
    return 0;
  }

  const config = getConfig();
  const autoExt = config.autoProvider ? extensionFor(config.autoProvider) : null;
  if (autoExt && HINT_COMMANDS.has(cmd)) {
    console.error(
      gray(autoExt.autoSelectHint || `⚡ no provider configured — using ${autoExt.name}.`) +
        gray("  Set one anytime with `volt config set provider <name>`")
    );
  }
  try {
    switch (cmd) {
      case "ask":
        return await runAsk(config, opts, positionals);
      case "chat":
        return await runChat(config, opts, positionals);
      case "doctor":
        return await doctor();
      case "models":
        return await runModels(config, opts);
      case "config":
        return runConfig(positionals, opts);
      case "sessions":
        return await runSessions(config, opts, positionals);
      case "agent":
      case "a":
        return await runAgentCmd(config, opts, positionals);
      case "review":
        return await runReviewCmd(config, opts, positionals);
      case "search":
        return runSearchCmd(opts, positionals);
      case "template":
        return runTemplateCmd(positionals, opts);
      case "compare":
        return await runCompareCmd(config, opts, positionals);
      case "bench":
        return runBenchCmd(config, opts);
      case "context":
      case "ctx":
        return await runContextCmd(config, opts, positionals);
      case "tokens":
        return await runTokensCmd(positionals);
      case "completions":
        return runCompletionsCmd(positionals);
      case "init":
        return runInitCmd(config);
      case "login":
        return await runLoginCmd(positionals, opts);
      case "logout":
        return logout({ quiet: flags.has("quiet") });
      case "install": {
        if (positionals[0] !== "claude") {
          console.error(red("usage: volt install claude — merge VOLT's features into Claude Code"));
          return 2;
        }
        return installClaudeIntegration({ quiet: flags.has("quiet") });
      }
      case "uninstall": {
        if (positionals[0] !== "claude") {
          console.error(red("usage: volt uninstall claude — remove VOLT from Claude Code"));
          return 2;
        }
        return uninstallClaudeIntegration({ quiet: flags.has("quiet") });
      }
      case "summarize":
        return await runSummarizeCmd(config, opts, positionals);
      case "stats":
        return runStats({ json: flags.has("json") });
      case "upgrade":
        return checkUpgrade({ quiet: flags.has("quiet") });
      case "cost":
        return runCostReport({ json: flags.has("json") });
      case "history":
        return runHistoryCmd(opts, positionals);
      default:
        return printHelp();
    }
  } catch (err) {
    const msg = err?.status ? err.message : err?.message || String(err);
    console.error(red("error: ") + msg);
    return err?.status === 401 ? 1 : 1;
  }
}
