import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexText,
  safeModel,
  safeTimeout,
  safeMaxTokens,
  selectProvider,
  selectWorkers,
  OpenAICompatProvider,
  probeOllamaNumCtx,
  __resetAvailabilityCacheForTests,
} from "../src/synthesis/provider.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

test("extractCodexText returns the LAST assistant text from codex --json JSONL", () => {
  const jsonl = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"type":"reasoning","text":"thinking out loud"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"FINAL ANSWER"}}',
    '{"type":"turn.completed"}',
  ].join("\n");
  assert.equal(extractCodexText(jsonl), "FINAL ANSWER");
});

test("extractCodexText tolerates partial/garbage lines and trailing CRLF", () => {
  const out = 'noise\r\n{"item":{"text":"one"}}\r\nnot json {\r\n{"text":"two"}\r\n';
  assert.equal(extractCodexText(out), "two");
});

test("extractCodexText falls back to raw output when there are no JSON events", () => {
  assert.equal(extractCodexText("plain final answer"), "plain final answer");
});

test("extractCodexText prefers the agent_message over reasoning and trailing events", () => {
  const jsonl = [
    '{"type":"item.completed","item":{"type":"reasoning","text":"REASONING (not the answer)"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"THE ANSWER"}}',
    '{"type":"item.completed","item":{"type":"token_count","text":"123 tokens"}}',
  ].join("\n");
  assert.equal(extractCodexText(jsonl), "THE ANSWER");
});

// A HUNCH_*_MODEL env var is the only non-literal argv token reaching pexecIn's
// Windows cmd.exe line (shell:true). safeModel rejects whitespace/metachars so a
// poisoned env var can't smuggle a second command, falling back instead of crashing.
test("safeModel passes real model ids through unchanged", () => {
  for (const m of ["haiku", "claude-haiku-4-5-20251001", "anthropic/claude-opus", "gpt-4o-mini", "o4-mini"]) {
    assert.equal(safeModel(m, "haiku"), m);
  }
});

test("safeModel rejects shell-metachar / whitespace injection, returning the fallback", () => {
  for (const bad of ["haiku & evil.exe", "a|b", "x;y", "$(whoami)", "`id`", "a b", 'q"uote', "(sub)", ">out"]) {
    assert.equal(safeModel(bad, "haiku"), "haiku"); // string fallback
    assert.equal(safeModel(bad, undefined), undefined); // omit-flag fallback
  }
});

test("safeModel returns the fallback when the env var is unset", () => {
  assert.equal(safeModel(undefined, "haiku"), "haiku");
  assert.equal(safeModel(undefined, undefined), undefined);
  assert.equal(safeModel("", "haiku"), "haiku"); // empty string → fallback
});

test("selectProvider never throws and resolves to some provider when one is forced-unavailable", async () => {
  process.env.HUNCH_SYNTH_PROVIDER = "codex-cli"; // not installed here → must fall through
  try {
    const p = await selectProvider();
    assert.ok(p.name, "resolved to a provider");
  } finally {
    delete process.env.HUNCH_SYNTH_PROVIDER;
  }
});

test("HUNCH_SYNTH_PROVIDER=deterministic forces the offline heuristic", async () => {
  process.env.HUNCH_SYNTH_PROVIDER = "deterministic";
  try {
    assert.equal((await selectProvider()).name, "deterministic");
  } finally {
    delete process.env.HUNCH_SYNTH_PROVIDER;
  }
});

// HUNCH_SYNTH_TIMEOUT_MS feeds AbortController's delay directly. A non-numeric or
// nonsensical value (negative, zero, NaN, Infinity) would either abort immediately
// or never abort, so validate the same way safeModel does: fall back rather than
// propagate garbage.
test("safeTimeout passes a valid positive number through unchanged", () => {
  assert.equal(safeTimeout("60000", 300_000), 60000);
  assert.equal(safeTimeout("1", 300_000), 1);
});

test("safeTimeout falls back to the default on unset/invalid/non-positive values", () => {
  for (const bad of [undefined, "", "0", "-5", "abc", "NaN", "Infinity"]) {
    assert.equal(safeTimeout(bad, 300_000), 300_000);
  }
});

test("safeMaxTokens passes a valid positive number through unchanged", () => {
  assert.equal(safeMaxTokens("512", 2048), 512);
  assert.equal(safeMaxTokens("1", 2048), 1);
});

test("safeMaxTokens falls back to the default on unset/invalid/non-positive values", () => {
  for (const bad of [undefined, "", "0", "-5", "abc", "NaN", "Infinity"]) {
    assert.equal(safeMaxTokens(bad, 2048), 2048);
  }
});

function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("OpenAICompatProvider.available() is false unless BOTH HUNCH_SYNTH_BASE_URL and HUNCH_SYNTH_MODEL are set", async () => {
  delete process.env.HUNCH_SYNTH_BASE_URL;
  delete process.env.HUNCH_SYNTH_MODEL;
  assert.equal(await new OpenAICompatProvider().available(), false);

  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1";
  assert.equal(await new OpenAICompatProvider().available(), false, "base url alone is not enough");
  delete process.env.HUNCH_SYNTH_BASE_URL;

  process.env.HUNCH_SYNTH_MODEL = "m";
  assert.equal(await new OpenAICompatProvider().available(), false, "model alone is not enough");
  delete process.env.HUNCH_SYNTH_MODEL;
});

test("OpenAICompatProvider.draftDecision POSTs {baseUrl}/chat/completions with model/messages/response_format and maps choices[0].message.content", async () => {
  let received: { method?: string; path?: string; auth?: string; body?: Record<string, unknown> } = {};
  const server = await startFakeServer((req, res, body) => {
    received = { method: req.method, path: req.url, auth: req.headers.authorization as string | undefined, body: JSON.parse(body) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"decision":"use a local model","context":"self-hosted","nontrivial":true}' } }],
    }));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "qwen2.5:7b";
  delete process.env.HUNCH_SYNTH_API_KEY;
  try {
    const provider = new OpenAICompatProvider();
    assert.equal(await provider.available(), true);
    const draft = await provider.draftDecision({ subject: "feat: x", body: "", files: ["a.py"], diff: "+def a(): pass" });
    assert.equal(draft.decision, "use a local model");
    assert.equal(received.method, "POST");
    assert.equal(received.path, "/chat/completions");
    assert.equal(received.body?.model, "qwen2.5:7b");
    assert.equal((received.body?.response_format as { type?: string })?.type, "json_object");
    assert.equal(received.body?.stream, false);
    assert.equal(received.body?.max_tokens, 2048, "default max_tokens sent");
    assert.ok(Array.isArray(received.body?.messages));
    assert.equal(received.auth, undefined, "no Authorization header when HUNCH_SYNTH_API_KEY is unset");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    await server.close();
  }
});

test("OpenAICompatProvider sends a Bearer Authorization header only when HUNCH_SYNTH_API_KEY is set", async () => {
  let authHeader: string | undefined;
  const server = await startFakeServer((req, res) => {
    authHeader = req.headers.authorization as string | undefined;
    res.end(JSON.stringify({ choices: [{ message: { content: '{"decision":"d","context":"c","nontrivial":true}' } }] }));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_API_KEY = "sk-local-123";
  try {
    await new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" });
    assert.equal(authHeader, "Bearer sk-local-123");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_API_KEY;
    await server.close();
  }
});

test("OpenAICompatProvider.draftDecision honors HUNCH_SYNTH_MAX_TOKENS", async () => {
  let received: Record<string, unknown> = {};
  const server = await startFakeServer((req, res, body) => {
    received = JSON.parse(body);
    res.end(JSON.stringify({ choices: [{ message: { content: '{"decision":"d","context":"c","nontrivial":true}' } }] }));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_MAX_TOKENS = "512";
  try {
    await new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" });
    assert.equal(received.max_tokens, 512);
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_MAX_TOKENS;
    await server.close();
  }
});

test("OpenAICompatProvider.draftDecision throws on a non-2xx response (caller falls back to deterministic)", async () => {
  const server = await startFakeServer((req, res) => {
    res.statusCode = 500;
    res.end("internal error");
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  try {
    await assert.rejects(
      new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }),
      /500/,
    );
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    await server.close();
  }
});

test("OpenAICompatProvider.draftDecision rejects when the endpoint exceeds HUNCH_SYNTH_TIMEOUT_MS", async () => {
  const server = await startFakeServer((_req, res) => {
    setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] })), 500);
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_TIMEOUT_MS = "50";
  try {
    await assert.rejects(new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }));
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_TIMEOUT_MS;
    await server.close();
  }
});

test("probeOllamaNumCtx returns null when the model's parameters already set num_ctx", async () => {
  const server = await startFakeServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ parameters: "num_ctx                       16384\nstop                           \"<|endoftext|>\"" }));
  });
  try {
    const warning = await probeOllamaNumCtx(server.url, "hunch-synth");
    assert.equal(warning, null, "num_ctx already set — nothing to warn about");
  } finally {
    await server.close();
  }
});

test("probeOllamaNumCtx warns when the model's parameters have no num_ctx set", async () => {
  const server = await startFakeServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ parameters: "stop                           \"<|endoftext|>\"" }));
  });
  try {
    const warning = await probeOllamaNumCtx(server.url, "qwen2.5-coder:latest");
    assert.ok(warning?.includes("4096"), `expected a 4096-token warning, got: ${warning}`);
  } finally {
    await server.close();
  }
});

test("probeOllamaNumCtx returns null (never throws) on a non-2xx response, a missing parameters field, or an unreachable endpoint", async () => {
  const badStatus = await startFakeServer((req, res) => {
    res.statusCode = 500;
    res.end("nope");
  });
  const noParams = await startFakeServer((req, res) => {
    res.end(JSON.stringify({ some_other_field: true }));
  });
  try {
    assert.equal(await probeOllamaNumCtx(badStatus.url, "m"), null);
    assert.equal(await probeOllamaNumCtx(noParams.url, "m"), null);
    assert.equal(await probeOllamaNumCtx("http://127.0.0.1:1", "m"), null, "unreachable port — must not throw");
  } finally {
    await badStatus.close();
    await noParams.close();
  }
});

test("probeOllamaNumCtx strips a trailing /v1 from the base URL before hitting /api/show", async () => {
  let hitPath: string | undefined;
  const server = await startFakeServer((req, res) => {
    hitPath = req.url;
    res.end(JSON.stringify({ parameters: "" }));
  });
  try {
    await probeOllamaNumCtx(`${server.url}/v1`, "m");
    assert.equal(hitPath, "/api/show");
  } finally {
    await server.close();
  }
});

test("selectProvider does not pick openai-compat when its env vars are unset (default behavior unchanged)", async () => {
  __resetAvailabilityCacheForTests();
  delete process.env.HUNCH_SYNTH_PROVIDER;
  delete process.env.HUNCH_SYNTH_BASE_URL;
  delete process.env.HUNCH_SYNTH_MODEL;
  const p = await selectProvider();
  assert.notEqual(p.name, "openai-compat");
});

test("selectProvider resolves openai-compat when forced and BASE_URL+MODEL are set", async () => {
  __resetAvailabilityCacheForTests();
  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1"; // unreachable; available() checks env presence, not reachability
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_PROVIDER = "openai-compat";
  try {
    const p = await selectProvider();
    assert.equal(p.name, "openai-compat");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_PROVIDER;
    __resetAvailabilityCacheForTests();
  }
});

test("HUNCH_SYNTH_PROVIDER=ollama is accepted as an alias for openai-compat", async () => {
  __resetAvailabilityCacheForTests();
  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_PROVIDER = "ollama";
  try {
    const p = await selectProvider();
    assert.equal(p.name, "openai-compat");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_PROVIDER;
    __resetAvailabilityCacheForTests();
  }
});

test("selectWorkers includes openai-compat once available — deep-synthesis and the Critic pass participate for free", async () => {
  __resetAvailabilityCacheForTests();
  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.HUNCH_SYNTH_MODEL = "m";
  try {
    const workers = await selectWorkers();
    assert.ok(workers.some((w) => w.name === "openai-compat"));
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    __resetAvailabilityCacheForTests();
  }
});
