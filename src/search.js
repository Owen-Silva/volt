// VOLT — `volt search <query>`: full-text search across every saved session.
// Prints matching sessions with the matching line excerpted. `-j` emits JSON.
import { listSessions, loadSession } from "./sessions.js";
import { paint, col, cyan, gray, green, contentText } from "./util.js";

const MAX_MATCHES = 50;

function excerpt(content, query) {
  const idx = content.toLowerCase().indexOf(query);
  if (idx === -1) return content.slice(0, 160);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? "…" : "") + content.slice(start, idx + query.length + 100).replace(/\s+/g, " ").trim() + "…";
}

export async function runSearch(query, { json = false } = {}) {
  const q = query.toLowerCase();
  const results = [];
  for (const s of listSessions()) {
    const messages = loadSession(s.name);
    if (!messages) continue;
    for (const m of messages) {
      if (m.role === "assistant" || m.role === "user") {
        const text = contentText(m.content);
        if (text.toLowerCase().includes(q)) {
          results.push({
            session: s.name,
            role: m.role,
            excerpt: excerpt(text, q),
            ts: m.ts || null,
          });
        }
      }
      if (results.length >= MAX_MATCHES) break;
    }
    if (results.length >= MAX_MATCHES) break;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ query, matches: results, truncated: results.length >= MAX_MATCHES }) + "\n");
    return 0;
  }

  if (!results.length) {
    console.log(gray(`no matches for "${query}" in any session`));
    return 0;
  }

  console.log(green(`⚡ ${results.length} match${results.length === 1 ? "" : "es"} for "${query}":`));
  let lastSession = null;
  for (const r of results) {
    if (r.session !== lastSession) {
      lastSession = r.session;
      console.log(paint(col.bold, r.session));
    }
    console.log(`  ${cyan(r.role === "user" ? "you › " : "volt › ")}${gray(r.excerpt)}`);
  }
  if (results.length >= MAX_MATCHES) console.log(gray("  … more matches (limit reached)"));
  return 0;
}
