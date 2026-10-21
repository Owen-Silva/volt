// VOLT — configuration: provider presets, env overrides, project + user config.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { extensions, extensionFor } from "./local-providers.js";

export const VOLT_DIR = path.join(homedir(), ".volt");
export const USER_CONFIG_PATH = path.join(VOLT_DIR, "config.json");
export const HISTORY_PATH = path.join(VOLT_DIR, "history.json");
export const SESSIONS_DIR = path.join(VOLT_DIR, "sessions");
export const PLUGINS_DIR = path.join(VOLT_DIR, "plugins");

const PROVIDER_PRESETS = {
  openai: {
    base_url: "https://api.openai.com/v1",
    api_key_env: "VOLT_API_KEY",
    default_model: "gpt-4o-mini",
    family: "openai",
  },
  anthropic: {
    base_url: "https://api.anthropic.com",
    api_key_env: "VOLT_ANTHROPIC_API_KEY",
    // Also accept the standard Anthropic variable (checked after the VOLT one).
    api_key_env_alt: "ANTHROPIC_API_KEY",
    default_model: "claude-sonnet-4-5",
    family: "anthropic",
  },
  ollama: {
    base_url: "http://localhost:11434/v1",
    api_key_env: null,
    default_model: "llama3.2",
    family: "openai",
  },
  groq: {
    base_url: "https://api.groq.com/openai/v1",
    api_key_env: "VOLT_GROQ_API_KEY",
    default_model: "llama-3.3-70b-versatile",
    family: "openai",
  },
  openrouter: {
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "VOLT_OPENROUTER_API_KEY",
    default_model: "openai/gpt-4o-mini",
    family: "openai",
  },
  deepseek: {
    base_url: "https://api.deepseek.com/v1",
    api_key_env: "VOLT_DEEPSEEK_API_KEY",
    default_model: "deepseek-chat",
    family: "openai",
  },
  mistral: {
    base_url: "https://api.mistral.ai/v1",
    api_key_env: "VOLT_MISTRAL_API_KEY",
    default_model: "mistral-small-latest",
    family: "openai",
  },
  together: {
    base_url: "https://api.together.xyz/v1",
    api_key_env: "VOLT_TOGETHER_API_KEY",
    default_model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    family: "openai",
  },
  lmstudio: {
    base_url: "http://localhost:1234/v1",
    api_key_env: null,
    default_model: "local-model",
    family: "openai",
  },
  cerebras: {
    base_url: "https://api.cerebras.ai/v1",
    api_key_env: "VOLT_CEREBRAS_API_KEY",
    default_model: "llama-3.3-70b",
    family: "openai",
  },
  openai_compatible: {
    base_url: null,
    api_key_env: null,
    default_model: null,
    family: "openai",
  },
};

const DEFAULTS = {
  provider: "openai",
  model: null,
  temperature: 0.7,
  max_tokens: 4096,
  stream: true,
  system_prompt: null,
  providers: {},
};

export function deepMerge(...objs) {
  const out = {};
  for (const o of objs) {
    if (!o) continue;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = deepMerge(out[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
  }
  return out;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function findProjectConfig(start = process.cwd()) {
  let dir = start;
  for (;;) {
    for (const name of [".volt.json", ".voltrc.json"]) {
      const p = path.join(dir, name);
      if (existsSync(p)) return readJson(p, {});
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function getConfig() {
  const user = readJson(USER_CONFIG_PATH, {});
  const project = findProjectConfig();
  const merged = deepMerge(
    DEFAULTS,
    { providers: PROVIDER_PRESETS },
    project,
    user
  );

  // Zero-setup: if the user hasn't configured ANY provider/key/base URL but a
  // local provider extension says it is ready (its autoSelect()), use it so
  // `volt` just works. The guard is deliberately strict — any hint of intent (env key, per-provider
  // key in config, base URL, explicit provider) disables auto-detect so it never
  // silently overrides something the user set up.
  let autoProvider = null;
  const explicitProvider = process.env.VOLT_PROVIDER || user.provider || project?.provider;
  const anyKeyEnv = Object.keys(process.env).some(
    (k) => k.startsWith("VOLT_") && k.endsWith("_API_KEY") && process.env[k]
  );
  const perProviderKey =
    user.providers &&
    typeof user.providers === "object" &&
    Object.values(user.providers).some((p) => p && typeof p === "object" && p.api_key);
  const anyBaseUrl = process.env.VOLT_BASE_URL || user.base_url || project?.base_url;
  if (!explicitProvider && !anyKeyEnv && !perProviderKey && !user.api_key && !anyBaseUrl) {
    const ext = extensions.find((e) => typeof e.autoSelect === "function" && e.autoSelect());
    if (ext) autoProvider = ext.name;
  }
  // Zero-setup, API-key path: nothing configured except an Anthropic key in
  // the environment (ANTHROPIC_API_KEY or VOLT_ANTHROPIC_API_KEY) → use it.
  let autoAnthropic = false;
  if (!explicitProvider && !autoProvider && !perProviderKey && !user.api_key && !anyBaseUrl) {
    const otherKeyEnv = Object.keys(process.env).some(
      (k) =>
        k.startsWith("VOLT_") &&
        k.endsWith("_API_KEY") &&
        k !== "VOLT_ANTHROPIC_API_KEY" &&
        process.env[k]
    );
    if (!otherKeyEnv && (process.env.VOLT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)) {
      autoAnthropic = true;
    }
  }
  const providerName =
    explicitProvider ||
    (autoProvider ? autoProvider : autoAnthropic ? "anthropic" : merged.provider || "openai");
  const provider = resolveProviderFrom(providerName, user, project);

  const model =
    process.env.VOLT_MODEL || merged.model || provider.default_model || null;
  const temperature =
    process.env.VOLT_TEMPERATURE !== undefined
      ? Number(process.env.VOLT_TEMPERATURE)
      : merged.temperature;
  const maxTokens =
    process.env.VOLT_MAX_TOKENS !== undefined
      ? Number(process.env.VOLT_MAX_TOKENS)
      : merged.max_tokens;
  const stream = merged.stream !== false;
  const systemPrompt = process.env.VOLT_SYSTEM || merged.system_prompt || null;

  return {
    ...merged,
    providerName,
    provider,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    temperature,
    maxTokens,
    stream,
    systemPrompt,
    autoProvider,
    userConfig: user,
    projectConfig: project,
  };
}

function resolveProviderFrom(providerName, user, project, overrides = {}) {
  const preset = PROVIDER_PRESETS[providerName] || extensionFor(providerName)?.preset || {
    family: "openai",
    default_model: null,
    base_url: null,
    api_key_env: null,
  };
  const custom =
    user?.providers?.[providerName] || project?.providers?.[providerName] || {};
  const provider = { name: providerName, ...preset, ...custom, ...overrides };
  const apiKey =
    process.env.VOLT_API_KEY ||
    (provider.api_key_env && process.env[provider.api_key_env]) ||
    (provider.api_key_env_alt && process.env[provider.api_key_env_alt]) ||
    user.api_key ||
    provider.api_key ||
    null;
  const baseUrl = process.env.VOLT_BASE_URL || provider.base_url || null;
  return { ...provider, apiKey, baseUrl };
}

export function resolveProvider(providerName, overrides = {}) {
  return resolveProviderFrom(
    providerName,
    readJson(USER_CONFIG_PATH, {}),
    findProjectConfig(),
    overrides
  );
}

export function deleteUserConfigKey(dottedKey) {
  const current = readJson(USER_CONFIG_PATH, {});
  const keys = dottedKey.split(".");
  let obj = current;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj || typeof obj[keys[i]] !== "object" || obj[keys[i]] === null) return false;
    obj = obj[keys[i]];
  }
  if (typeof obj !== "object" || obj === null || !(keys[keys.length - 1] in obj)) return false;
  delete obj[keys[keys.length - 1]];
  mkdirSync(VOLT_DIR, { recursive: true });
  writeFileSync(USER_CONFIG_PATH, JSON.stringify(current, null, 2) + "\n");
  return true;
}

export function saveUserConfig(patch) {
  const current = readJson(USER_CONFIG_PATH, {});
  const next = deepMerge(current, patch);
  mkdirSync(VOLT_DIR, { recursive: true });
  writeFileSync(USER_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function ensureDirs() {
  mkdirSync(VOLT_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
}
