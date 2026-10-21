// VOLT — zero-dependency mock OpenAI-compatible server for tests.
// Usage: node test/mock-server.js [port]
// Behavior:
//   GET  /v1/models              → model list
//   POST /v1/chat/completions    → streamed or batched reply (echoes request info)
//   Authorization: Bearer fail-key → 503 twice, then 200 (tests retry logic)
import http from "node:http";

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8799);
const MODEL = process.env.MOCK_MODEL || "gpt-4o-mini";
let failCount = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/latest" && req.method === "GET") {
      // upgrade-check endpoint (VOLT_UPGRADE_URL override)
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: process.env.MOCK_UPGRADE_VERSION || "9.9.9" }));
      return;
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
      return;
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const auth = req.headers.authorization || "";
      if (auth === "Bearer fail-key") {
        failCount++;
        if (failCount < 3) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "boom (retry me)" } }));
          return;
        }
      }

      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        /* empty */
      }
      const stream = Boolean(parsed.stream);
      const lastUser = [...(parsed.messages || [])]
        .reverse()
        .find((m) => m.role === "user");
      const sys = (parsed.messages || []).find((m) => m.role === "system");
      const promptText = String(lastUser?.content || "").slice(0, 200);

      // Usage-reporting simulation:
      //   NO_USAGE anywhere in the conversation -> never send usage (like a
      //   provider that ignores stream_options); REJECT_SO -> 400 when the
      //   request carries stream_options; SHOW_SO -> echo what was sent.
      const anyMsg = (marker) => (parsed.messages || []).some((m) => String(m.content || "").includes(marker));
      if (promptText.includes("REJECT_SO") && parsed.stream_options) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }));
        return;
      }

      // Agent-mode tool simulation:
      //   TOOL_CALL:<name>:<args json or text> in the LAST user message → one tool call,
      //   then a normal reply on the next round (marker only checked in last msg).
      //   TOOL_LOOP anywhere in history → always answer with a tool call
      //   (exercises the agent's max-steps guard).
      const msgs = parsed.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      const alwaysTool = msgs.some((m) =>
        String(m.content || "").includes("TOOL_LOOP")
      );
      // TOOL_CALL fires only when the conversation's last message is a plain
      // user turn (after the tool result round it must behave normally).
      const toolMarker =
        lastMsg?.role === "user"
          ? /TOOL_CALL:([A-Za-z_]+):(.*)/.exec(String(lastUser?.content || ""))
          : null;
      const wantsTool = alwaysTool || Boolean(toolMarker);
      const toolName = toolMarker ? toolMarker[1] : "run_command";
      let toolArgs = toolMarker
        ? toolMarker[2]
        : JSON.stringify({ command: "echo looping-tool" });
      if (toolMarker) {
        try {
          toolArgs = JSON.stringify(JSON.parse(toolArgs));
        } catch {
          toolArgs = JSON.stringify({ command: toolArgs });
        }
      }

      const reply =
        `Hello from **mock**! You asked: "${promptText}". ` +
        `System prompt ${sys ? "present" : "absent"}. ` +
        `Streaming=${stream}. ` +
        `Here is a code block:\n` +
        "```js\nconst answer = 42;\nconsole.log(answer);\n```\n" +
        `And a table:\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.` +
        (promptText.includes("SHOW_SO")
          ? ` StreamOptions=${parsed.stream_options ? JSON.stringify(parsed.stream_options) : "none"}`
          : "");

      const usage = anyMsg("NO_USAGE")
        ? undefined
        : { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 };

      if (wantsTool) {
        const toolCallMsg = {
          id: "call_1",
          type: "function",
          function: { name: toolName, arguments: toolArgs },
        };
        if (stream) {
          // streamed tool call (real providers send delta.tool_calls fragments)
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(
            `data: ${JSON.stringify({
              id: "mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { tool_calls: [toolCallMsg] } }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              id: "mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {} }],
              usage,
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "mock",
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [toolCallMsg],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage,
            })
          );
        }
        return;
      }

      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const words = reply.split(" ");
        let i = 0;
        const sendChunk = () => {
          if (i < words.length) {
            res.write(
              `data: ${JSON.stringify({
                id: "mock",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { content: words[i] + " " } }],
              })}\n\n`
            );
            i++;
            setTimeout(sendChunk, 3);
          } else {
            res.write(
              `data: ${JSON.stringify({
                id: "mock",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {} }],
                usage,
              })}\n\n`
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
        };
        sendChunk();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock",
            object: "chat.completion",
            choices: [
              { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
            ],
            usage,
          })
        );
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
});

server.listen(PORT, () => {
  console.error(`mock server listening on :${PORT}`);
});
