// VOLT — reusable prompt templates. Built-ins ship with VOLT; users can save
// their own (stored in ~/.volt/templates.json). A template has an optional
// `system` prompt and an optional `prompt` wrapper that is applied to the
// user's question (supports a {prompt} placeholder).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { VOLT_DIR } from "./config.js";

export const TEMPLATES_PATH = path.join(VOLT_DIR, "templates.json");

const BUILTINS = {
  commit: {
    system:
      "You write concise, conventional commit messages (type(scope): summary). Output only the commit message, no commentary or code fences.",
    prompt: "Write a commit message for the changes below.",
  },
  review: {
    system:
      "You are a senior engineer doing a rigorous code review. Find real bugs, security issues, correctness problems, and readability wins. Report each finding on its own line in this exact format:\n- [severity] location — description\nwhere severity is one of: critical, high, medium, low, info. Be specific: name the file and line or symbol. End with a one-line Summary.",
    prompt: "Review the attached code.",
  },
  test: {
    system:
      "You write thorough, focused tests. Output the test file content in a single code block. Prefer the test framework implied by the project; if unknown, use plain assertions.",
    prompt: "Write tests for the attached code.",
  },
  explain: {
    system:
      "You explain code at a senior level: what it does, how it fits together, and which parts are subtle or fragile. Be concrete and cite names from the code.",
    prompt: "Explain the attached code.",
  },
  debug: {
    system:
      "You are a debugging expert. Identify the most likely root cause, explain why, and propose a concrete fix. If more information is needed, ask for it or use tools to find it.",
    prompt: "I'm debugging the attached code. Find the likely root cause and propose a fix.",
  },
  shell: {
    system:
      "You generate shell commands only. Output a single command or a short one-liner, no commentary, no markdown fences.",
    prompt: "Give me the shell command that does this:",
  },
  improve: {
    system:
      "You suggest concrete, prioritized improvements to code: correctness first, then performance, then readability. Cite specific lines.",
    prompt: "Suggest concrete improvements to the attached code.",
  },
  summary: {
    system: "You summarize content concisely: main points, key numbers, and action items.",
    prompt: "Summarize the attached content.",
  },
};

export function readTemplatesFile() {
  try {
    const j = JSON.parse(readFileSync(TEMPLATES_PATH, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function writeTemplatesFile(templates) {
  mkdirSync(VOLT_DIR, { recursive: true });
  writeFileSync(TEMPLATES_PATH, JSON.stringify(templates, null, 2) + "\n");
}

export function listTemplates() {
  const user = readTemplatesFile();
  const names = new Set([...Object.keys(BUILTINS), ...Object.keys(user)]);
  return [...names].sort().map((name) => ({
    name,
    builtin: !user[name],
    system: (user[name] || BUILTINS[name])?.system ?? null,
    prompt: (user[name] || BUILTINS[name])?.prompt ?? null,
  }));
}

export function resolveTemplate(name) {
  const user = readTemplatesFile();
  const t = user[name] || BUILTINS[name];
  if (!t) return null;
  return { name, system: t.system || null, prompt: t.prompt || null, builtin: !user[name] };
}

export function saveTemplate(name, def) {
  const all = readTemplatesFile();
  all[name] = { ...(all[name] || {}), ...def };
  writeTemplatesFile(all);
  return all[name];
}

export function deleteTemplate(name) {
  const all = readTemplatesFile();
  if (!(name in all)) return false;
  delete all[name];
  writeTemplatesFile(all);
  return true;
}

/**
 * Apply a template to a question: returns { prompt, system }.
 * The template's prompt is used as a wrapper; a {prompt} placeholder is
 * replaced with the user's question, otherwise the question is appended.
 */
export function applyTemplate(template, question) {
  let prompt = question || "";
  if (template.prompt) {
    const wrapper = template.prompt;
    prompt = wrapper.includes("{prompt}")
      ? wrapper.replace("{prompt}", prompt)
      : wrapper + (prompt ? "\n\n" + prompt : "");
  }
  return { prompt, system: template.system || null };
}
