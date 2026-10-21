// VOLT — session persistence. One JSONL file per session under ~/.volt/sessions.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
  statSync,
  unlinkSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, ensureDirs } from "./config.js";

export function slugify(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "session";
}

export function sessionPath(name) {
  return path.join(SESSIONS_DIR, `${slugify(name)}.jsonl`);
}

export function metaPath(name) {
  return path.join(SESSIONS_DIR, `${slugify(name)}.meta.json`);
}

export function loadSession(name) {
  const p = sessionPath(name);
  if (!existsSync(p)) return null;
  const messages = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && !j._meta) messages.push(j);
    } catch {
      /* skip malformed line */
    }
  }
  return messages;
}

export function appendSessionLine(name, msg) {
  if (!name) return;
  ensureDirs();
  try {
    appendFileSync(sessionPath(name), JSON.stringify(msg) + "\n");
  } catch {
    /* not critical */
  }
  try {
    writeFileSync(
      metaPath(name),
      JSON.stringify({
        name: slugify(name),
        model: msg.model || null,
        updatedAt: Date.now(),
      })
    );
  } catch {
    /* not critical */
  }
}

export function saveSession(name, messages, meta = {}) {
  ensureDirs();
  const p = sessionPath(name);
  const lines = [
    JSON.stringify({ _meta: { name: slugify(name), model: meta.model || null, updatedAt: Date.now() } }),
    ...messages.map((m) => JSON.stringify({ ...m, ts: m.ts || Date.now() })),
  ];
  writeFileSync(p, lines.join("\n") + "\n");
  try {
    writeFileSync(metaPath(name), JSON.stringify({ name: slugify(name), model: meta.model || null, updatedAt: Date.now() }));
  } catch {
    /* not critical */
  }
}

export function listSessions() {
  ensureDirs();
  const out = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    const name = f.slice(0, -6);
    const p = sessionPath(name);
    let count = 0;
    let updatedAt = null;
    try {
      const raw = readFileSync(p, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          if (!JSON.parse(line)?._meta) count++;
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      continue;
    }
    try {
      const meta = JSON.parse(readFileSync(metaPath(name), "utf8"));
      updatedAt = meta.updatedAt || null;
    } catch {
      /* no meta */
    }
    if (!updatedAt) {
      try {
        updatedAt = statSync(p).mtimeMs;
      } catch {
        updatedAt = 0;
      }
    }
    out.push({
      name,
      count,
      updatedAt: new Date(updatedAt).toISOString(),
    });
  }
  out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return out;
}

export function renameSession(oldName, newName) {
  if (slugify(oldName) === slugify(newName)) return false;
  const from = sessionPath(oldName);
  const to = sessionPath(newName);
  try {
    if (!existsSync(from)) return false;
    if (existsSync(to)) return null; // name collision
    ensureDirs();
    renameSync(from, to);
    try {
      if (existsSync(metaPath(oldName))) renameSync(metaPath(oldName), metaPath(newName));
    } catch {
      /* meta rename is best-effort */
    }
    return true;
  } catch {
    return false;
  }
}

export function deleteSession(name) {
  let ok = false;
  for (const p of [sessionPath(name), metaPath(name)]) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
        ok = true;
      }
    } catch {
      /* ignore */
    }
  }
  return ok;
}
