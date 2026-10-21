// VOLT — `volt install claude` / `volt uninstall claude`: merge VOLT's
// features into the official Claude Code CLI.
//
// Installs three things:
//   1. Slash commands in ~/.claude/commands/volt-*.md — one per prompt
//      template (commit, review, test, explain, debug, shell, improve,
//      summary, …) so Claude Code gets VOLT's prompt engineering.
//   2. A Stop hook in ~/.claude/settings.json that runs
//      ~/.volt/claude/sync.js, which syncs every Claude Code session into
//      VOLT's ledger — `volt cost`, `volt stats`, `volt search` then cover
//      Claude Code too.
//   3. A skill at ~/.claude/skills/volt/SKILL.md teaching Claude Code to
//      use `volt` for unified stats/cost/search/templates.
//
// Everything is namespaced (volt-* / ~/.volt/claude) and uninstallable, and
// existing ~/.claude/settings.json content is merged, never clobbered.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { VOLT_DIR } from "./config.js";
import { slugify } from "./sessions.js";
import { listTemplates, resolveTemplate } from "./templates.js";
import { green, gray, yellow } from "./util.js";

const CLAUDE_DIR = path.join(homedir(), ".claude");
const COMMANDS_DIR = path.join(CLAUDE_DIR, "commands");
const SKILL_DIR = path.join(CLAUDE_DIR, "skills", "volt");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const HOOK_DIR = path.join(VOLT_DIR, "claude");
const HOOK_ENTRY = path.join(HOOK_DIR, "sync.js");

// Which tools each template's command may use in Claude Code.
const COMMAND_TOOLS = {
  commit: "Bash, Read, Glob, Grep",
  review: "Read, Glob, Grep, Bash",
  test: "Read, Glob, Grep, Edit, Write, Bash",
  explain: "Read, Glob, Grep",
  debug: "Read, Glob, Grep, Bash, Edit, Write",
  shell: "Bash",
  improve: "Read, Glob, Grep",
  summary: "Read, Glob, Grep",
};
const COMMAND_DESCS = {
  commit: "Write a conventional commit message (VOLT template)",
  review: "Rigorous code review with severity findings (VOLT template)",
  test: "Write focused tests (VOLT template)",
  explain: "Explain code at a senior level (VOLT template)",
  debug: "Find the root cause and propose a fix (VOLT template)",
  shell: "Generate a shell command only (VOLT template)",
  improve: "Suggest prioritized code improvements (VOLT template)",
  summary: "Summarize content concisely (VOLT template)",
};
const COMMAND_HINTS = {
  commit: "[scope or description]",
  review: "[files to review]",
  test: "[what to test]",
  explain: "[file or symbol]",
  debug: "[symptom]",
  shell: "[what you need]",
  improve: "[file or area]",
  summary: "[what to summarize]",
};

// Utility slash commands (not derived from templates) that give Claude Code
// one-key access to VOLT's unified ledger. Written by install, removed by
// uninstall; template sync never deletes or overwrites them (unless a user
// template happens to share a name — then the template wins).
const UTILITY_COMMANDS = [
  {
    name: "volt-cost",
    body: `---
description: Show the combined VOLT + Claude Code spend ledger (VOLT)
allowed-tools: Bash
---

Run \`volt cost\` in your terminal and read the output. Then give the user a concise
summary: total sessions, message count, total input→output tokens, and total spend,
plus the top model by spend. Claude Code's own sessions are included in these
numbers. If \`volt\` is not found on PATH, say so and suggest running
\`npm install -g .\` from the volt repo.
`,
  },
  {
    name: "volt-stats",
    body: `---
description: Show combined usage stats for VOLT and Claude Code sessions (VOLT)
allowed-tools: Bash
---

Run \`volt stats\` in your terminal and read the output. Then give the user a
concise summary: session count, message counts by role, total tokens in/out,
per-model breakdown, and the busiest day. Claude Code's own sessions are
included. If \`volt\` is not found on PATH, say so.
`,
  },
  {
    name: "volt-search",
    body: `---
description: Search every saved conversation, including Claude Code sessions (VOLT)
argument-hint: <query>
allowed-tools: Bash
---

Run \`volt search {args}\` in your terminal and read the output. Present the
matching conversations to the user with their excerpts. If there are no
matches, say so plainly.
`,
  },
];

// Tracks which volt-*.md command files VOLT wrote (name → content hash), so
// sync never clobbers a file the user edited by hand or deletes one they
// created themselves. Lives in ~/.volt/claude (state dir, like the hook).
const COMMANDS_MANIFEST = path.join(HOOK_DIR, "commands.json");
const fileHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function buildCommandBody(tpl) {
  const sys = tpl.system ? `${tpl.system}\n\n` : "";
  const prompt = tpl.prompt || "";
  return `---\ndescription: ${COMMAND_DESCS[tpl.name] || `VOLT template: ${tpl.name}`}\nargument-hint: ${COMMAND_HINTS[tpl.name] || "[description]"}\nallowed-tools: ${COMMAND_TOOLS[tpl.name] || "Read, Glob, Grep, Bash"}\n---\n\n${sys}${prompt}\n\nUser request: {args}\n`;
}

// The desired command set: utilities (always present) + one per template.
function desiredCommands() {
  const desired = new Map();
  for (const u of UTILITY_COMMANDS) desired.set(`${u.name}.md`, u.body);
  for (const t of listTemplates()) {
    const tpl = resolveTemplate(t.name);
    if (!tpl) continue;
    desired.set(`volt-${slugify(t.name)}.md`, buildCommandBody(tpl));
  }
  return desired;
}

// Reconcile ~/.claude/commands/volt-*.md with the template library. Only files
// VOLT wrote (per the manifest) are refreshed or removed; files the user
// edited by hand or created themselves are left untouched (with a warning).
// Returns the number of files written or removed. With force=true, runs even
// when the integration isn't installed yet (used by the installer itself).
export function syncClaudeCommands({ force = false } = {}) {
  if (!force && !isIntegrationInstalled()) return 0;
  if (!existsSync(COMMANDS_DIR)) return 0;
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(COMMANDS_MANIFEST, "utf8")) || {};
  } catch {
    /* first sync — adopt matching files below */
  }
  const desired = desiredCommands();
  let changed = 0;
  const modified = [];

  for (const [f, body] of desired) {
    const p = path.join(COMMANDS_DIR, f);
    let existing = null;
    try {
      existing = readFileSync(p, "utf8");
    } catch {
      /* missing */
    }
    if (existing === null) {
      writeFileSync(p, body);
      manifest[f] = fileHash(body);
      changed++;
    } else if (manifest[f] === fileHash(existing)) {
      // ours and untouched — refresh if the template changed
      if (existing !== body) {
        writeFileSync(p, body);
        manifest[f] = fileHash(body);
        changed++;
      }
    } else if (existing === body) {
      // identical to the template version (e.g. adopted from an older
      // install) — claim it so we can manage it from here on
      manifest[f] = fileHash(body);
    } else {
      modified.push(f); // edited by hand — keep the user's version
    }
  }

  // remove volt-written commands whose template was deleted
  for (const f of Object.keys(manifest)) {
    if (!desired.has(f) && f.endsWith(".md")) {
      try {
        unlinkSync(path.join(COMMANDS_DIR, f));
        changed++;
      } catch {
        /* ignore */
      }
      delete manifest[f];
    }
  }

  try {
    mkdirSync(path.dirname(COMMANDS_MANIFEST), { recursive: true });
    writeFileSync(COMMANDS_MANIFEST, JSON.stringify(manifest) + "\n");
  } catch {
    /* manifest is best-effort */
  }
  if (modified.length) {
    console.error(
      yellow(
        `⚠ ${modified.join(", ")} edited by hand — left as-is` +
          ` (re-run \`volt install claude\` after reverting to regenerate)`
      )
    );
  }
  return changed;
}

function isIntegrationInstalled() {
  const status = claudeIntegrationStatus();
  return status.commands > 0 || status.hook || status.skill;
}

const SKILL_MD = `---
name: volt
description: VOLT is a sibling AI copilot CLI on this machine. Use it (via Bash) when the user asks about combined VOLT + Claude Code spending or usage statistics, or about finding an old VOLT or Claude Code conversation. Run \`volt --help\` if unsure.
---

# VOLT

VOLT (\`volt\`) is a terminal AI copilot that shares this machine with you, and its
ledger includes your own sessions (synced by a Stop hook). Useful commands:

- \`volt cost\` — unified spend ledger across every provider, including Claude Code sessions.
- \`volt stats\` — usage dashboard: sessions, messages, tokens, per-model breakdown, activity.
- \`volt search "<query>"\` — full-text search over all saved conversations.
- \`volt template list\` / \`volt template save <name> "<prompt>"\` — reusable prompt templates.
- \`volt sessions\` / \`volt sessions show <name>\` — browse saved sessions.

Run them with Bash and read the output. They read local files only — no network.
`;

function wrapperFor(hookJsPath) {
  return `// Generated by \`volt install claude\` — edits will be overwritten.
import { runStopHook } from ${JSON.stringify(pathToFileURL(hookJsPath).href)};

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  try {
    await runStopHook(JSON.parse(input || "{}"));
  } catch (err) {
    console.error("[volt] hook error: " + (err && err.message ? err.message : err));
  }
  process.exit(0);
});
`;
}

function readSettings() {
  let raw = null;
  try {
    raw = readFileSync(SETTINGS_PATH, "utf8");
  } catch {
    return { exists: false, settings: {} }; // file missing — safe to create
  }
  try {
    const j = JSON.parse(raw);
    return { exists: true, settings: j && typeof j === "object" ? j : {} };
  } catch {
    return { exists: true, malformed: true, settings: {} }; // never clobber silently
  }
}

function hookCommand() {
  return `node "${HOOK_ENTRY}"`;
}

// Merge our Stop hook into settings, preserving everything else. Returns
// true if the settings file changed.
function mergeHook(settings, command) {
  const hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const already = stop.some(
    (m) => Array.isArray(m?.hooks) && m.hooks.some((h) => h?.command === command)
  );
  if (already) return false;
  hooks.Stop = [...stop, { hooks: [{ type: "command", command }] }];
  settings.hooks = hooks;
  return true;
}

function removeHook(settings, command) {
  const hooks = settings.hooks;
  if (!hooks || !Array.isArray(hooks.Stop)) return false;
  const before = hooks.Stop.length;
  hooks.Stop = hooks.Stop.filter(
    (m) => !(Array.isArray(m?.hooks) && m.hooks.some((h) => h?.command === command))
  );
  if (hooks.Stop.length === before) return false;
  if (hooks.Stop.length === 0) delete hooks.Stop;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return true;
}

export async function installClaudeIntegration({ quiet = false } = {}) {
  mkdirSync(COMMANDS_DIR, { recursive: true });
  mkdirSync(HOOK_DIR, { recursive: true }); // the command manifest lives here
  syncClaudeCommands({ force: true });
  const commands = readdirSync(COMMANDS_DIR)
    .filter((f) => f.startsWith("volt-") && f.endsWith(".md")).length;

  mkdirSync(HOOK_DIR, { recursive: true });
  const hookJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-hook.js");
  writeFileSync(HOOK_ENTRY, wrapperFor(hookJs));

  const { settings, malformed } = readSettings();
  if (malformed) {
    // preserve whatever was there — never silently destroy a broken file
    try {
      writeFileSync(SETTINGS_PATH + ".bak", readFileSync(SETTINGS_PATH, "utf8"));
      if (!quiet) {
        console.log(
          yellow(`⚠ ~/.claude/settings.json was malformed — original backed up to settings.json.bak`)
        );
      }
    } catch {
      /* backup is best-effort */
    }
  }
  const changed = mergeHook(settings, hookCommand());
  if (changed) writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");

  mkdirSync(SKILL_DIR, { recursive: true });
  writeFileSync(path.join(SKILL_DIR, "SKILL.md"), SKILL_MD);

  if (!quiet) {
    console.log(green("✓ ") + `merged VOLT into Claude Code (${commands} slash commands, Stop hook, skill)`);
    console.log(gray(`  commands  ${COMMANDS_DIR}\\volt-*.md`));
    console.log(gray(`  hook      ${SETTINGS_PATH}`));
    console.log(gray(`  skill     ${SKILL_DIR}`));
    console.log(gray("  restart Claude Code (or reload) for the commands & hook to take effect"));
  }
  return 0;
}

export async function uninstallClaudeIntegration({ quiet = false } = {}) {
  let removed = 0;
  if (existsSync(COMMANDS_DIR)) {
    for (const f of readdirSync(COMMANDS_DIR)) {
      if (f.startsWith("volt-") && f.endsWith(".md")) {
        try {
          unlinkSync(path.join(COMMANDS_DIR, f));
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
  }

  let hookRemoved = false;
  const { settings } = readSettings();
  if (removeHook(settings, hookCommand())) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    hookRemoved = true;
  }
  if (existsSync(HOOK_ENTRY)) {
    try {
      unlinkSync(HOOK_ENTRY);
      hookRemoved = true;
    } catch {
      /* ignore */
    }
  }

  let skillRemoved = false;
  if (existsSync(SKILL_DIR)) {
    try {
      rmSync(SKILL_DIR, { recursive: true, force: true });
      skillRemoved = true;
    } catch {
      /* ignore */
    }
  }
  if (existsSync(COMMANDS_MANIFEST)) {
    try {
      unlinkSync(COMMANDS_MANIFEST);
    } catch {
      /* ignore */
    }
  }

  if (quiet) return 0;
  if (removed || hookRemoved || skillRemoved) {
    console.log(
      green("✓ ") +
        `removed VOLT from Claude Code (${removed} commands${hookRemoved ? ", Stop hook" : ""}${skillRemoved ? ", skill" : ""})`
    );
  } else {
    console.log(gray("nothing to uninstall — VOLT isn't merged into Claude Code"));
  }
  return 0;
}

// For `volt doctor`.
export function claudeIntegrationStatus() {
  let commands = 0;
  if (existsSync(COMMANDS_DIR)) {
    for (const f of readdirSync(COMMANDS_DIR)) {
      if (f.startsWith("volt-") && f.endsWith(".md")) commands++;
    }
  }
  const hook = readSettings().settings.hooks?.Stop?.some((m) =>
    Array.isArray(m?.hooks) && m.hooks.some((h) => h?.command === hookCommand())
  );
  const skill = existsSync(path.join(SKILL_DIR, "SKILL.md"));
  return { commands, hook: Boolean(hook), skill };
}
