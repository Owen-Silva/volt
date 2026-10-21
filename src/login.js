// VOLT — `volt login` / `volt logout`: store a provider API key, set the
// provider, and verify the key with a live call.
import * as readline from "node:readline";
import { chmodSync } from "node:fs";
import {
  saveUserConfig,
  deleteUserConfigKey,
  resolveProvider,
  readJson,
  USER_CONFIG_PATH,
} from "./config.js";
import { fetchModels, ApiError } from "./providers.js";
import { extensionFor } from "./local-providers.js";
import { bold, cyan, gray, green, red, yellow } from "./util.js";

// Where to create a key for each provider. null = runs locally, no key needed.
const KEY_URLS = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/settings/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  mistral: "https://console.mistral.ai/api-keys",
  together: "https://api.together.ai/settings/api-keys",
  cerebras: "https://cloud.cerebras.ai/setup/api-keys",
  lmstudio: null,
  ollama: null,
  openai_compatible: null,
};

// Preferred models per provider, tried in order against the verified model
// list. The provider's curated default (if present) always wins first.
const MODEL_PRIORITY = {
  anthropic: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  openai: ["gpt-4.1", "gpt-4o", "gpt-4o-mini"],
  groq: ["llama-3.3-70b-versatile"],
  openrouter: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"],
  deepseek: ["deepseek-chat"],
  mistral: ["mistral-small-latest", "mistral-large-latest"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  cerebras: ["llama-3.3-70b"],
};

// Pick a sensible default model from the models a provider actually serves.
function pickDefaultModel(provider, models) {
  if (!Array.isArray(models) || !models.length) return null;
  const tried = [
    ...(provider.default_model && models.includes(provider.default_model)
      ? [provider.default_model]
      : []),
    ...(MODEL_PRIORITY[provider.name] || MODEL_PRIORITY[provider.family] || []),
  ];
  for (const m of tried) if (models.includes(m)) return m;
  // Anthropic renames models often — fall back on a name fragment.
  if (provider.family === "anthropic") {
    for (const frag of ["opus", "sonnet", "haiku"]) {
      const hit = models.find((m) => m.includes(frag));
      if (hit) return hit;
    }
  }
  return models[0];
}

// Claude Code subscription tokens — produced when you log into `claude code`
// with a Claude.ai Pro/Max account — start with these prefixes. Anthropic binds
// them to Claude Code's own OAuth client and rejects them from third-party
// tools (the Messages API expects `x-api-key: sk-ant-api…` instead). Detect
// them so we can say so plainly instead of chasing a confusing 401.
export function isClaudeCodeToken(token) {
  return /^sk-ant-(oat01|session)-/i.test(String(token || "").trim());
}

const NAMES = {
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  groq: "Groq",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  together: "Together AI",
  cerebras: "Cerebras",
  lmstudio: "LM Studio (local)",
  ollama: "Ollama (local)",
  openai_compatible: "Custom (OpenAI-compatible)",
};

// Ask for a secret on the terminal, masking every typed character.
// (Backspace redraw is imperfect under masking — fine for a paste flow.)
function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (s === "\n") orig("\n");
      else if (s && s.length) orig("*");
    };
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
    // Ctrl+D / closed stdin: don't hang — resolve empty so the caller bails.
    rl.on("close", () => resolve(""));
  });
}

export async function login({ provider = "anthropic", token = "", quiet = false }) {
  const ext = extensionFor(provider);
  if (ext && ext.login) return ext.login({ quiet, saveUserConfig, deleteUserConfigKey });
  if (!(provider in KEY_URLS)) {
    console.error(
      red(`unknown provider "${provider}" — known: ${Object.keys(KEY_URLS).join(", ")}`)
    );
    return 2;
  }
  if (KEY_URLS[provider] === null && provider !== "openai_compatible") {
    console.error(
      red(`"${provider}" runs locally — no API key needed. Just run \`volt\` and go.`)
    );
    return 2;
  }

  const url = KEY_URLS[provider];
  if (!token && process.stdin.isTTY) {
    process.stdout.write(`\n${bold(NAMES[provider] || provider)} — sign in\n\n`);
    if (url) {
      process.stdout.write(`  1) Create a key here:  ${cyan(url)}\n`);
      process.stdout.write(
        gray(
          `     (pick any name; the key starts with ${provider === "anthropic" ? "sk-ant-api…" : "sk-"}…)\n`
        )
      );
    } else {
      process.stdout.write(gray("  1) This provider uses a custom base URL — set VOLT_BASE_URL first.\n"));
    }
    token = await promptHidden(`  2) Paste the key: `);
  }

  token = String(token || "").trim().replace(/^['"]|['"]$/g, "");
  if (!token) {
    if (!process.stdin.isTTY) {
      console.error(red(`no key given — usage: volt login [provider] [api-key]`));
    } else {
      console.error(red("no key entered — nothing saved"));
    }
    return 2;
  }

  if (provider === "anthropic" && isClaudeCodeToken(token)) {
    console.error(
      red(`✗ that looks like a Claude Code subscription token, not an API key`) +
        `\n  Claude Code OAuth tokens (sk-ant-oat01-… / sk-ant-session-…) are bound to Claude` +
        `\n  Code itself and blocked for third-party tools, so VOLT can't use one — nothing saved.` +
        `\n  To use Claude here, create a regular API key (starts with sk-ant-api…):` +
        `\n    ${cyan(url)}` +
        `\n  (a free account + pay-as-you-go billing at console.anthropic.com is all it takes)`
    );
    return 1;
  }

  saveUserConfig({ provider, api_key: token });
  // On POSIX, keep the key readable only by the owner.
  try {
    if (process.platform !== "win32") chmodSync(USER_CONFIG_PATH, 0o600);
  } catch {
    /* best effort */
  }

  if (!quiet) {
    console.log(
      green("✓ ") + `saved key for ${bold(NAMES[provider] || provider)} → ${USER_CONFIG_PATH}`
    );
  }

  // Verify the key actually works before claiming success. Use the key we
  // just saved explicitly (env vars would shadow it), with a hard timeout so
  // a stalled network can't hang the command.
  const p = { ...resolveProvider(provider), apiKey: token };
  let timer;
  try {
    const models = await Promise.race([
      fetchModels(p),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new ApiError(0, "verification timed out after 10s")),
          10000
        );
      }),
    ]);
    clearTimeout(timer);
    const picked = pickDefaultModel(p, models);
    if (!quiet) {
      const n = models.length;
      console.log(
        green("✓ ") +
          `connected — ${n} model${n === 1 ? "" : "s"} available` +
          (models.length ? gray(` (${models.slice(0, 3).join(", ")}…)`) : "")
      );
      if (picked) process.stdout.write(gray(`  best model: ${cyan(picked)}\n`));
    }
    // Adopt a smart default model unless the user already configured one.
    if (picked && !readJson(USER_CONFIG_PATH, {}).model && !process.env.VOLT_MODEL) {
      saveUserConfig({ model: picked });
      if (!quiet) {
        process.stdout.write(
          green("✓ ") +
            `default model set to ${cyan(picked)} — change with \`volt config set model <name>\`\n`
        );
      }
    }
    return 0;
  } catch (err) {
    clearTimeout(timer);
    if (!quiet) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        console.error(
          yellow(`⚠ key saved, but ${NAMES[provider] || provider} rejected it (${err.status})`) +
            `\n  double-check the key at ${url || "your provider console"}`
        );
      } else {
        console.error(
          yellow(`⚠ key saved, but verification failed: ${err.message}`) +
            gray(`\n  (you can retry with \`volt login ${provider} <key>\`)`)
        );
      }
    }
    return err instanceof ApiError && (err.status === 401 || err.status === 403) ? 1 : 0;
  }
}

export async function logout({ quiet = false }) {
  const hadKey = deleteUserConfigKey("api_key");
  if (quiet) return 0;
  console.log(
    hadKey
      ? green("✓ ") + `logged out — removed the saved API key from ${USER_CONFIG_PATH}`
      : gray("nothing to do — no saved API key")
  );
  return 0;
}
