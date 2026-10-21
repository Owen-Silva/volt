// VOLT — automated test runner (zero dependencies).
// Boots the mock server, exercises the CLI end-to-end, prints PASS/FAIL.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync, readdirSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 9000 + Math.floor(Math.random() * 500);
const HOME = mkdtempSync(path.join(os.tmpdir(), "volt-test-"));
// Optional local provider extensions (see src/local-providers.js): the suite
// loads the same ones the CLI would, so their own tests.js can run below; the
// "no extension" checks at the end set VOLT_LOCAL_PROVIDERS="" instead.
const LOCAL_DIRS = readdirSync(ROOT)
  .filter((n) => n.endsWith(".local") && existsSync(path.join(ROOT, n, "provider.js")))
  .sort()
  .map((n) => path.join(ROOT, n));
const BASE_ENV = {
  ...process.env,
  VOLT_LOCAL_PROVIDERS: LOCAL_DIRS.join(path.delimiter),
  HOME,
  // Node's os.homedir() uses USERPROFILE on Windows, not $HOME —
  // override both so config/sessions stay inside the isolated temp dir.
  USERPROFILE: HOME,
  HOMEDRIVE: undefined,
  HOMEPATH: undefined,
  VOLT_PROVIDER: "openai",
  VOLT_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
  VOLT_API_KEY: "test-key",
  VOLT_MODEL: "gpt-4o-mini",
  NO_COLOR: "1",
  VOLT_MAX_TOKENS: "2048",
  CI: "1",
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ${"✔"} ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ${"✘"} ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function run(args, { input, env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "volt.js"), ...args], {
      cwd: cwd || ROOT,
      env: { ...BASE_ENV, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Run an arbitrary Node script with piped stdin (used to invoke the installed
// Claude Code hook exactly like Claude Code would).
function runNode(script, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...BASE_ENV, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.write(input);
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---- boot mock server ----
const mock = spawn(process.execPath, [path.join(ROOT, "test", "mock-server.js"), String(PORT)], {
  stdio: ["ignore", "ignore", "pipe"],
});
await new Promise((r) => setTimeout(r, 600));

console.log("volt tests");
console.log(`mock server on :${PORT}, isolated HOME ${HOME}\n`);

try {
  // 1. help
  const help = await run(["--help"]);
  check("help exits 0", help.code === 0, `code=${help.code}`);
  check("help mentions usage", /usage/i.test(help.stdout));
  check("help mentions --diff", help.stdout.includes("--diff"));

  // 2. version
  const ver = await run(["--version"]);
  check("version prints", /volt \d+\.\d+\.\d+/.test(ver.stdout));

  // 3. unknown flag
  const bad = await run(["--nope"]);
  check("unknown flag → exit 2", bad.code === 2);
  check("unknown flag error message", /unknown flag/.test(bad.stderr));

  // 4. basic ask (streaming, plain output)
  const ask = await run(["ask", "hello there"]);
  check("ask exits 0", ask.code === 0, `code=${ask.code}`);
  check("ask streams response", ask.stdout.includes("Hello from **mock**"));
  check("ask echoes prompt", ask.stdout.includes("hello there"));
  check("ask shows usage footer", /42→17 tok/.test(ask.stdout));

  // 5. positional prompt = ask
  const pos = await run(["hi there"]);
  check("bare prompt works", pos.code === 0 && pos.stdout.includes("hi there"));

  // 6. piped stdin as prompt
  const pipe = await run([], { input: "piped question" });
  check("piped stdin becomes prompt", pipe.code === 0 && pipe.stdout.includes("piped question"));

  // 7. JSON output
  const json = await run(["ask", "-j", "json mode"], {});
  check("json exits 0", json.code === 0);
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(json.stdout);
  } catch {
    /* not json */
  }
  check("json is valid", parsedJson !== null);
  check("json has content", parsedJson?.content?.includes("Hello from"));
  check(
    "json has usage",
    parsedJson?.usage?.input_tokens === 42 && parsedJson?.usage?.output_tokens === 17,
    `usage=${JSON.stringify(parsedJson?.usage)} stderr=${json.stderr.trim()}`
  );
  check("json has cost", typeof parsedJson?.costUsd === "number");

  // 8. context file
  const ctxFile = path.join(HOME, "note.txt");
  writeFileSync(ctxFile, "VOLT_SPECIAL_MARKER_123\n");
  const ctx = await run(["ask", "-c", ctxFile, "read the file"]);
  check("context file attached", ctx.stdout.includes("VOLT_SPECIAL_MARKER_123"));
  check("context file header", ctx.stdout.includes("### File:"));
  const missing = await run(["ask", "-c", "does-not-exist.txt", "q"]);
  check("missing file warns but works", missing.code === 0 && /file not found/.test(missing.stderr));

  // 9. git diff context
  const repo = path.join(HOME, "repo");
  mkdirSync(repo);
  const git = async (args) => {
    await new Promise((res) => {
      const c = spawn("git", args, { cwd: repo, stdio: "ignore" });
      c.on("close", res);
    });
  };
  await git(["init", "-q"]);
  writeFileSync(path.join(repo, "app.js"), "const x = 1;\n");
  await git(["add", "."]);
  await git(["-c", "user.name=volt", "-c", "user.email=volt@test.local", "commit", "-qm", "init"]);
  writeFileSync(path.join(repo, "app.js"), "const x = 2;\n");
  const diff = await run(["ask", "--diff", "explain"], { cwd: repo });
  check("git diff attached", diff.stdout.includes("Git diff"));

  // 10. retries: fail-key returns 503 twice then 200
  const retry = await run(["ask", "retry me"], { env: { VOLT_API_KEY: "fail-key" } });
  check("retry recovers from 503s", retry.code === 0 && retry.stdout.includes("Hello from"));

  // 11. network failure
  const netfail = await run(["ask", "boom"], {
    env: { VOLT_BASE_URL: "http://127.0.0.1:1/v1" },
  });
  check("network failure → exit 1", netfail.code === 1, `code=${netfail.code}`);
  check("network failure message", /error:/i.test(netfail.stderr));

  // 12. sessions: ask saves a session, sessions lists it
  const saved = await run(["ask", "-n", "my-test-session", "remember this"]);
  check("session save exits 0", saved.code === 0);
  const sessions = await run(["--sessions"]);
  check("sessions lists saved session", sessions.stdout.includes("my-test-session"));
  const show = await run(["sessions", "show", "my-test-session"]);
  check("sessions show renders", show.code === 0 && show.stdout.includes("Hello from"));

  // 13. models command
  const models = await run(["models"]);
  check("models lists mock model", models.stdout.includes("gpt-4o-mini"));

  // 14. doctor
  const doc = await run(["doctor"]);
  check("doctor exits 0", doc.code === 0);
  check("doctor reports connectivity", doc.stdout.includes("responded"));

  // 15. config set/get
  const cfgSet = await run(["config", "set", "temperature", "0.2"]);
  check("config set", cfgSet.code === 0 && /temperature = 0\.2/.test(cfgSet.stdout));
  const cfgGet = await run(["config", "get", "temperature"]);
  check("config get", cfgGet.stdout.trim() === "0.2");

  // 16. no-stream mode
  const nostream = await run(["ask", "--no-stream", "quiet please"]);
  check("no-stream works", nostream.code === 0 && nostream.stdout.includes("Streaming=false"));

  // 17. raw mode: no ANSI
  const raw = await run(["ask", "-r", "raw please"], { env: { ...BASE_ENV, NO_COLOR: "0", CI: "0" } });
  check("raw mode has no ANSI", !/\x1b\[/.test(raw.stdout));

  // 18. usage error: ask with no prompt
  const noprompt = await run(["ask"], { input: "" });
  check("ask without prompt → exit 2", noprompt.code === 2);

  // 19. interactive-ish: --new names a session via ask
  const fresh = await run(["ask", "--new", "brand new day"]);
  check("--new works", fresh.code === 0);

  // 20. REPL loop via piped lines: chat mode streams, slash commands work
  const repl = await run(["chat"], {
    input: "hello repl\n/model gpt-4o\n/cost\n/exit\n",
  });
  check("chat repl streams", repl.code === 0 && repl.stdout.includes("Hello from"));
  check("chat repl /model", repl.stdout.includes("model → gpt-4o"));
  check("chat repl /cost", /session: \d+→\d+ tokens/.test(repl.stdout));

  // 21. context-only ask gets a default prompt
  writeFileSync(path.join(HOME, "only.txt"), "just this\n");
  const ctxOnly = await run(["ask", "-c", path.join(HOME, "only.txt")]);
  check("context-only ask works", ctxOnly.code === 0 && ctxOnly.stdout.includes("just this"));

  // 22. FORCE_COLOR renders ANSI markdown + syntax highlighting
  // (env values are strings — unset flags with "" so they're falsy)
  const color = await run(["ask", "color check"], {
    env: { FORCE_COLOR: "", NO_COLOR: "", CI: "" },
  });
  const forced = await run(["ask", "color check"], {
    env: { FORCE_COLOR: "1", NO_COLOR: "", CI: "" },
  });
  check("FORCE_COLOR emits ANSI", /\x1b\[/.test(forced.stdout));
  check("FORCE_COLOR renders bold", /\x1b\[1m/.test(forced.stdout));
  check("FORCE_COLOR highlights code", /\x1b\[38;5;141m/.test(forced.stdout));
  check("no color when CI (default)", !/\x1b\[/.test(color.stdout));

  // 23. agent mode: tool call then final answer
  const agent = await run(["agent", "run TOOL_CALL:run_command:echo hi-from-tool then answer"]);
  check("agent completes", agent.code === 0 && agent.stdout.includes("Hello from"), `code=${agent.code}`);
  check("agent logs tool call", agent.stdout.includes("run_command") && agent.stdout.includes("hi-from-tool"));
  check("agent footer has steps", /2 steps · 1 tool call/.test(agent.stdout), agent.stdout.slice(-300));

  // 24. agent JSON: TOOL_LOOP makes the mock always call tools → max steps
  const agentJson = await run(["agent", "-j", "--steps", "3", "TOOL_LOOP task"]);
  let agentParsed = null;
  try {
    agentParsed = JSON.parse(agentJson.stdout);
  } catch {
    /* not json */
  }
  check("agent json valid", agentParsed !== null, agentJson.stdout.slice(0, 200));
  check("agent json steps capped", agentParsed?.steps === 3 && agentParsed?.toolCalls?.length === 3, `steps=${agentParsed?.steps} toolCalls=${agentParsed?.toolCalls?.length}`);
  check("agent json maxStepsReached", agentParsed?.maxStepsReached === true);

  // 25. agent refuses non-OpenAI providers
  const agentAnthropic = await run(["agent", "x"], {
    env: { VOLT_PROVIDER: "anthropic" },
  });
  check("agent rejects anthropic", agentAnthropic.code === 1 && /OpenAI-compatible/.test(agentAnthropic.stderr));

  // 26. template library
  const tplList = await run(["template", "list"]);
  check("builtin templates listed", tplList.code === 0 && tplList.stdout.includes("commit") && tplList.stdout.includes("review"));
  const tplSave = await run(["template", "save", "mytpl", "Answer like a pirate. {prompt}"]);
  check("template save", tplSave.code === 0 && tplSave.stdout.includes("mytpl"));
  const tplUse = await run(["ask", "--template", "mytpl", "hello matey"]);
  check("template applied to prompt", tplUse.code === 0 && tplUse.stdout.includes("Answer like a pirate"));
  const tplRm = await run(["template", "rm", "mytpl"]);
  check("template rm", tplRm.code === 0 && /deleted/.test(tplRm.stdout));

  // 27. chat /template applies a system prompt
  const tplChat = await run(["chat"], {
    input: "/template commit\nhello tpl\n/exit\n",
  });
  check("chat /template", tplChat.code === 0 && tplChat.stdout.includes('template "commit" applied') && tplChat.stdout.includes("System prompt present"));

  // 28. review: git diff in the test repo
  const rev = await run(["review", "--gate"], { cwd: repo });
  check("review diff runs", rev.code === 0 && rev.stdout.includes("Hello from"), `code=${rev.code}`);
  check("review shows findings count", /findings:/.test(rev.stdout));

  // 29. review: specific file
  const revFile = await run(["review", path.join(HOME, "note.txt")]);
  check("review file runs", revFile.code === 0 && revFile.stdout.includes("### File:"), `code=${revFile.code}`);

  // 30. review with nothing to review → exit 2
  const revNone = await run(["review"], { cwd: HOME });
  check("review no context → exit 2", revNone.code === 2, `code=${revNone.code}`);

  // 31. search across sessions
  const searchHit = await run(["search", "remember"]);
  check("search finds match", searchHit.code === 0 && searchHit.stdout.includes("my-test-session"));
  const searchMiss = await run(["search", "zzz-nothing-here"]);
  check("search miss message", searchMiss.code === 0 && /no matches/.test(searchMiss.stdout));

  // 32. compare: two models in parallel
  const cmp = await run(["compare", "-j", "-m", "gpt-4o-mini", "-m", "gpt-4o", "which one?"]);
  let cmpParsed = null;
  try {
    cmpParsed = JSON.parse(cmp.stdout);
  } catch {
    /* not json */
  }
  check("compare json is array of 2", Array.isArray(cmpParsed) && cmpParsed.length === 2, `n=${cmpParsed?.length}`);
  check("compare both answered", cmpParsed?.every((r) => r.content.includes("Hello from")));
  check("compare distinct models", cmpParsed?.[0]?.model !== cmpParsed?.[1]?.model);
  const cmpPlain = await run(["compare", "-m", "gpt-4o-mini", "-m", "gpt-4o", "which one?"]);
  check("compare plain shows both headers", cmpPlain.code === 0 && cmpPlain.stdout.includes("gpt-4o-mini") && cmpPlain.stdout.includes("gpt-4o"));

  // 33. compare with no models falls back to config model
  const cmpDefault = await run(["compare", "-j", "hi"]);
  let cmpDef = null;
  try {
    cmpDef = JSON.parse(cmpDefault.stdout);
  } catch {
    /* not json */
  }
  check("compare default model", Array.isArray(cmpDef) && cmpDef.length === 1 && cmpDef[0].model === "gpt-4o-mini");

  // 34. bench
  const bench = await run(["bench"]);
  check("bench exits 0", bench.code === 0, `code=${bench.code}`);
  check("bench reports round-trip", /round-trip/.test(bench.stdout) && /ms/.test(bench.stdout));
  const benchJson = await run(["bench", "-j"]);
  let benchParsed = null;
  try {
    benchParsed = JSON.parse(benchJson.stdout);
  } catch {
    /* not json */
  }
  check("bench json valid", benchParsed?.checks?.models?.ok === true && benchParsed?.checks?.roundTrip?.ok === true);

  // 35. sessions export
  const exportOut = await run(["sessions", "export", "my-test-session"]);
  check("sessions export markdown", exportOut.code === 0 && exportOut.stdout.includes("# Session: my-test-session") && exportOut.stdout.includes("## volt"));

  // 36. shell completions
  const compBash = await run(["completions", "bash"]);
  check("bash completions", compBash.code === 0 && compBash.stdout.includes("complete -F _volt volt"));
  const compZsh = await run(["completions", "zsh"]);
  check("zsh completions", compZsh.code === 0 && compZsh.stdout.includes("compdef _volt volt"));
  const compFish = await run(["completions", "fish"]);
  check("fish completions", compFish.code === 0 && compFish.stdout.includes("complete -c volt"));
  const compBad = await run(["completions", "powershell"]);
  check("completions bad shell", compBad.code === 1);

  // 37. tokens micro-tool
  const tok = await run(["tokens", "hello world"]);
  check("tokens count", tok.code === 0 && /^\d+ tokens · 11 chars/.test(tok.stdout), tok.stdout);
  const tokPipe = await run(["tokens"], { input: "piped text here" });
  check("tokens piped", tokPipe.code === 0 && /tokens/.test(tokPipe.stdout));

  // 38. context dry-run preview
  const ctxPrev = await run(["context", "-c", ctxFile, "my question"]);
  check("context preview lists block", ctxPrev.code === 0 && /tok/.test(ctxPrev.stdout) && /% of window/.test(ctxPrev.stdout), ctxPrev.stdout.slice(0, 200));
  const ctxJson = await run(["context", "-j", "-c", ctxFile, "my question"]);
  let ctxParsed = null;
  try {
    ctxParsed = JSON.parse(ctxJson.stdout);
  } catch {
    /* not json */
  }
  check("context json totals", ctxParsed?.totalTokens > 0 && ctxParsed?.window === 128000, `total=${ctxParsed?.totalTokens}`);

  // 39. image attachment (vision): a 1×1 PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const imgPath = path.join(HOME, "pixel.png");
  writeFileSync(imgPath, png);
  const img = await run(["ask", "-i", imgPath, "what is in this image?"]);
  check("image ask works", img.code === 0 && img.stdout.includes("Hello from"), `code=${img.code}`);
  const imgJson = await run(["ask", "-j", "-i", imgPath, "describe"]);
  let imgParsed = null;
  try {
    imgParsed = JSON.parse(imgJson.stdout);
  } catch {
    /* not json */
  }
  check("image json works", imgParsed?.content?.includes("Hello from"));
  const imgMissing = await run(["ask", "-i", "nope.png", "q"]);
  check("missing image warns but runs", imgMissing.code === 0 && /image not found/.test(imgMissing.stderr));

  // 40. REPL multi-line input: trailing backslash continues the prompt
  const multi = await run(["chat"], {
    input: "line one \\\nline two\n/exit\n",
  });
  check("repl multi-line continues", multi.code === 0 && /You asked: "line one\s+line two"/.test(multi.stdout), multi.stdout.slice(0, 300));

  // 41. /export in the REPL
  const exp = await run(["chat"], { input: "hello export me\n/export\n/exit\n" });
  check("repl /export markdown", exp.code === 0 && exp.stdout.includes("## you") && exp.stdout.includes("hello export me"));

  // 42. session rename
  const ren = await run(["sessions", "rename", "my-test-session", "renamed-sess"]);
  check("sessions rename", ren.code === 0 && /renamed/.test(ren.stdout), ren.stdout);
  const renList = await run(["--sessions"]);
  check("renamed session listed", renList.stdout.includes("renamed-sess"));
  const renBad = await run(["sessions", "rename", "ghost-sess", "x"]);
  check("rename missing session fails", renBad.code === 1);

  // 43. ask --continue resumes the latest session
  const cont = await run(["ask", "--continue", "follow up question"]);
  check("ask --continue works", cont.code === 0 && cont.stdout.includes("follow up question"));
  check("ask --continue note", /continuing session/.test(cont.stderr), cont.stderr);

  // 44. volt init scaffolds a project config
  const proj = path.join(HOME, "proj");
  mkdirSync(proj);
  const init = await run(["init"], { cwd: proj });
  const initCfg = JSON.parse(readFileSync(path.join(proj, ".volt.json"), "utf8"));
  check("init writes .volt.json", init.code === 0 && initCfg.provider === "openai" && initCfg.model === "gpt-4o-mini");
  const initAgain = await run(["init"], { cwd: proj });
  check("init refuses overwrite", initAgain.code === 1);

  // 45. plugins: a beforeSend hook injects a system message
  const pluginDir = path.join(HOME, ".volt", "plugins");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(pluginDir, "adder.js"),
    'export default { name: "adder", beforeSend(messages) { return [messages[0], { role: "system", content: "PLUGIN_INJECTED" }, ...messages.slice(1)]; } };\n'
  );
  const plug = await run(["ask", "plugin test"]);
  check("plugin beforeSend injects system", plug.code === 0 && plug.stdout.includes("System prompt present"), plug.stdout.slice(0, 200));

  // 46. doctor reports agent-mode readiness
  const doc2 = await run(["doctor"]);
  check("doctor agent readiness", doc2.code === 0 && doc2.stdout.includes("agent mode available"));

  // 47. cost report aggregates saved sessions
  const costJson = await run(["cost", "-j"]);
  let costParsed = null;
  try {
    costParsed = JSON.parse(costJson.stdout);
  } catch {
    /* not json */
  }
  check("cost json totals", costParsed?.totals?.inputTokens >= 42 && costParsed?.messages >= 1, JSON.stringify(costParsed?.totals));
  check("cost json per-model", costParsed?.perModel?.some((m) => m.model === "gpt-4o-mini"));
  const costPlain = await run(["cost"]);
  check("cost plain output", costPlain.code === 0 && costPlain.stdout.includes("gpt-4o-mini") && /msgs/.test(costPlain.stdout));

  // 48. history records prompts
  const hist = await run(["history"]);
  check("history lists prompts", hist.code === 0 && hist.stdout.includes("follow up question"));
  const histJson = await run(["history", "-j"]);
  let histParsed = null;
  try {
    histParsed = JSON.parse(histJson.stdout);
  } catch {
    /* not json */
  }
  check("history json is array", Array.isArray(histParsed?.entries) && histParsed.entries.length > 0);

  // 49. config unset
  const unset = await run(["config", "unset", "temperature"]);
  check("config unset", unset.code === 0 && /unset/.test(unset.stdout));
  const getUnset = await run(["config", "get", "temperature"]);
  check("config get after unset", /unset/.test(getUnset.stdout));

  // 50. volt login: one-shot saves the key + provider and verifies live
  // (clear VOLT_MODEL — login only auto-picks a default when none is set)
  const loginOk = await run(["login", "anthropic", "sk-ant-test123"], {
    env: { VOLT_MODEL: "" },
  });
  check("login exits 0", loginOk.code === 0, `code=${loginOk.code}`);
  check("login saved key message", loginOk.stdout.includes("saved key"), loginOk.stdout);
  check("login verified models", loginOk.stdout.includes("connected"), loginOk.stdout);
  const cfgAfterLogin = JSON.parse(
    readFileSync(path.join(HOME, ".volt", "config.json"), "utf8")
  );
  check(
    "login config persisted",
    cfgAfterLogin.provider === "anthropic" && cfgAfterLogin.api_key === "sk-ant-test123",
    JSON.stringify(cfgAfterLogin)
  );
  check("login picks smart default model", cfgAfterLogin.model === "gpt-4o-mini", `model=${cfgAfterLogin.model}`);
  check("login reports model", loginOk.stdout.includes("default model set"), loginOk.stdout);

  // 51. login when the API is unreachable: key saved, warning printed, exit 0
  const loginNet = await run(["login", "openai", "sk-abc"], {
    env: { VOLT_BASE_URL: "http://127.0.0.1:1/v1" },
  });
  check("login unreachable warns but saves", loginNet.code === 0 && /verification failed/.test(loginNet.stderr), loginNet.stderr);
  const cfgAfterNet = JSON.parse(
    readFileSync(path.join(HOME, ".volt", "config.json"), "utf8")
  );
  check("login kept second key", cfgAfterNet.provider === "openai" && cfgAfterNet.api_key === "sk-abc");

  // 52. login with no key and no TTY → usage error
  const loginNoKey = await run(["login"]);
  check("login no key → exit 2", loginNoKey.code === 2 && /usage: volt login/.test(loginNoKey.stderr), `code=${loginNoKey.code}`);

  // 53. volt logout removes the saved key
  const logout = await run(["logout"]);
  check("logout exits 0", logout.code === 0 && /logged out/.test(logout.stdout), logout.stdout);
  const cfgAfterOut = JSON.parse(
    readFileSync(path.join(HOME, ".volt", "config.json"), "utf8")
  );
  check("logout removed api_key", !("api_key" in cfgAfterOut));
  const logoutAgain = await run(["logout"]);
  check("logout idempotent", logoutAgain.code === 0 && /nothing to do/.test(logoutAgain.stdout));

  // 54. REPL /login and /logout
  const replLogin = await run(["chat"], {
    input: "/login anthropic sk-ant-repl\n/exit\n",
  });
  check(
    "repl /login works",
    replLogin.code === 0 && replLogin.stdout.includes("now using anthropic"),
    replLogin.stdout.slice(-300)
  );
  const cfgRepl = JSON.parse(readFileSync(path.join(HOME, ".volt", "config.json"), "utf8"));
  check(
    "repl /login saved key + provider",
    cfgRepl.api_key === "sk-ant-repl" && cfgRepl.provider === "anthropic",
    JSON.stringify(cfgRepl)
  );
  const replLogout = await run(["chat"], {
    input: "/logout\n/exit\n",
  });
  check("repl /logout works", replLogout.code === 0 && replLogout.stdout.includes("logged out"), replLogout.stdout.slice(-300));
  const cfgReplOut = JSON.parse(readFileSync(path.join(HOME, ".volt", "config.json"), "utf8"));
  check("repl /logout removed key", !("api_key" in cfgReplOut));

  // 55. agent grep tool finds a marker
  const markerFile = path.join(repo, "grepme.txt");
  writeFileSync(markerFile, "HELLO_GREP_MARKER_99\n");
  const agentGrep = await run(
    ["agent", 'TOOL_CALL:grep:{"pattern":"HELLO_GREP_MARKER_99"}'],
    { cwd: repo }
  );
  check(
    "agent grep finds matches",
    agentGrep.code === 0 && agentGrep.stdout.includes("HELLO_GREP_MARKER_99"),
    agentGrep.stdout.slice(-300)
  );

  // 56. agent glob tool finds files by pattern
  const agentGlob = await run(["agent", 'TOOL_CALL:glob:{"pattern":"*.txt"}'], { cwd: repo });
  check(
    "agent glob finds files",
    agentGlob.code === 0 && agentGlob.stdout.includes("grepme.txt"),
    agentGlob.stdout.slice(-300)
  );

  // 57. agent glob with **/ separators (Windows-safe path matching)
  const agentGlobDeep = await run(["agent", 'TOOL_CALL:glob:{"pattern":"**/*.txt"}'], {
    cwd: repo,
  });
  check(
    "agent glob deep pattern",
    agentGlobDeep.code === 0 && agentGlobDeep.stdout.includes("grepme.txt"),
    agentGlobDeep.stdout.slice(-300)
  );

  // 58. agent edit_file applies a targeted patch
  const editArgs = JSON.stringify({
    path: "app.js",
    old: "const x = 2;",
    new: "const x = 42; // agent-edited",
  });
  const agentEdit = await run(["agent", `TOOL_CALL:edit_file:${editArgs}`], { cwd: repo });
  check(
    "agent edit_file applies patch",
    agentEdit.code === 0 &&
      readFileSync(path.join(repo, "app.js"), "utf8").includes("const x = 42; // agent-edited"),
    agentEdit.stdout.slice(-300)
  );

  // 59. agent edit_file reports a miss
  const agentEditMiss = await run(
    ["agent", 'TOOL_CALL:edit_file:{"path":"app.js","old":"zzz-does-not-exist","new":"nope"}'],
    { cwd: repo }
  );
  check(
    "agent edit_file not-found reported",
    agentEditMiss.code === 0 && /not found/.test(agentEditMiss.stdout),
    agentEditMiss.stdout.slice(-300)
  );

  // 59. REPL /compact summarizes the older messages
  const compact = await run(["chat"], {
    input: "first compact line\nsecond compact line\n/compact\n/exit\n",
  });
  check(
    "repl /compact shrinks",
    compact.code === 0 && /compacted 2 messages/.test(compact.stdout),
    compact.stdout.slice(-400)
  );

  // 60. volt summarize a saved session
  const sum = await run(["summarize", "renamed-sess"]);
  check(
    "summarize session",
    sum.code === 0 &&
      sum.stdout.includes('summary of "renamed-sess"') &&
      sum.stdout.includes("Hello from"),
    sum.stdout.slice(0, 300)
  );
  const sumJson = await run(["summarize", "-j", "renamed-sess"]);
  let sumParsed = null;
  try {
    sumParsed = JSON.parse(sumJson.stdout);
  } catch {
    /* not json */
  }
  check(
    "summarize json",
    sumParsed?.session === "renamed-sess" &&
      typeof sumParsed?.summary === "string" &&
      sumParsed.summary.length > 0,
    sumJson.stdout.slice(0, 200)
  );
  check("summarize json usage", sumParsed?.usage?.input_tokens === 42);

  // 61. summarize a missing session → exit 2
  const sumMiss = await run(["summarize", "ghost-sess"]);
  check("summarize missing → exit 2", sumMiss.code === 2);

  // 62. stats dashboard
  const statsJson = await run(["stats", "-j"]);
  let statsParsed = null;
  try {
    statsParsed = JSON.parse(statsJson.stdout);
  } catch {
    /* not json */
  }
  check("stats json valid", statsParsed !== null);
  check("stats json sessions", statsParsed?.sessions >= 1 && statsParsed?.messages?.total >= 1, JSON.stringify(statsParsed?.sessions));
  check("stats json tokens", statsParsed?.tokens?.input >= 42, `input=${statsParsed?.tokens?.input}`);
  check("stats json per-model", statsParsed?.models?.some((m) => m.model === "gpt-4o-mini"));
  check("stats json activity", Array.isArray(statsParsed?.activity) && statsParsed.activity.length >= 1);
  const statsPlain = await run(["stats"]);
  check(
    "stats plain output",
    statsPlain.code === 0 && /per model/.test(statsPlain.stdout) && statsPlain.stdout.includes("gpt-4o-mini"),
    statsPlain.stdout.slice(0, 200)
  );

  // 63. upgrade check: new version via VOLT_UPGRADE_URL, up-to-date via an
  // inline server that serves the installed version, and local-source hint
  const upNew = await run(["upgrade", "--check"], {
    env: { VOLT_UPGRADE_URL: `http://127.0.0.1:${PORT}/latest` },
  });
  check(
    "upgrade finds new version",
    upNew.code === 0 && /new version available/.test(upNew.stdout),
    upNew.stdout
  );
  const currentVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const upServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: currentVersion }));
  });
  await new Promise((r) => upServer.listen(0, r));
  const upCurrent = await run(["upgrade", "--check"], {
    env: { VOLT_UPGRADE_URL: `http://127.0.0.1:${upServer.address().port}/latest` },
  });
  check("upgrade up-to-date", /up to date/.test(upCurrent.stdout), upCurrent.stdout);
  upServer.close();
  const upLocal = await run(["upgrade"]);
  check("upgrade local-source hint", upLocal.code === 0 && /local source/.test(upLocal.stdout), upLocal.stdout);
  check("upgrade never points at the npm name", !/npm install -g volt/.test(upNew.stdout + upLocal.stdout), upNew.stdout);
  // a GitHub "latest release" document (tag_name "v…") is understood too
  const ghServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v99.0.0", html_url: "https://example.invalid/r" }));
  });
  await new Promise((r) => ghServer.listen(0, r));
  const upGh = await run(["upgrade", "--check"], {
    env: { VOLT_UPGRADE_URL: `http://127.0.0.1:${ghServer.address().port}/releases/latest` },
  });
  ghServer.close();
  check(
    "upgrade reads a GitHub release tag",
    upGh.code === 0 && /new version available: 99\.0\.0/.test(upGh.stdout) && /git pull/.test(upGh.stdout),
    upGh.stdout
  );

  // 64. sessions -j
  const sessJson = await run(["sessions", "-j"]);
  let sessParsed = null;
  try {
    sessParsed = JSON.parse(sessJson.stdout);
  } catch {
    /* not json */
  }
  check(
    "sessions json array",
    Array.isArray(sessParsed) && sessParsed.some((s) => s.name === "renamed-sess"),
    sessJson.stdout.slice(0, 200)
  );

  // 65. REPL /models lists provider models
  const replModels = await run(["chat"], { input: "/models\n/exit\n" });
  check(
    "repl /models lists models",
    replModels.code === 0 && replModels.stdout.includes("gpt-4o-mini"),
    replModels.stdout.slice(-300)
  );

  // 66. config -j sanitized effective config (never leaks the key)
  const cfgJson = await run(["config", "-j"]);
  let cfgParsed = null;
  try {
    cfgParsed = JSON.parse(cfgJson.stdout);
  } catch {
    /* not json */
  }
  check(
    "config -j valid",
    cfgParsed?.provider === "openai" && cfgParsed?.model === "gpt-4o-mini",
    cfgJson.stdout.slice(0, 200)
  );
  check("config -j hides key", !cfgJson.stdout.includes("sk-") && cfgParsed?.hasApiKey === true);

  // 67. login refuses Claude Code subscription tokens (sk-ant-oat01-…)
  const ccToken = await run(["login", "anthropic", "sk-ant-oat01-abc123"]);
  check(
    "login rejects claude code token",
    ccToken.code === 1 && /Claude Code subscription token/.test(ccToken.stderr),
    `code=${ccToken.code} stderr=${ccToken.stderr.trim()}`
  );
  const cfgAfterCC = JSON.parse(
    readFileSync(path.join(HOME, ".volt", "config.json"), "utf8")
  );
  check(
    "login rejected token not saved",
    cfgAfterCC.api_key !== "sk-ant-oat01-abc123",
    JSON.stringify(cfgAfterCC)
  );
  const ccSession = await run(["login", "anthropic", "sk-ant-session-xyz"]);
  check(
    "login rejects session token too",
    ccSession.code === 1 && /sk-ant-api/.test(ccSession.stderr),
    `code=${ccSession.code}`
  );

  // 68-76. Local provider extensions (gitignored "<name>.local/" dirs at the
  // repo root) may ship their own tests.js; run them here with the shared
  // helpers. A fresh clone has none, so these checks are skipped.
  for (const dir of LOCAL_DIRS) {
    const t = path.join(dir, "tests.js");
    if (!existsSync(t)) continue;
    const mod = await import(pathToFileURL(t).href);
    await mod.default({ run, check, ROOT, HOME, PORT });
  }

  // 77. volt install claude: slash commands + Stop hook + skill merged into ~/.claude
  const claudeRoot = path.join(HOME, ".claude");
  mkdirSync(claudeRoot, { recursive: true });
  writeFileSync(path.join(claudeRoot, "settings.json"), JSON.stringify({ theme: "dark" }) + "\n");
  const hookMatch = (s) =>
    Array.isArray(s?.hooks?.Stop) &&
    s.hooks.Stop.some(
      (m) => Array.isArray(m?.hooks) && m.hooks.some((h) => h?.command.includes("sync.js"))
    );
  const ccInst = await run(["install", "claude"]);
  check("install claude exits 0", ccInst.code === 0, `code=${ccInst.code}`);
  const commandsDir = path.join(claudeRoot, "commands");
  check(
    "install writes slash commands",
    existsSync(path.join(commandsDir, "volt-commit.md")) &&
      existsSync(path.join(commandsDir, "volt-review.md")),
    readdirSync(commandsDir).join(",")
  );
  const cmdBody = readFileSync(path.join(commandsDir, "volt-commit.md"), "utf8");
  check(
    "command body embeds template",
    /commit message/i.test(cmdBody) && /allowed-tools/.test(cmdBody),
    cmdBody.slice(0, 200)
  );
  const ccSettings = JSON.parse(readFileSync(path.join(claudeRoot, "settings.json"), "utf8"));
  check("install wires stop hook", hookMatch(ccSettings), JSON.stringify(ccSettings.hooks));
  check("install preserves existing settings", ccSettings.theme === "dark", JSON.stringify(ccSettings));
  check("install writes skill", existsSync(path.join(claudeRoot, "skills", "volt", "SKILL.md")));
  const syncJs = path.join(HOME, ".volt", "claude", "sync.js");
  check("install writes hook entry", existsSync(syncJs));
  await run(["install", "claude"]);
  const ccSettings2 = JSON.parse(readFileSync(path.join(claudeRoot, "settings.json"), "utf8"));
  const dupMatches = ccSettings2.hooks.Stop.filter(
    (m) => Array.isArray(m?.hooks) && m.hooks.some((h) => h?.command.includes("sync.js"))
  );
  check("install is idempotent", dupMatches.length === 1, JSON.stringify(ccSettings2.hooks));

  // 78. the Stop hook syncs Claude Code usage into VOLT's ledger
  const projDir = path.join(claudeRoot, "projects", "fake-proj");
  mkdirSync(projDir, { recursive: true });
  const sessId = "abc-1234-5678-def0";
  const transcript = path.join(projDir, sessId + ".jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: "user",
        message: { id: "user-1", role: "user", content: [{ type: "text", text: "CLAUDE_SEARCH_MARKER_42" }] },
        session_id: sessId,
        timestamp: "2026-08-10T12:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "hello from claude code" }],
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: sessId,
        timestamp: "2026-08-10T12:00:01Z",
      }),
    ].join("\n") + "\n"
  );
  const hookPayload = JSON.stringify({
    session_id: sessId,
    transcript_path: transcript,
    cwd: "C:\\fake\\fake-proj",
  });
  const costBefore = await run(["cost", "-j"]);
  let costBeforeParsed = null;
  try {
    costBeforeParsed = JSON.parse(costBefore.stdout);
  } catch {
    /* not json */
  }
  const hookRun = await runNode(syncJs, hookPayload);
  check("hook runs clean", hookRun.code === 0, hookRun.stderr);
  const costAfter = await run(["cost", "-j"]);
  let costAfterParsed = null;
  try {
    costAfterParsed = JSON.parse(costAfter.stdout);
  } catch {
    /* not json */
  }
  check(
    "ledger includes claude usage",
    costAfterParsed?.totals?.inputTokens === (costBeforeParsed?.totals?.inputTokens ?? 0) + 100 &&
      costAfterParsed?.perModel?.some((m) => m.model === "claude-sonnet-4-5" && m.messages >= 1),
    JSON.stringify(costAfterParsed?.totals)
  );
  const statsAfter = await run(["stats", "-j"]);
  let statsAfterParsed = null;
  try {
    statsAfterParsed = JSON.parse(statsAfter.stdout);
  } catch {
    /* not json */
  }
  check(
    "stats include claude session",
    statsAfterParsed?.sessions >= 1 &&
      statsAfterParsed?.models?.some((m) => m.model === "claude-sonnet-4-5"),
    JSON.stringify(statsAfterParsed?.sessions)
  );
  const searchAfter = await run(["search", "CLAUDE_SEARCH_MARKER_42"]);
  check(
    "search finds claude content",
    searchAfter.code === 0 && searchAfter.stdout.includes("CLAUDE_SEARCH_MARKER_42"),
    searchAfter.stdout.slice(0, 200)
  );
  await runNode(syncJs, hookPayload); // second stop of the same session
  const costAgain = await run(["cost", "-j"]);
  let costAgainParsed = null;
  try {
    costAgainParsed = JSON.parse(costAgain.stdout);
  } catch {
    /* not json */
  }
  check(
    "hook is idempotent",
    costAgainParsed?.totals?.inputTokens === costAfterParsed?.totals?.inputTokens,
    `before=${costAfterParsed?.totals?.inputTokens} after=${costAgainParsed?.totals?.inputTokens}`
  );

  // 79. utility commands give Claude Code one-key access to the ledger
  for (const u of ["volt-cost", "volt-stats", "volt-search"]) {
    check(
      `install writes ${u} utility`,
      existsSync(path.join(commandsDir, u + ".md")),
      `missing ${u}.md`
    );
  }
  const searchBody = readFileSync(path.join(commandsDir, "volt-search.md"), "utf8");
  check(
    "volt-search embeds query placeholder",
    /{args}/.test(searchBody) && /volt search/.test(searchBody),
    searchBody.slice(0, 200)
  );

  // 80. saving a template auto-syncs a /volt-<name> command into Claude Code
  const tplSync = await run(["template", "save", "mytpl", "Do the thing: {prompt}"]);
  check("template save exits 0", tplSync.code === 0, `code=${tplSync.code}`);
  check(
    "template save syncs command",
    tplSync.stdout.includes("/volt-mytpl") &&
      existsSync(path.join(commandsDir, "volt-mytpl.md")) &&
      /Do the thing/.test(readFileSync(path.join(commandsDir, "volt-mytpl.md"), "utf8")),
    tplSync.stdout.slice(0, 300)
  );
  const tplSyncRm = await run(["template", "rm", "mytpl"]);
  check(
    "template rm removes its command",
    tplSyncRm.code === 0 && !existsSync(path.join(commandsDir, "volt-mytpl.md")),
    tplSyncRm.stdout
  );

  // 80b. commands the user edited by hand (or created) are never clobbered
  const commitPath = path.join(commandsDir, "volt-commit.md");
  appendFileSync(commitPath, "\n<!-- MY_EDIT_MARKER -->\n");
  writeFileSync(
    path.join(commandsDir, "volt-handmade.md"),
    "---\ndescription: my own\n---\n\nmy custom thing\n"
  );
  const tplSave2 = await run(["template", "save", "another", "another {prompt}"]);
  check(
    "sync preserves hand-edited commands",
    readFileSync(commitPath, "utf8").includes("MY_EDIT_MARKER") &&
      existsSync(path.join(commandsDir, "volt-handmade.md")),
    tplSave2.stdout.slice(0, 200)
  );
  check(
    "sync warns about modified files",
    /edited by hand/.test(tplSave2.stderr),
    tplSave2.stderr
  );
  const tplRm2 = await run(["template", "rm", "another"]);
  check(
    "rm cleans up only volt-owned files",
    !existsSync(path.join(commandsDir, "volt-another.md")) &&
      existsSync(path.join(commandsDir, "volt-handmade.md")),
    tplRm2.stdout
  );

  // 81. volt uninstall claude removes everything, keeps other settings
  const ccUn = await run(["uninstall", "claude"]);
  check("uninstall exits 0", ccUn.code === 0, `code=${ccUn.code}`);
  check("uninstall removes commands", !existsSync(path.join(commandsDir, "volt-commit.md")));
  check("uninstall removes utilities", !existsSync(path.join(commandsDir, "volt-cost.md")));
  check("uninstall removes skill", !existsSync(path.join(claudeRoot, "skills", "volt")));
  check("uninstall removes hook entry", !existsSync(syncJs));
  const ccSettings3 = JSON.parse(readFileSync(path.join(claudeRoot, "settings.json"), "utf8"));
  check("uninstall removes hook config", !hookMatch(ccSettings3), JSON.stringify(ccSettings3.hooks));
  check("uninstall preserves settings", ccSettings3.theme === "dark", JSON.stringify(ccSettings3));
  const unAgain = await run(["uninstall", "claude"]);
  check(
    "uninstall idempotent",
    unAgain.code === 0 && /nothing to uninstall/.test(unAgain.stdout),
    unAgain.stdout
  );

  // 82. with the integration uninstalled, template changes don't resurrect commands
  const ghostTpl = await run(["template", "save", "ghosttpl", "ghost {prompt}"]);
  check(
    "no sync when not installed",
    ghostTpl.code === 0 && !existsSync(path.join(commandsDir, "volt-ghosttpl.md")),
    ghostTpl.stdout
  );

  // 83. API-key path for Claude, with no local provider extension loaded
  // fresh HOME so config saved by earlier tests can't pick the provider
  const keyHome = mkdtempSync(path.join(os.tmpdir(), "volt-test-key-"));
  const noSub = { VOLT_LOCAL_PROVIDERS: "", HOME: keyHome, USERPROFILE: keyHome };
  const noKeys = {
    ...noSub,
    VOLT_API_KEY: "",
    VOLT_ANTHROPIC_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    VOLT_PROVIDER: "anthropic",
  };
  const subLogin = await run(["login", "claude"], { env: noSub });
  check(
    "no extension: login claude is an unknown provider",
    subLogin.code === 2 && /unknown provider "claude"/.test(subLogin.stderr),
    `code=${subLogin.code} ${subLogin.stderr.trim()}`
  );
  const subHelp = await run(["--help"], { env: noSub });
  check(
    "no extension: help has no subscription login",
    subHelp.code === 0 && !/volt login claude/.test(subHelp.stdout) && !/subscription/i.test(subHelp.stdout)
  );
  const noKeyAsk = await run(["hi"], { env: noKeys });
  check(
    "anthropic without key: clear message before any call",
    noKeyAsk.code !== 0 && /no Anthropic API key set/.test(noKeyAsk.stderr),
    `code=${noKeyAsk.code} ${noKeyAsk.stderr.trim()}`
  );
  const noKeyCfg = await run(["config"], { env: noKeys });
  check(
    "config status shows missing Anthropic key",
    /auth:\s+MISSING: no Anthropic API key/.test(noKeyCfg.stdout),
    noKeyCfg.stdout
  );
  const noKeyDoc = await run(["doctor"], { env: noKeys });
  check("doctor shows missing Anthropic key", /no Anthropic API key set/.test(noKeyDoc.stdout), noKeyDoc.stdout);
  const envKey = {
    ...noKeys,
    ANTHROPIC_API_KEY: "test-anthropic-env-key",
    VOLT_PROVIDER: "",
    VOLT_BASE_URL: "",
    VOLT_MODEL: "",
  };
  const envKeyCfg = await run(["config", "-j"], { env: envKey });
  let envKeyParsed = null;
  try {
    envKeyParsed = JSON.parse(envKeyCfg.stdout);
  } catch {
    /* not json */
  }
  check(
    "ANTHROPIC_API_KEY alone selects anthropic with a key",
    envKeyParsed?.provider === "anthropic" &&
      envKeyParsed?.hasApiKey === true &&
      !envKeyCfg.stdout.includes("test-anthropic-env-key"),
    envKeyCfg.stdout.slice(0, 200)
  );
  const envKeyStatus = await run(["config"], { env: envKey });
  check(
    "config status: key set, value never printed",
    /auth:\s+api key set/.test(envKeyStatus.stdout) && !envKeyStatus.stdout.includes("test-anthropic-env-key"),
    envKeyStatus.stdout
  );

  // Usage honesty: streaming asks for usage (stream_options.include_usage);
  // a provider that sends none is shown and saved as unknown, never as 0/$0.
  const soStream = await run(["SHOW_SO hi"]);
  check(
    "stream requests ask for usage (stream_options.include_usage)",
    soStream.code === 0 && soStream.stdout.includes('StreamOptions={"include_usage":true}') && /42→17 tok/.test(soStream.stdout),
    soStream.stdout.slice(-300)
  );
  const soBatch = await run(["--no-stream", "SHOW_SO hi"]);
  check("non-stream requests send no stream_options", soBatch.code === 0 && soBatch.stdout.includes("StreamOptions=none"), soBatch.stdout.slice(-200));
  const soReject = await run(["REJECT_SO SHOW_SO hi"]);
  check(
    "server rejecting stream_options gets a retry without it",
    soReject.code === 0 && soReject.stdout.includes("StreamOptions=none"),
    soReject.stdout.slice(-200) + soReject.stderr.slice(0, 200)
  );
  const noUse = await run(["NO_USAGE hi"]);
  check(
    "ask: missing usage shows 'not reported', not 0→0/$0.00",
    noUse.code === 0 && /usage not reported by provider · cost unknown/.test(noUse.stdout) && !/0→0 tok/.test(noUse.stdout) && !/\$0\.00/.test(noUse.stdout),
    noUse.stdout.slice(-200)
  );
  const noUseJson = await run(["ask", "-j", "NO_USAGE hi"]);
  let noUseParsed = null;
  try {
    noUseParsed = JSON.parse(noUseJson.stdout);
  } catch {
    /* not json */
  }
  check(
    "ask -j: missing usage is usageReported:false, costUsd null",
    noUseParsed?.usageReported === false && noUseParsed?.costUsd === null && noUseParsed?.usage === null,
    noUseJson.stdout.slice(0, 200)
  );
  const noUseAgent = await run(["agent", "run TOOL_CALL:run_command:echo no-usage-tool then answer NO_USAGE"]);
  check(
    "agent: missing usage shows 'not reported', not 0→0/$0.00",
    noUseAgent.code === 0 && /usage not reported by provider · cost unknown/.test(noUseAgent.stdout) && !/0→0 tok/.test(noUseAgent.stdout),
    noUseAgent.stdout.slice(-300)
  );
  const usageHome = mkdtempSync(path.join(os.tmpdir(), "volt-test-usage-"));
  const usageEnv = { HOME: usageHome, USERPROFILE: usageHome };
  await run(["-n", "measured", "hi"], { env: usageEnv });
  await run(["-n", "unmeasured", "NO_USAGE hi"], { env: usageEnv });
  const ledgerJson = await run(["cost", "-j"], { env: usageEnv });
  let ledger = null;
  try {
    ledger = JSON.parse(ledgerJson.stdout);
  } catch {
    /* not json */
  }
  const unmeasuredFile = path.join(usageHome, ".volt", "sessions", "unmeasured.jsonl");
  const unmeasuredRaw = existsSync(unmeasuredFile) ? readFileSync(unmeasuredFile, "utf8") : "";
  check(
    "ledger saves missing usage as unknown (reported:false, cost null)",
    /"reported":false/.test(unmeasuredRaw) && /"cost_usd":null/.test(unmeasuredRaw),
    unmeasuredRaw.slice(-300)
  );
  check(
    "cost -j counts unreported messages and keeps them out of totals",
    ledger?.unreportedMessages === 1 && ledger?.messages === 2 && ledger?.totals?.inputTokens === 42,
    ledgerJson.stdout.slice(0, 300)
  );
  const ledgerText = await run(["cost"], { env: usageEnv });
  check("cost notes unreported messages", /1 message had no usage from the provider/.test(ledgerText.stdout), ledgerText.stdout);
  const usageStatsJson = await run(["stats", "-j"], { env: usageEnv });
  let usageStatsParsed = null;
  try {
    usageStatsParsed = JSON.parse(usageStatsJson.stdout);
  } catch {
    /* not json */
  }
  check("stats -j counts unreported messages", usageStatsParsed?.unreportedMessages === 1, usageStatsJson.stdout.slice(0, 200));
} finally {
  mock.kill("SIGKILL");
}

console.log(`\n${failed ? `✘ ${failed} failed` : `✔ all ${passed} passed`}`);
if (failures.length) console.log("failures: " + failures.join(", "));
process.exit(failed ? 1 : 0);
