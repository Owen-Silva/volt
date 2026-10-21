// VOLT — streaming Markdown → ANSI rendering with lightweight syntax
// highlighting. Renders completed lines as they arrive and redraws the
// current partial line in place, so output feels instant without flicker.
import { isColorSupported, paint, col, displayWidth } from "./util.js";

// ---------- syntax highlighting ----------

const KW = {
  js: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|null|undefined|true|false|yield|delete|void|static|get|set|readonly|private|public|protected|type|enum|namespace|declare|abstract)\b/g,
  python: /\b(?:def|class|import|from|return|if|elif|else|for|while|in|not|and|or|try|except|finally|raise|lambda|with|as|pass|break|continue|global|nonlocal|yield|async|await|assert|del|is|None|True|False|self|match|case)\b/g,
  bash: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|local|export|echo|printf|read|cd|exit|break|continue|select|in)\b/g,
  sql: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|GROUP|BY|ORDER|LIMIT|OFFSET|HAVING|AND|OR|NOT|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|INDEX|UNIQUE|AS|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|LIKE|IN|IS|ASC|DESC|UNION|ALL)\b/gi,
  go: /\b(?:package|import|func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|select|case|default|break|continue|fallthrough|switch|goto|error|nil|true|false|make|new|len|cap|append|string|int|int64|float64|bool|byte|rune|uint)\b/g,
  rust: /\b(?:fn|let|mut|const|static|struct|enum|impl|trait|pub|use|mod|crate|self|Self|return|if|else|for|while|loop|match|async|await|dyn|type|ref|move|in|where|Some|None|Ok|Err|true|false|as|break|continue|unsafe|extern)\b/g,
  json: /\b(?:true|false|null)\b/g,
  yaml: /\b(?:true|false|null|yes|no|on|off)\b/g,
};

const RULES = {
  javascript: [
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, color: col.green },
    { re: /\/\/.*$|\/\*[\s\S]*?\*\//gm, color: col.gray },
    { re: KW.js, color: col.purple },
    { re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, color: col.orange },
    { re: /\b[A-Za-z_$][\w$]*\s*(?=\()/g, color: col.blue },
  ],
  typescript: [
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, color: col.green },
    { re: /\/\/.*$|\/\*[\s\S]*?\*\//gm, color: col.gray },
    { re: KW.js, color: col.purple },
    { re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, color: col.orange },
    { re: /\b[A-Za-z_$][\w$]*\s*(?=\()/g, color: col.blue },
    { re: /\b(?:string|number|boolean|any|unknown|never|void|object|Record|Partial|Readonly|Pick|Omit|Promise)\b/g, color: col.cyan },
  ],
  python: [
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, color: col.green },
    { re: /#.*$/gm, color: col.gray },
    { re: KW.python, color: col.purple },
    { re: /\b\d[\d_]*(?:\.\d+)?\b/g, color: col.orange },
    { re: /\b[A-Za-z_][\w]*\s*(?=\()/g, color: col.blue },
  ],
  json: [
    { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/g, color: col.cyan },
    { re: /"(?:[^"\\]|\\.)*"/g, color: col.green },
    { re: KW.json, color: col.purple },
    { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, color: col.orange },
  ],
  bash: [
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, color: col.green },
    { re: /#.*$/gm, color: col.gray },
    { re: KW.bash, color: col.purple },
    { re: /(?<![\w-])-{1,2}[\w-]+/g, color: col.yellow },
    { re: /\b\d+\b/g, color: col.orange },
  ],
  sql: [
    { re: /'(?:[^'\\\n]|\\.)*'/g, color: col.green },
    { re: /--.*$/gm, color: col.gray },
    { re: KW.sql, color: col.purple },
    { re: /\b\d+\b/g, color: col.orange },
  ],
  go: [
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`/g, color: col.green },
    { re: /\/\/.*$|\/\*[\s\S]*?\*\//gm, color: col.gray },
    { re: KW.go, color: col.purple },
    { re: /\b\d+(?:\.\d+)?\b/g, color: col.orange },
    { re: /\b[A-Za-z_][\w]*\s*(?=\()/g, color: col.blue },
  ],
  rust: [
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, color: col.green },
    { re: /\/\/.*$/gm, color: col.gray },
    { re: KW.rust, color: col.purple },
    { re: /\b\d[\d_]*(?:\.\d+)?\b/g, color: col.orange },
    { re: /\b[A-Za-z_][\w]*\s*(?=\()/g, color: col.blue },
  ],
  yaml: [
    { re: /#.*$/gm, color: col.gray },
    { re: /^[\w.-]+(?=\s*:)/gm, color: col.cyan },
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, color: col.green },
    { re: KW.yaml, color: col.purple },
    { re: /-?\d+(?:\.\d+)?/g, color: col.orange },
  ],
  css: [
    { re: /\/\*[\s\S]*?\*\//g, color: col.gray },
    { re: /[a-zA-Z-]+(?=\s*:)/g, color: col.cyan },
    { re: /#[0-9a-fA-F]{3,8}\b/g, color: col.orange },
    { re: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|fr)?\b/g, color: col.orange },
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, color: col.green },
  ],
  html: [
    { re: /<!--[\s\S]*?-->/g, color: col.gray },
    { re: /<\/?[a-zA-Z][^>]*>/g, color: col.blue },
    { re: /"[^"]*"|'[^']*'/g, color: col.yellow },
  ],
  diff: [
    { re: /^diff --git.*$/gm, color: col.blue },
    { re: /^index .*$/gm, color: col.gray },
    { re: /^--- .*$/gm, color: col.orange },
    { re: /^\+\+\+ .*$/gm, color: col.orange },
    { re: /^@@.*$/gm, color: col.cyan },
    { re: /^\+.*$/gm, color: col.green },
    { re: /^-.*$/gm, color: col.red },
  ],
  common: [
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, color: col.green },
    { re: /\/\/.*$|#.*$/gm, color: col.gray },
    { re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, color: col.orange },
  ],
};

const LANG_ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", python3: "python",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash",
  json: "json", jsonc: "json",
  go: "go", golang: "go",
  rs: "rust",
  sql: "sql",
  yml: "yaml", yaml: "yaml",
  css: "css", scss: "css",
  html: "html", htm: "html", xml: "html",
  diff: "diff", patch: "diff",
};

export function highlight(code, lang = "") {
  if (!isColorSupported || !code) return code;
  const key = LANG_ALIASES[String(lang).toLowerCase()];
  const rules = RULES[key] || RULES.common;
  const spans = [];
  for (const { re, color } of rules) {
    const rx = new RegExp(re.source, re.flags.replace(/g/, "") + "g");
    let m;
    while ((m = rx.exec(code)) !== null) {
      if (!m[0]) {
        rx.lastIndex++;
        continue;
      }
      const end = m.index + m[0].length;
      if (spans.some((s) => m.index < s.end && s.start < end)) continue;
      spans.push({ start: m.index, end, color });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    out += code.slice(pos, s.start) + s.color + code.slice(s.start, s.end) + col.reset;
    pos = s.end;
  }
  out += code.slice(pos);
  return out;
}

// ---------- inline markdown ----------

const ESC = "\uE000";
const ESCAPE_CLASS = "`*_~\\[\\]";
function escapeMarkdown(text) {
  return text.replace(/\\([`*_~\[\]])/g, (_, c) => ESC + c);
}
function unescapeMarkdown(text) {
  return text.replace(new RegExp(`${ESC}([${ESCAPE_CLASS}])`, "g"), "$1");
}

export function renderInline(text) {
  if (!isColorSupported) return text;
  let t = escapeMarkdown(text);
  t = t
    .replace(/`([^`]+)`/g, (_, c) => paint(col.green, c))
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => paint(col.bold, b))
    .replace(/__([^_]+)__/g, (_, b) => paint(col.bold, b))
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, (m, pre, it) => pre + paint(col.italic, it))
    .replace(/(^|[^_])_([^_\s][^_]*?)_/g, (m, pre, it) => pre + paint(col.italic, it))
    .replace(/~~([^~]+)~~/g, (_, s) => paint(col.gray + "\x1b[9m", s))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t2) => paint(col.underline + col.blue, t2))
    .replace(/(?<![\w])(https?:\/\/[^\s)\]]+)/g, (m) => paint(col.underline + col.blue, m));
  return unescapeMarkdown(t);
}

// ---------- block markdown ----------

export function renderMarkdownLine(line) {
  if (!isColorSupported) return line;
  let m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (m) {
    const level = m[1].length;
    const color = level === 1 ? col.magenta : level === 2 ? col.blue : col.cyan;
    return paint(col.bold + color, m[2]);
  }
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
    return paint(col.gray, "─".repeat(36));
  }
  m = /^>\s?(.*)$/.exec(line);
  if (m) return paint(col.gray, "│ ") + renderInline(m[1]);
  m = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
  if (m) return m[1] + paint(col.green, m[2].toLowerCase() === "x" ? "☑" : "☐") + " " + renderInline(m[3]);
  m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (m) return m[1] + paint(col.orange, m[2]) + " " + renderInline(m[3]);
  return renderInline(line);
}

export function renderTable(rows) {
  const parsed = rows.map((r) =>
    r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
  );
  let sepIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].every((c) => /^:?-+:?$/.test(c))) {
      sepIdx = i;
      break;
    }
  }
  const data = parsed.filter((_, i) => i !== sepIdx);
  const widths = [];
  for (const row of data) {
    row.forEach((c, j) => {
      widths[j] = Math.max(widths[j] || 0, displayWidth(c));
    });
  }
  const renderRow = (row, isHeader) => {
    const cells = row.map((c, j) => {
      const w = widths[j] || 0;
      const cell = c + " ".repeat(Math.max(0, w - displayWidth(c)));
      return isHeader ? paint(col.bold, cell) : cell;
    });
    return paint(col.gray, "│ ") + cells.join(paint(col.gray, " │ ")) + paint(col.gray, " │");
  };
  const out = [];
  if (sepIdx !== -1 && parsed[0]) {
    out.push(renderRow(parsed[0], true));
    out.push(
      paint(
        col.gray,
        "│ " +
          parsed[0].map((_, j) => "─".repeat(Math.max(widths[j] || 1, 1))).join("─┼─") +
          " │"
      )
    );
    for (let i = sepIdx + 1; i < parsed.length; i++) out.push(renderRow(parsed[i], false));
  } else {
    for (const row of parsed) out.push(renderRow(row, false));
  }
  return out.join("\n");
}

// ---------- full render (for history / show) ----------

export function renderMarkdown(text) {
  if (!isColorSupported || !text) return text;
  const out = [];
  let fence = null;
  let code = [];
  let table = null;
  const flushCode = () => {
    if (code.length) out.push(code.map((l) => highlight(l, fence)).join("\n"));
    code = [];
    fence = null;
  };
  const flushTable = () => {
    if (table) out.push(renderTable(table));
    table = null;
  };
  for (const line of text.split("\n")) {
    const fm = /^```(\S*)\s*$/.exec(line.trim());
    if (fm) {
      if (fence !== null) {
        flushCode();
        out.push(paint(col.gray, "```"));
      } else {
        flushTable();
        fence = fm[1] || "";
        code = [];
        out.push(paint(col.gray, "```" + (fm[1] || "")));
      }
      continue;
    }
    if (fence !== null) {
      code.push(line);
      continue;
    }
    if (/^\s*\|/.test(line) && line.split("|").length >= 3) {
      if (!table) table = [];
      table.push(line);
      continue;
    }
    flushTable();
    out.push(renderMarkdownLine(line));
  }
  flushTable();
  flushCode();
  return out.join("\n");
}

// ---------- streaming printer ----------

export class StreamPrinter {
  constructor({ width, plain = false } = {}) {
    this.width = width || process.stdout.columns || 100;
    this.plain = plain || !isColorSupported;
    this.tty = Boolean(process.stdout.isTTY) && !this.plain;
    this.fence = null;
    this.tableRows = [];
    this._active = "";
  }

  // Feed streaming text. Complete lines are emitted (and rendered); the
  // partial tail accumulates in this._active across chunks.
  _emit(text) {
    if (text.includes("\r")) text = text.replace(/\r/g, "");
    this._active += text;
    let idx;
    while ((idx = this._active.indexOf("\n")) !== -1) {
      const line = this._active.slice(0, idx);
      this._active = this._active.slice(idx + 1);
      this.pushLine(line);
    }
  }

  _write(s) {
    process.stdout.write(s);
  }

  _flushTable() {
    if (!this.tableRows.length) return;
    this._write(renderTable(this.tableRows) + "\n");
    this.tableRows = [];
  }

  pushLine(raw) {
    const t = raw.trim();
    const fenceRe = /^```(\S*)\s*$/.exec(t);
    if (this.fence !== null) {
      if (fenceRe) {
        this.fence = null;
        this._write((this.plain ? t : paint(col.gray, "```")) + "\n");
      } else {
        this._write((this.plain ? raw : highlight(raw, this.fence)) + "\n");
      }
      return;
    }
    if (fenceRe) {
      this._flushTable();
      this.fence = fenceRe[1] || "";
      this._write((this.plain ? t : paint(col.gray, "```" + fenceRe[1])) + "\n");
      return;
    }
    if (/^\s*\|/.test(raw) && raw.split("|").length >= 3) {
      this.tableRows.push(raw);
      return;
    }
    this._flushTable();
    this._write((this.plain ? raw : renderMarkdownLine(raw)) + "\n");
  }

  appendChunk(text) {
    if (!this.tty) {
      // No TTY → no in-place redraw. Plain output streams straight through;
      // colored output (FORCE_COLOR) buffers to line boundaries so it can
      // render markdown and syntax highlighting without flicker.
      if (this.plain) {
        process.stdout.write(text);
        return;
      }
      this._emit(text);
      return;
    }
    this._emit(text);
    this.setActive(this._active);
  }

  setActive(raw) {
    this._active = raw;
    if (!this.tty) return;
    const disp = this._renderActive(raw);
    if (!disp) {
      this._write("\r\x1b[2K");
      return;
    }
    if (displayWidth(disp) > this.width - 1) return; // printed on completion
    this._write("\r\x1b[2K" + disp);
  }

  _renderActive(raw) {
    if (this.plain) return raw;
    if (this.fence) return highlight(raw, this.fence);
    return renderInline(raw);
  }

  clearLine() {
    if (this.tty) this._write("\r\x1b[2K");
  }

  finish() {
    if (!this.tty) {
      // No redraw available: flush buffered blocks, then the leftover partial
      // line, then any unterminated code fence.
      this._flushTable();
      if (this._active) {
        if (!this.plain) this._write(this._renderActive(this._active));
        this._active = "";
      }
      if (this.fence) {
        if (!this.plain) this._write(paint(col.gray, "```"));
        this.fence = null;
      }
      return;
    }
    this._flushTable();
    if (this.fence) {
      this._write(paint(col.gray, "```") + "\n");
      this.fence = null;
    }
  }
}
