// VOLT — prompt history (~/.volt/history.json): used for REPL arrow-up recall
// and for `volt history` (browse recent one-shot prompts).
import { readFileSync, writeFileSync } from "node:fs";
import { HISTORY_PATH, ensureDirs } from "./config.js";

const MAX = 500;

export function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

export function appendHistory(line) {
  if (!line || typeof line !== "string") return;
  ensureDirs();
  try {
    const h = loadHistory().filter((x) => x !== line);
    h.push(line);
    writeFileSync(HISTORY_PATH, JSON.stringify(h.slice(-MAX)));
  } catch {
    /* not critical */
  }
}

export function saveHistory(history) {
  try {
    writeFileSync(HISTORY_PATH, JSON.stringify((history || []).slice(-MAX)));
  } catch {
    /* not critical */
  }
}
