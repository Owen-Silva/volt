// VOLT — optional local provider extensions.
//
// Providers that ship with VOLT live in src/config.js and src/providers.js.
// A machine can add its own provider without touching tracked code: put a
// directory at the repo root whose name ends in ".local" (gitignored) with a
// provider.js inside that default-exports an extension object (name, preset,
// chat(), and optional hooks for help, login, models, config and doctor).
//
// VOLT_LOCAL_PROVIDERS overrides the search: a path-delimited list of
// extension directories ("" = none). The test suite uses it. A fresh clone
// has no extension directory, so nothing extra loads.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extensionDirs() {
  const env = process.env.VOLT_LOCAL_PROVIDERS;
  if (env !== undefined) return env.split(path.delimiter).filter(Boolean);
  let names = [];
  try {
    names = readdirSync(ROOT).filter((n) => n.endsWith(".local")).sort();
  } catch {
    return [];
  }
  return names.map((n) => path.join(ROOT, n));
}

async function loadExtensions() {
  const out = [];
  for (const dir of extensionDirs()) {
    const file = path.join(dir, "provider.js");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
    } catch {
      continue;
    }
    const mod = await import(pathToFileURL(file).href);
    const ext = mod.default;
    if (ext && typeof ext.name === "string" && ext.preset && typeof ext.chat === "function") out.push(ext);
  }
  return out;
}

export const extensions = await loadExtensions();

// The extension that owns a provider preset name (e.g. config.providerName).
export function extensionFor(name) {
  return extensions.find((e) => e.name === name) || null;
}

// The extension that owns a provider family (provider.family).
export function extensionForFamily(family) {
  return extensions.find((e) => e.preset.family === family) || null;
}

// Concatenated help text an extension adds to one section of `volt --help`.
export function extensionHelp(section) {
  return extensions.map((e) => (e.help && e.help[section]) || "").join("");
}
