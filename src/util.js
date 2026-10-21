// VOLT — shared terminal utilities (zero dependencies).
import { readFileSync } from "node:fs";

// HTTP/API error with a status code (0 = not an HTTP failure). Defined here,
// not in providers.js, so optional provider modules can import it without an
// import cycle; providers.js re-exports it.
export class ApiError extends Error {
  constructor(status, message, body = "") {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "ApiError";
  }
}

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
export const VERSION = pkg.version;

// Color rules: NO_COLOR always wins (explicit opt-out), FORCE_COLOR=1 forces
// color on (even in CI), otherwise color only when stdout is a TTY outside CI.
export const isColorSupported =
  (process.env.FORCE_COLOR === "1" ||
    (Boolean(process.stdout.isTTY) && !process.env.CI)) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

export const isTTY = Boolean(process.stdout.isTTY);

export const col = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[38;5;203m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;222m",
  blue: "\x1b[38;5;117m",
  magenta: "\x1b[38;5;176m",
  cyan: "\x1b[38;5;116m",
  gray: "\x1b[38;5;245m",
  orange: "\x1b[38;5;208m",
  purple: "\x1b[38;5;141m",
};

export function paint(code, text) {
  return isColorSupported ? `${code}${text}${col.reset}` : text;
}
export const bold = (t) => paint(col.bold, t);
export const dim = (t) => paint(col.dim, t);
export const red = (t) => paint(col.red, t);
export const green = (t) => paint(col.green, t);
export const yellow = (t) => paint(col.yellow, t);
export const cyan = (t) => paint(col.cyan, t);
export const gray = (t) => paint(col.gray, t);

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Render any message content (string or OpenAI multimodal array) as display text.
export function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : p.type === "image_url"
            ? "[📷 image attached]"
            : p.text || ""
      )
      .join("\n");
  }
  return String(content ?? "");
}

export function displayWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const c = ch.codePointAt(0);
    w += c > 0x2ff ? 2 : 1;
  }
  return w;
}

export function truncate(s, n) {
  if (displayWidth(s) <= n) return s;
  let out = "";
  for (const ch of s) {
    if (displayWidth(out + ch) > n - 1) break;
    out += ch;
  }
  return out + "…";
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Idempotent TTY spinner: returns a stop() that only clears the line once,
// so a streaming renderer's active line is never erased after the first token.
export function startSpinner(label) {
  if (!isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let running = true;
  const id = setInterval(() => {
    if (!running) return;
    process.stdout.write("\r\x1b[2K" + paint(col.gray, frames[i++ % frames.length] + " " + label));
  }, 80);
  return () => {
    if (!running) return;
    running = false;
    clearInterval(id);
    process.stdout.write("\r\x1b[2K");
  };
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function formatAge(iso) {
  const mins = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  );
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function hasStdinData() {
  return !process.stdin.isTTY;
}

export function missingAnthropicKeyMessage() {
  return (
    "no Anthropic API key set. VOLT uses an Anthropic API key for Claude:\n" +
    "  set ANTHROPIC_API_KEY (or VOLT_ANTHROPIC_API_KEY), or run `volt login anthropic`"
  );
}
