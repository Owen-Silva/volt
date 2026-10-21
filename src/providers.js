// VOLT — provider layer: OpenAI-compatible + Anthropic Messages.
// Streaming over SSE, exponential-backoff retries on transient errors.
import { sleep, ApiError, missingAnthropicKeyMessage } from "./util.js";
import { extensionForFamily } from "./local-providers.js";

export { ApiError };


const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function backoffMs(attempt, retryAfter) {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 15000);
  }
  return Math.min(1000 * 2 ** attempt, 10000) + Math.random() * 200;
}

// Abort-aware sleep so Ctrl+C interrupts retry backoff immediately.
function sleepAbortable(ms, signal) {
  if (!signal) return sleep(ms);
  return new Promise((resolve) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeBaseUrl(provider) {
  let base = String(provider.baseUrl || "").replace(/\/+$/, "");
  if (!base) {
    throw new ApiError(
      0,
      `No base URL configured for provider "${provider.name}".\n  hint: set VOLT_BASE_URL or add "providers.${provider.name}.base_url" to ~/.volt/config.json`
    );
  }
  if (provider.family === "anthropic" && !base.endsWith("/v1")) base += "/v1";
  return base;
}

function requestHeaders(provider) {
  const h = { "content-type": "application/json" };
  if (provider.apiKey) {
    if (provider.family === "anthropic") {
      h["x-api-key"] = provider.apiKey;
      h["anthropic-version"] = "2023-06-01";
    } else {
      h.authorization = `Bearer ${provider.apiKey}`;
    }
  }
  return h;
}

function splitSystem(messages) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  return { system: system || undefined, messages: messages.filter((m) => m.role !== "system") };
}

export async function chat({
  provider,
  model,
  messages,
  temperature,
  maxTokens,
  stream = true,
  signal,
  onDelta,
  onUsage,
  tools,
  onToolCalls,
}) {
  // A local provider extension (src/local-providers.js) handles its own
  // family. Everything else in this file assumes an HTTP API.
  const ext = extensionForFamily(provider.family);
  if (ext) return ext.chat({ messages, signal, onDelta, onUsage });
  // Anthropic API-key path: fail early with a clear message instead of a 401.
  if (provider.family === "anthropic" && !provider.apiKey) {
    throw new ApiError(0, missingAnthropicKeyMessage());
  }
  const url =
    provider.family === "anthropic"
      ? `${normalizeBaseUrl(provider)}/messages`
      : `${normalizeBaseUrl(provider)}/chat/completions`;

  const body =
    provider.family === "anthropic"
      ? {
          model,
          max_tokens: maxTokens || 4096,
          temperature,
          stream,
          ...splitSystem(messages),
        }
      : {
          model,
          temperature,
          stream,
          // ask for the final usage chunk; without it many OpenAI-compatible
          // servers (Gemini, OpenAI itself) stream no token counts at all
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          max_tokens: maxTokens,
          messages,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        };

  const attempts = 3;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: requestHeaders(provider),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      if (attempt < attempts - 1) {
        await sleepAbortable(backoffMs(attempt + 1), signal);
        continue;
      }
      throw new ApiError(0, `network error: ${err.message}`);
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      // a server that rejects stream_options gets the request again without
      // it; usage is then reported as missing rather than as zero
      if ((res.status === 400 || res.status === 422) && body.stream_options && /stream_options/i.test(raw)) {
        delete body.stream_options;
        attempt--;
        continue;
      }
      let msg = raw;
      try {
        msg = JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message || raw;
      } catch {
        /* keep raw */
      }
      if (RETRYABLE.has(res.status) && attempt < attempts - 1) {
        await sleepAbortable(backoffMs(attempt + 1, res.headers.get("retry-after")), signal);
        continue;
      }
      const hint =
        res.status === 401 || res.status === 403
          ? `\n  hint: check VOLT_API_KEY${
              provider.api_key_env && provider.api_key_env !== "VOLT_API_KEY"
                ? ` / ${provider.api_key_env}`
                : ""
            } and the "${provider.name}" provider config`
          : "";
      throw new ApiError(
        res.status,
        `api error ${res.status}: ${String(msg).slice(0, 400)}${hint}`,
        raw
      );
    }

    if (!stream) {
      const json = await res.json().catch(() => ({}));
      // Anthropic batches return { content: [{ type: "text", text }] } — map
      // both shapes onto a uniform message so non-streaming works everywhere.
      const msg =
        provider.family === "anthropic"
          ? {
              content: Array.isArray(json.content)
                ? json.content.map((p) => (typeof p === "string" ? p : p.text || "")).join("")
                : "",
              tool_calls: null,
            }
          : (json.choices?.[0]?.message ?? {});
      const content = msg.content ?? "";
      const usage = json.usage
        ? {
            input_tokens: json.usage.input_tokens ?? json.usage.prompt_tokens ?? 0,
            output_tokens: json.usage.output_tokens ?? json.usage.completion_tokens ?? 0,
            reported: true,
          }
        : { input_tokens: 0, output_tokens: 0, reported: false };
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.map((tc) => ({
            id: tc.id || "",
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "",
            raw: tc,
          }))
        : null;
      if (toolCalls?.length) onToolCalls?.(toolCalls, msg);
      onDelta?.(content);
      onUsage?.(usage);
      return;
    }

    await consumeSse(res, provider, onDelta, onUsage, onToolCalls);
    return;
  }
}

async function consumeSse(res, provider, onDelta, onUsage, onToolCalls) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  // reported flips to true only when the provider actually sends token counts
  const usage = { input_tokens: 0, output_tokens: 0, reported: false };
  const toolCalls = new Map(); // index → { id, name, arguments }

  const flushToolCalls = () => {
    if (!toolCalls.size) return;
    const entries = [...toolCalls.values()].map((e) => ({
      id: e.id,
      name: e.name,
      arguments: e.arguments,
      raw: { id: e.id, type: "function", function: { name: e.name, arguments: e.arguments } },
    }));
    onToolCalls?.(entries, {
      role: "assistant",
      content,
      tool_calls: entries.map((e) => e.raw),
    });
  };

  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new ApiError(0, `stream interrupted: ${err.message}`);
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        onUsage?.(usage);
        flushToolCalls();
        return;
      }
      if (!payload) continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (provider.family === "anthropic") {
        if (json.type === "message_start" && json.message?.usage) {
          usage.input_tokens = json.message.usage.input_tokens || 0;
          usage.reported = true;
        } else if (
          json.type === "content_block_delta" &&
          json.delta?.text
        ) {
          content += json.delta.text;
          onDelta?.(json.delta.text);
        } else if (json.type === "message_delta" && json.usage) {
          usage.output_tokens = json.usage.output_tokens || 0;
          usage.reported = true;
        }
      } else {
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        // streamed tool calls arrive as fragments across chunks, keyed by index
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const entry = toolCalls.get(idx) || { id: "", name: "", arguments: "" };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            // most providers stream argument fragments; if one resends the
            // cumulative string instead, replace rather than double-append
            if (tc.function?.arguments) {
              const frag = tc.function.arguments;
              if (
                entry.arguments &&
                frag.length > entry.arguments.length &&
                frag.startsWith(entry.arguments)
              ) {
                entry.arguments = frag;
              } else {
                entry.arguments += frag;
              }
            }
            toolCalls.set(idx, entry);
          }
        }
        if (json.usage) {
          usage.input_tokens = json.usage.prompt_tokens || 0;
          usage.output_tokens = json.usage.completion_tokens || 0;
          usage.reported = true;
        }
      }
    }
  }
  flushToolCalls();
  onUsage?.(usage);
}

export async function fetchModels(provider) {
  const ext = extensionForFamily(provider.family);
  if (ext) throw new ApiError(0, ext.modelsError || `"${provider.name}" has no model list`);
  const res = await fetch(`${normalizeBaseUrl(provider)}/models`, {
    headers: requestHeaders(provider),
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `could not list models (${res.status})${res.status === 401 ? " — check your API key" : ""}`
    );
  }
  const json = await res.json();
  return json.data?.map((m) => m.id).filter(Boolean) ?? [];
}
