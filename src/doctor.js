// VOLT — diagnostics: validate config, keys, and connectivity.
import { existsSync } from "node:fs";
import { getConfig, USER_CONFIG_PATH, VOLT_DIR } from "./config.js";
import { fetchModels } from "./providers.js";
import { extensionFor, extensionForFamily } from "./local-providers.js";
import { missingAnthropicKeyMessage } from "./util.js";
import { claudeIntegrationStatus } from "./claude-install.js";
import { listTemplates } from "./templates.js";
import { paint, col, green, red, gray, bold, formatDuration } from "./util.js";

export async function doctor() {
  const ok = (m) => console.log(`  ${green("✔")} ${m}`);
  const bad = (m) => console.log(`  ${red("✘")} ${m}`);
  const info = (m) => console.log(`  ${gray("·")} ${m}`);

  console.log(paint(col.bold + col.purple, "⚡ volt doctor"));
  info(`node ${process.version} · ${process.platform} · ${process.arch}`);
  console.log();

  const config = getConfig();
  console.log(bold("config"));
  console.log(`  ${gray("dir")}     ${VOLT_DIR}`);
  if (existsSync(USER_CONFIG_PATH)) ok(`config file ${USER_CONFIG_PATH}`);
  else info("no user config file (defaults in use)");
  console.log(`  ${gray("provider")} ${config.providerName}`);
  console.log(`  ${gray("model")}    ${config.model}`);
  info(`base url  ${config.baseUrl}`);
  console.log();

  console.log(bold("features"));
  if (config.provider.family === "openai") {
    ok("agent mode available (" + config.providerName + " is OpenAI-compatible)");
  } else if (extensionForFamily(config.provider.family)?.agentUnavailable) {
    bad(extensionForFamily(config.provider.family).agentUnavailable);
  } else {
    bad(
      `agent mode unavailable — "${config.providerName}" uses the Anthropic protocol (use an OpenAI-compatible provider)`
    );
  }
  const tplCount = listTemplates().length;
  info(`${tplCount} prompt template${tplCount === 1 ? "" : "s"} available (volt template list)`);
  const integ = claudeIntegrationStatus();
  if (integ.commands || integ.hook || integ.skill) {
    ok(
      `claude integration: ${integ.commands} slash command${integ.commands === 1 ? "" : "s"}` +
        `${integ.hook ? " · Stop hook syncing usage" : ""}${integ.skill ? " · skill" : ""}`
    );
  } else {
    info("claude integration not installed — `volt install claude` merges VOLT's features into Claude Code");
  }
  const ext = extensionFor(config.providerName);
  if (ext && ext.doctorAuth) {
    ext.doctorAuth({ ok, bad, info });
  } else if (config.apiKey) {
    ok("api key present");
  } else if (config.provider.family === "anthropic") {
    bad(missingAnthropicKeyMessage());
  } else {
    bad("no api key set");
    info("hint: run `volt login anthropic` (or `volt login <provider>`) to save a key");
  }
  console.log();

  console.log(bold("connectivity"));
  if (ext && ext.doctorConnectivity) {
    ext.doctorConnectivity({ ok, bad, info });
    console.log();
    info("tip: run `volt config` to inspect, `volt config set <key> <value>` to change");
    return 0;
  }
  if (!config.baseUrl) {
    bad("no base URL — set VOLT_BASE_URL or configure a provider");
    return 0;
  }
  const t0 = Date.now();
  try {
    const models = await fetchModels(config.provider);
    ok(
      `${config.baseUrl}/models responded in ${formatDuration(Date.now() - t0)} (${models.length} models)`
    );
    if (models.length) {
      info("sample: " + models.slice(0, 3).join(", ") + (models.length > 3 ? ` +${models.length - 3} more` : ""));
    }
  } catch (err) {
    bad(`could not reach ${config.baseUrl}: ${err.message}`);
  }
  console.log();
  info("tip: run `volt config` to inspect, `volt config set <key> <value>` to change");
  return 0;
}
