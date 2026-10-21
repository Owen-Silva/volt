// VOLT — plugin hooks. Drop a .js file into ~/.volt/plugins/ that
// default-exports an object with any of these hooks:
//
//   { name, beforeSend(messages, ctx) → messages|null, afterResponse(content, ctx) → content|null }
//
// - beforeSend: called with the message list before it is sent. Return a new
//   (or mutated) list to change what the model sees. Runs in every mode.
// - afterResponse: called with the final response text. Return modified text.
//   Declaring it makes one-shot modes (ask/compare/review) buffer the response
//   so the hook can transform it; chat streams and ignores this hook.
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGINS_DIR } from "./config.js";
import { gray } from "./util.js";

export async function loadPlugins() {
  const plugins = [];
  let files = [];
  try {
    files = readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".js"));
  } catch {
    return plugins; // no plugins dir → no plugins
  }
  for (const f of files.sort()) {
    try {
      const mod = await import(pathToFileURL(path.join(PLUGINS_DIR, f)).href);
      const p = mod.default || mod;
      if (p && typeof p === "object") {
        plugins.push({ name: p.name || f.replace(/\.js$/, ""), ...p });
      }
    } catch (err) {
      console.error(gray(`⚠ plugin ${f} failed to load: ${err.message}`));
    }
  }
  return plugins;
}

export async function runHooks(plugins, hook, value, ctx) {
  for (const p of plugins) {
    try {
      if (typeof p[hook] === "function") {
        const r = await p[hook](value, ctx);
        // null/undefined (and accidental "") mean "leave unchanged"
        if (r != null && r !== "") value = r;
      }
    } catch (err) {
      console.error(gray(`⚠ plugin ${p.name} ${hook}: ${err.message}`));
    }
  }
  return value;
}
