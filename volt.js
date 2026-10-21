#!/usr/bin/env node
// ⚡ VOLT — a terminal AI copilot.
// Entry point. All logic lives in src/.
import { main } from "./src/cli.js";

// Exit cleanly when the downstream pipe closes early (e.g. `volt … | head`).
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.stderr.on("error", () => {
  /* ignore */
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
