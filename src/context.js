// VOLT — context helpers: files, git diff, clipboard, prompt assembly.
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gray } from "./util.js";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export function readFileContext(paths) {
  const blocks = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!existsSync(abs)) {
      console.error(gray(`  ⚠ file not found: ${p}`));
      continue;
    }
    try {
      if (!statSync(abs).isFile()) {
        console.error(gray(`  ⚠ not a file: ${p}`));
        continue;
      }
    } catch {
      console.error(gray(`  ⚠ cannot read: ${p}`));
      continue;
    }
    let content = readFileSync(abs, "utf8");
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES) + "\n… [truncated by volt]";
    }
    const lang = path.extname(abs).slice(1) || "text";
    blocks.push(`### File: ${p}\n\n\`\`\`${lang}\n${content}\n\`\`\``);
  }
  return blocks;
}

export async function gitDiff() {
  const run = async (args) => {
    try {
      const r = await execFileAsync("git", args, {
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      return r.stdout;
    } catch {
      return null;
    }
  };
  const diff = (await run(["diff", "HEAD", "--no-color"])) ?? (await run(["diff", "--no-color"]));
  if (!diff) return null;
  const stat =
    (await run(["diff", "--stat", "HEAD", "--no-color"])) ??
    (await run(["diff", "--stat", "--no-color"]));
  return `### Git diff\n\n${(stat || "").trim()}\n\n\`\`\`diff\n${diff.trimEnd()}\n\`\`\``;
}

export async function readClipboard() {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("pbpaste");
      return stdout;
    }
    if (platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true }
      );
      return stdout;
    }
    try {
      const { stdout } = await execFileAsync("xclip", ["-o", "-selection", "clipboard"]);
      return stdout;
    } catch {
      const { stdout } = await execFileAsync("xsel", ["-b"]);
      return stdout;
    }
  } catch {
    return null;
  }
}

export function buildPrompt(prompt, contextBlocks) {
  if (!contextBlocks.length) return prompt;
  return `I've attached context from the terminal. Use it to answer my question.\n\n${contextBlocks.join(
    "\n\n"
  )}\n\n---\n\n${prompt}`;
}

// Read image files into OpenAI-style data-URL parts for vision models.
export function readImageParts(paths) {
  const parts = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      console.error(gray(`  ⚠ image not found: ${p}`));
      continue;
    }
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) {
      console.error(gray(`  ⚠ unsupported image type: ${p} (png/jpg/gif/webp/svg)`));
      continue;
    }
    try {
      const size = statSync(abs).size;
      if (size > MAX_IMAGE_BYTES) {
        console.error(gray(`  ⚠ image too large (>8 MB): ${p}`));
        continue;
      }
      const b64 = readFileSync(abs).toString("base64");
      parts.push({ path: p, mime, dataUrl: `data:${mime};base64,${b64}` });
    } catch {
      console.error(gray(`  ⚠ cannot read image: ${p}`));
    }
  }
  return parts;
}

// Assemble the user message: text prompt (+ context blocks) plus any images.
export function buildUserContent(prompt, contextBlocks, images = []) {
  const text = buildPrompt(prompt, contextBlocks);
  if (!images.length) return text;
  return [
    { type: "text", text },
    ...images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } })),
  ];
}
