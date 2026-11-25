// zones.ts — headless tests for the `.zonelocal` gates and the English-only rule.
//
// Run: node --test tests/zones.test.mjs        (Node >= 22, no dependencies, no pty needed)
//      node --test tests/*.test.mjs            (both test files; a bare `tests/` directory argument
//                                               fails on Node 24 with MODULE_NOT_FOUND)
//
// Requires ZONELOCAL_DIR (a directory containing a `.zonelocal` file) and PLAIN_DIR (a directory
// without one); without them the gate cases fail. scripts/doctor.sh CHECK 13 sets both from a
// `mktemp -d` and runs the whole suite.
//
// The extension is loaded directly and driven with a stub context, so this proves the handler
// logic, NOT pi integration. The pi-side contracts it relies on (verified in pi's dist):
//   - `emitInput` awaits async handlers                 (core/extensions/runner.js)
//   - `ctx.ui.confirm` is wrapped by withUIPrompt       (core/extensions/runner.js)
//   - noOpUIContext.confirm resolves false              (fail-closed without a UI)
//   - `api.getActiveTools()` is the effective tool list  (respects --exclude-tools)
//   - `sendCustomMessage` never runs the input handlers  (core/agent-session.js)
// The TUI dialog itself still needs a human click-through; see improvement.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "..", "extensions");
const mod = await import(`file://${join(EXT, "zones.ts").replace(/\\/g, "/")}`);

const ZL = process.env.ZONELOCAL_DIR ?? "";   // a directory that contains a .zonelocal file
const PLAIN = process.env.PLAIN_DIR ?? "";   // a directory without one

function load(activeTools) {
  const handlers = {};
  const pi = {
    on(ev, h) { (handlers[ev] ||= []).push(h); },
    getActiveTools: () => (typeof activeTools === "function" ? activeTools() : activeTools),
    registerCommand() {}, registerTool() {}, addFlag() {},
  };
  mod.default(pi);
  return handlers;
}

function makeCtx(cwd, { mode = "tui", answer = true, hasUI = mode !== "print", inputAnswer = "yes" } = {}) {
  const calls = { confirm: [], notify: [], input: [] };
  return {
    calls,
    ctx: {
      mode, hasUI, cwd,
      model: { provider: "llama.cpp", id: "qwen35b-text", name: "q", baseUrl: "http://127.0.0.1:8080/v1" },
      scopedModels: [],
      abort() { calls.aborted = true; },
      ui: {
        confirm: async (title, message) => { calls.confirm.push({ title, message }); return answer; },
        input: async (prompt, _placeholder) => { calls.input.push({ prompt }); return inputAnswer; },
        notify: (m, level) => calls.notify.push({ m, level }),
        setStatus() {},
        theme: { bold: (s) => s, fg: (_c, s) => s },
      },
    },
  };
}

const NET = ["read", "bash", "edit", "write", "web_search", "fetch_content", "keenable_search", "todo"];
const SPAWN = ["read", "bash", "subagent", "intercom", "todo"];
const CLEAN = ["read", "bash", "edit", "write", "todo"];

const start = (h, ctx) => h.session_start[0]({ type: "session_start" }, ctx);
const shutdown = (h, ctx) => h.session_shutdown[0]({ type: "session_shutdown" }, ctx);
const input = (h, event, ctx) => h.input[0]({ type: "input", text: "x", source: "interactive", ...event }, ctx);
const toolCall = (h, name, ctx) => h.tool_call[0]({ type: "tool_call", toolCallId: "1", toolName: name, input: {} }, ctx);

/** Run `fn` with process.exit trapped, so a fail-closed path can be asserted on. */
async function withExitTrap(fn) {
  const before = process.exit;
  let code;
  process.exit = (c) => { code = c; throw new Error("__exit__"); };
  try { await fn(); } catch (e) { if (!/__exit__/.test(e.message)) throw e; } finally { process.exit = before; }
  return code;
}

// ---------------------------------------------------------------- input gate
test("egress dialog appears once and a refusal swallows the prompt", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  const r = await input(h, {}, ctx);
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0].message, /keenable_search/);
  assert.equal(r?.action, "handled");
  assert.equal(calls.notify.length, 1);
});

test("accepting the dialog lets the prompt through and is remembered for the session", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(ZL, { answer: true });
  await start(h, ctx);
  assert.notEqual((await input(h, {}, ctx))?.action, "handled");
  assert.notEqual((await input(h, {}, ctx))?.action, "handled");
  assert.equal(calls.confirm.length, 1, "second prompt must not ask again");
});

test("a new session asks again", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(ZL, { answer: true });
  await start(h, ctx);
  await input(h, {}, ctx);
  await start(h, ctx);
  await input(h, {}, ctx);
  assert.equal(calls.confirm.length, 2);
});

test("no .zonelocal: silent", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(PLAIN, { answer: false });
  await start(h, ctx);
  assert.notEqual((await input(h, {}, ctx))?.action, "handled");
  assert.equal(calls.confirm.length, 0);
});

test("no network and no subagent tools: nothing to ask about", async () => {
  const h = load(CLEAN); const { ctx, calls } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  assert.notEqual((await input(h, {}, ctx))?.action, "handled");
  assert.equal(calls.confirm.length, 0);
});

test("subagent tools are named in the dialog", async () => {
  const h = load(SPAWN); const { ctx, calls } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  await input(h, {}, ctx);
  assert.match(calls.confirm[0].message, /subagent/);
  assert.match(calls.confirm[0].message, /own models/);
});

test("a non-loopback model is refused BEFORE the egress dialog", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(ZL, { answer: true });
  ctx.model = { provider: "openrouter", id: "stealth/space-bunny-alpha", name: "s", baseUrl: "https://openrouter.ai/api/v1" };
  await start(h, ctx);
  assert.equal((await input(h, {}, ctx))?.action, "handled");
  assert.equal(calls.confirm.length, 0);
  assert.match(calls.notify[0].m, /not loopback/);
});

// ------------------------------------------------- extension-injected prompts
test("an extension prompt in a live TUI is swallowed, the session is NOT killed", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  const r = await input(h, { source: "extension" }, ctx);
  assert.equal(r?.action, "handled", "prompt must not be sent");
  assert.equal(calls.aborted, undefined, "must not abort the session");
  assert.equal(calls.confirm.length, 0, "no dialog for a message the user did not type");
  assert.match(calls.notify[0].m, /from an extension/);
});

test("a non-interactive run fails closed instead of asking", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(ZL, { mode: "print", answer: true });
  await start(h, ctx);
  const code = await withExitTrap(() => input(h, {}, ctx));
  assert.equal(code, 1, "print mode must exit non-zero");
  assert.equal(calls.aborted, true);
});

test("rpc and json fail closed too (rpc has a uiContext, so hasUI lies)", async () => {
  for (const mode of ["rpc", "json"]) {
    const h = load(NET); const { ctx, calls } = makeCtx(ZL, { mode, answer: true });
    await start(h, ctx);
    const code = await withExitTrap(() => input(h, {}, ctx));
    assert.equal(code, 1, `${mode} must exit non-zero`);
    assert.equal(calls.aborted, true, `${mode} must abort`);
    assert.equal(calls.confirm.length, 0, `${mode} must not open a modal`);
  }
});

test("a stale context (getActiveTools throws) fails LOUD and still asks", async () => {
  const h = load(() => { throw new Error("stale ctx"); });
  const { ctx, calls } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  const r = await input(h, {}, ctx);
  assert.equal(r?.action, "handled", "must not pass on an unknown tool list");
  assert.equal(calls.confirm.length, 1, "unknown tool list still asks");
  assert.match(calls.confirm[0].message, /assume the worst/);
});

test("session_shutdown re-arms the gate", async () => {
  const h = load(NET); const { ctx, calls } = makeCtx(ZL, { answer: true });
  await start(h, ctx);
  await input(h, {}, ctx);
  assert.equal(calls.confirm.length, 1);
  await shutdown(h, ctx);
  await input(h, {}, ctx);
  assert.equal(calls.confirm.length, 2, "after shutdown the session asks again");
});

// ---------------------------------------------------------------- tool_call
test("subagent spawns are blocked before confirmation", async () => {
  const h = load(SPAWN); const { ctx } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  const r = await toolCall(h, "subagent", ctx);
  assert.equal(r?.block, true);
  assert.match(r.reason, /not loopback/);
  assert.equal(await toolCall(h, "read", ctx), undefined, "other tools untouched");
});

test("network tools are blocked before confirmation (covers pi.sendMessage paths)", async () => {
  const h = load(NET); const { ctx } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  for (const name of ["web_search", "fetch_content", "keenable_search", "get_search_content"]) {
    const r = await toolCall(h, name, ctx);
    assert.equal(r?.block, true, `${name} must be blocked`);
  }
});

test("subagent and network tools pass after the user confirms", async () => {
  const h = load(NET); const { ctx } = makeCtx(ZL, { answer: true });
  await start(h, ctx);
  await input(h, {}, ctx);
  assert.equal(await toolCall(h, "web_search", ctx), undefined);
  assert.equal(await toolCall(h, "subagent", ctx), undefined);
});

test("bg_wait is not egress", async () => {
  const h = load([...SPAWN, "bg_wait"]); const { ctx } = makeCtx(ZL, { answer: false });
  await start(h, ctx);
  assert.equal(await toolCall(h, "bg_wait", ctx), undefined);
});

test("without .zonelocal nothing is blocked", async () => {
  const h = load(NET); const { ctx } = makeCtx(PLAIN, { answer: false });
  await start(h, ctx);
  assert.equal(await toolCall(h, "web_search", ctx), undefined);
  assert.equal(await toolCall(h, "subagent", ctx), undefined);
});

// ----------------------------------------------------------- zone: red (contributor)
test("contributor model gets zone red and requires 2 confirmations", async () => {
  const h = load(CLEAN);
  // inputAnswer "yes" both times — gate should pass after 2 prompts
  const { ctx, calls } = makeCtx(PLAIN, { inputAnswer: "yes" });
  ctx.model = { provider: "opencode-go", id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", baseUrl: "" };
  await start(h, ctx);
  const r = await input(h, {}, ctx);
  // zone=red: 2 text-input confirmations, prompt passes
  assert.equal(calls.input.length, 2, "red zone must ask twice");
  assert.notEqual(r?.action, "handled", "prompt must pass after 2 confirmations");
});

test("contributor model in id gets zone red even when name is neutral", async () => {
  const h = load(CLEAN);
  const { ctx, calls } = makeCtx(PLAIN, { inputAnswer: "no" });
  ctx.model = { provider: "openrouter", id: "muse/spark-contributor", name: "Spark Model", baseUrl: "" };
  await start(h, ctx);
  const r = await input(h, {}, ctx);
  // zone=red: first "no" → rejected, 1 call only (breaks early)
  assert.equal(calls.input.length, 1, "first 'no' must stop immediately");
  assert.equal(r?.action, "handled", "prompt must be swallowed on rejection");
});

test("no Polish left in the public extensions", () => {
  // A diacritic check is not enough: "brak", "plik" or "katalog" are plain ASCII.
  const words = /\b(brak|plik|katalog|nieczytelne|wpisu|ustawiona|nadpisuje|pierwszenstwo|rejestrujemy|wartosc|nic)\b/i;
  const offenders = [];
  for (const file of readdirSync(EXT).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(EXT, file), "utf8");
    text.split("\n").forEach((line, i) => { if (words.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(offenders, [], `Polish text in a public repo:\n${offenders.join("\n")}`);
});

test("no hardcoded locale in the notification footer", () => {
  const text = readFileSync(join(EXT, "notify.ts"), "utf8");
  assert.equal(/toLocale(Time|Date)String\(\s*"[a-z]{2}-[A-Z]{2}"/.test(text), false, "pin no locale string");
});

// ----------------------------------------------------------- opencode-go and openrouter diff & pricing
test("resolveGoPlan defaults to go and rejects unknown plans", () => {
  // The plan is passed explicitly: the ambient OPENCODE_GO_PLAN must not influence the result.
  assert.equal(mod.resolveGoPlan(""), "go");
  assert.equal(mod.resolveGoPlan("   "), "go");
  assert.equal(mod.resolveGoPlan("enterprise"), "go");
  assert.equal(mod.resolveGoPlan("GO"), "go");
  assert.equal(mod.resolveGoPlan(" go-plus "), "go-plus", "trimmed and lowercased");
  assert.equal(mod.resolveGoPlan("go-plus"), "go-plus");
  assert.equal(mod.resolveGoPlan("go-teams"), "go-teams");
});

test("parseGoModels reads per-plan limits and token prices", () => {
  const payload = {
    data: [
      {
        id: "deepseek-v4.1-flash",
        cost: {
          text: {
            input: { price: 0.15, cache: { read: 0.003 } },
            output: { price: 0.6 },
          },
        },
        go: { monthly_usage: { go: 100, "go-plus": 200, "go-teams": 105 } },
      },
      {
        id: "glm-5.3-flash",
        cost: { text: { input: { price: 0.1 }, output: { price: 0.4 } } },
        go: { monthly_usage: { go: 60, "go-teams": 90 } },
      },
      { id: "not-go-covered", cost: { text: { input: { price: 1 }, output: { price: 2 } } } },
      { id: "unlimited-model", go: { monthly_usage: { go: "unlimited" } } },
      { id: "empty-usage", go: { monthly_usage: {} } },
      { id: 42 },
      null,
    ],
  };

  const go = mod.parseGoModels(payload, "go");
  assert.equal(go.flatLimits["deepseekv4.1flash"], 100);
  assert.equal(go.flatLimits["glm5.3flash"], 60);
  assert.deepEqual(go.fullModels["deepseek-v4.1-flash"], {
    limit: 100,
    price: { input: 0.15, output: 0.6, cachedRead: 0.003 },
  });

  const teams = mod.parseGoModels(payload, "go-teams");
  assert.equal(teams.flatLimits["deepseekv4.1flash"], 105, "go-teams differs from go");
  assert.equal(teams.fullModels["glm-5.3-flash"].limit, 90);

  // A plan missing from a model falls back to its `go` figure.
  const plus = mod.parseGoModels(payload, "go-plus");
  assert.equal(plus.flatLimits["deepseekv4.1flash"], 200);
  assert.equal(plus.flatLimits["glm5.3flash"], 60, "go-plus falls back to go");

  // Not Go-covered: absent from both maps, not rendered as 0.
  assert.equal(go.flatLimits["notgocovered"], undefined);
  assert.equal(go.fullModels["not-go-covered"], undefined);
  assert.equal(go.fullModels["empty-usage"], undefined);
  assert.equal(go.fullModels["unlimited-model"].limit, "unlimited", "unlimited survives as a symbolic limit");
  assert.equal(Object.keys(go.fullModels).length, 3);
});

test("parseGoModels returns two empty objects for a malformed payload", () => {
  for (const payload of [undefined, null, "nope", 7, {}, { data: "nope" }, { data: [] }]) {
    assert.deepEqual(mod.parseGoModels(payload, "go"), { flatLimits: {}, fullModels: {} });
  }
});

test("parseOpenRouterPricing parses token pricing per 1M tokens", () => {
  const data = {
    data: [
      { id: "moonshotai/kimi-k2.7-code", pricing: { prompt: "0.0000006712", completion: "0.00000335" } },
      { id: "z-ai/glm-5.3-flash", pricing: { prompt: "0.0000000412", completion: "0.00000012" } },
      { id: "free/model", pricing: { prompt: "0", completion: "0" } },
      { id: "broken/model", pricing: null },
    ],
  };
  const pricing = mod.parseOpenRouterPricing(data);
  assert.ok(pricing["moonshotai/kimi-k2.7-code"]);
  assert.equal(pricing["moonshotai/kimi-k2.7-code"].input, 0.6712);
  assert.equal(pricing["moonshotai/kimi-k2.7-code"].output, 3.35);
  assert.equal(pricing["z-ai/glm-5.3-flash"].input, 0.0412);
  assert.equal(pricing["z-ai/glm-5.3-flash"].output, 0.12);
  assert.equal(pricing["free/model"].input, 0);
  assert.equal(pricing["free/model"].output, 0);
  assert.equal(pricing["broken/model"], undefined);
});

test("computePriceDiff handles initial cache with no previous cache", () => {
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: { models: { "glm5.3flash": 60 } },
    openrouter: { models: { "z-ai/glm-5.3-flash": { input: 0.0412, output: 0.12 } } },
  };
  const diff = mod.computePriceDiff(undefined, current);
  assert.equal(diff.hasChanges, false);
});

test("computePriceDiff detects added, removed, and changed OpenCode limits", () => {
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: { models: { "glm5.3flash": 15, "oldmodel": 15 } },
    openrouter: { models: {} },
  };
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: { models: { "glm5.3flash": 60, "newmodel": 60 } },
    openrouter: { models: {} },
  };
  const diff = mod.computePriceDiff(previous, current);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.opencode.added.length, 1);
  assert.equal(diff.opencode.added[0].model, "newmodel");
  assert.equal(diff.opencode.removed.length, 1);
  assert.equal(diff.opencode.removed[0].model, "oldmodel");
  assert.equal(diff.opencode.limitChanged.length, 1);
  assert.equal(diff.opencode.limitChanged[0].model, "glm5.3flash");
  assert.equal(diff.opencode.limitChanged[0].oldLimit, 15);
  assert.equal(diff.opencode.limitChanged[0].newLimit, 60);
  assert.match(diff.summary, /\+1 Go model added/);
  assert.match(diff.summary, /-1 Go model removed/);
  assert.match(diff.summary, /1 Go limit change/);
});

test("computePriceDiff detects OpenRouter pricing changes", () => {
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: { models: { "glm5.3flash": 60 } },
    openrouter: { models: { "z-ai/glm-5.3-flash": { input: 0.05, output: 0.15 } } },
  };
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: { models: { "glm5.3flash": 60 } },
    openrouter: { models: { "z-ai/glm-5.3-flash": { input: 0.0412, output: 0.12 } } },
  };
  const diff = mod.computePriceDiff(previous, current);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.openrouter.changed.length, 1);
  assert.equal(diff.openrouter.changed[0].model, "z-ai/glm-5.3-flash");
  assert.equal(diff.openrouter.changed[0].oldPrice.input, 0.05);
  assert.equal(diff.openrouter.changed[0].newPrice.input, 0.0412);
  assert.match(diff.summary, /1 OpenRouter price change/);
});

test("formatGoDiffTable formats a table with required columns", () => {
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: { models: { "glm5.3flash": 60 } },
    openrouter: { models: { "z-ai/glm-5.3-flash": { input: 0.0412, output: 0.12 } } },
  };
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: { models: { "glm5.3flash": 15 } },
    openrouter: { models: { "z-ai/glm-5.3-flash": { input: 0.05, output: 0.15 } } },
  };
  const table = mod.formatGoDiffTable(current, previous);
  assert.match(table, /Model/);
  assert.match(table, /\|\s*Limit\s*\|\s*In\/Out\s*\|\s*Cache\s*\|/);
  assert.match(table, /OR In\/Out/);
  assert.match(table, /Status/);
  assert.match(table, /glm5\.3flash/);
  assert.match(table, /\|\s*60\s*\|/);
  assert.match(table, /—\/—/);
  assert.match(table, /\|\s*\.041\/\.12\s*\|/);
  assert.match(table, /limit 15>60/);
});

test("computePriceDiff handles v1 to v2 migration with no limit changes", () => {
  const prevV1 = {
    date: "2026-10-20",
    models: { "glm5.3flash": 60 },
  };
  const currV2 = {
    schemaVersion: 2,
    date: "2026-10-21",
    models: { "glm5.3flash": 60 },
    opencode: {
      models: {
        "GLM-5.3-Flash": { limit: 60, price: { input: 0.15, output: 0.5 } },
      },
    },
    openrouter: {
      models: {
        "z-ai/glm-5.3-flash": { input: 0.04, output: 0.12 },
      },
    },
  };
  const diff = mod.computePriceDiff(prevV1, currV2);
  assert.equal(diff.hasChanges, false);
  assert.equal(diff.opencode.added.length, 0);
  assert.equal(diff.opencode.removed.length, 0);
  assert.equal(diff.opencode.limitChanged.length, 0);
  assert.equal(diff.opencode.priceChanged.length, 0);
  assert.equal(diff.openrouter.changed.length, 0);
  assert.match(diff.summary, /baseline established/);
});

test("computePriceDiff handles v1 to v2 migration with limit change", () => {
  const prevV1 = {
    date: "2026-10-20",
    models: { "glm5.3flash": 15 },
  };
  const currV2 = {
    schemaVersion: 2,
    date: "2026-10-21",
    models: { "glm5.3flash": 60 },
    opencode: {
      models: {
        "GLM-5.3-Flash": { limit: 60, price: { input: 0.15, output: 0.5 } },
      },
    },
  };
  const diff = mod.computePriceDiff(prevV1, currV2);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.opencode.limitChanged.length, 1);
  assert.equal(diff.opencode.limitChanged[0].oldLimit, 15);
  assert.equal(diff.opencode.limitChanged[0].newLimit, 60);
  assert.match(diff.summary, /baseline established/);
});

test("formatGoDiffTable handles v1 cache data gracefully without TypeError", () => {
  const prevV1 = {
    date: "2026-10-20",
    models: { "glm5.3flash": 60 },
  };
  const currV1 = {
    date: "2026-10-21",
    models: { "glm5.3flash": 60 },
  };
  const table = mod.formatGoDiffTable(currV1, prevV1);
  assert.match(table, /glm5\.3flash/);
  assert.match(table, /\|\s*60\s*\|/);
  assert.match(table, /—\/—/);
  assert.match(table, /ok/);
});

test("computePriceDiff ignores OpenRouter price changes for models outside Go offer", () => {
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: { models: { "GLM-5.3-Flash": { limit: 60 } } },
    openrouter: {
      models: {
        "z-ai/glm-5.3-flash": { input: 0.05, output: 0.15 },
        "anthropic/claude-3-opus": { input: 15, output: 75 },
      },
    },
  };
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: { models: { "GLM-5.3-Flash": { limit: 60 } } },
    openrouter: {
      models: {
        "z-ai/glm-5.3-flash": { input: 0.0412, output: 0.12 },
        "anthropic/claude-3-opus": { input: 20, output: 80 },
      },
    },
  };
  const diff = mod.computePriceDiff(previous, current);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.openrouter.changed.length, 1);
  assert.equal(diff.openrouter.changed[0].model, "z-ai/glm-5.3-flash");
});

test("formatGoDiffTable worst-case row width does not exceed 118 characters", () => {
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: {
      models: {
        "DeepSeek V4.1 Flash (Peak)": {
          limit: 15,
          price: { input: 0.15, output: 0.5, cachedRead: 0.03, cachedWrite: 2.5 },
        },
      },
    },
    openrouter: {
      models: {
        "deepseek/deepseek-v4.1-flash": { input: 0.005, output: 0.02 },
      },
    },
  };
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "DeepSeek V4.1 Flash (Peak)": {
          limit: 60,
          price: { input: 0.2, output: 0.6, cachedRead: 0.04, cachedWrite: 2.8 },
        },
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789": {
          limit: 100,
          price: { input: 0.15, output: 0.6, cachedRead: 0.003, cachedWrite: 0 },
        },
      },
    },
    openrouter: {
      models: {
        "deepseek/deepseek-v4.1-flash": { input: 0.006, output: 0.02 },
      },
    },
  };
  const table = mod.formatGoDiffTable(current, previous);
  const lines = table.split("\n");
  for (const line of lines) {
    assert.ok(
      line.length <= 118,
      `Line length ${line.length} exceeds 118 characters:\n${line}`,
    );
  }
  assert.match(table, /Matched 1\/2 Go models to OpenRouter market pricing\./);
});

test("registers /go-diff slash command", async () => {
  const commands = {};
  const pi = {
    on() {},
    getActiveTools: () => [],
    registerCommand(name, opts) { commands[name] = opts; },
    registerTool() {},
    addFlag() {},
  };
  mod.default(pi);
  assert.ok(commands["go-diff"], "/go-diff command must be registered");
  assert.equal(typeof commands["go-diff"].handler, "function");

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await commands["go-diff"].handler("", {
      ui: { notify() {} },
    });
  } finally {
    console.log = origLog;
  }
  assert.ok(logs.length > 0, "handler must print table or message to console");
});

test("loadCache fallback loads past-dated file with flat numeric opencode.models without models key", () => {
  const origTmpdir = process.env.TMPDIR;
  const origTmp = process.env.TMP;
  const origTemp = process.env.TEMP;

  const sandbox = mkdtempSync(join(tmpdir(), "zones-fallback-test-"));
  try {
    process.env.TMPDIR = sandbox;
    process.env.TMP = sandbox;
    process.env.TEMP = sandbox;

    // Past-dated file (no today-file) without "models" key, only flat numeric opencode.models
    const pastFile = join(sandbox, "opencode-go-prices-2025-01-01.json");
    writeFileSync(
      pastFile,
      JSON.stringify({
        date: "2025-01-01",
        opencode: {
          models: {
            "glm-5.3-flash": 60,
            "deepseek-chat": 15,
          },
        },
      }),
      "utf8",
    );

    let table;
    assert.doesNotThrow(() => {
      table = mod.formatGoDiffTable();
    });
    assert.ok(table, "formatGoDiffTable must return a table string");
    assert.match(table, /Matched \d+\/2 Go models/);
  } finally {
    if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir; else delete process.env.TMPDIR;
    if (origTmp !== undefined) process.env.TMP = origTmp; else delete process.env.TMP;
    if (origTemp !== undefined) process.env.TEMP = origTemp; else delete process.env.TEMP;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("formatGoDiffTable single-token status overflow and two-token boundary", () => {
  // 1. Single-token overflow: synthetic long price token emitted whole, no mid-number cut
  const prevSingle = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: {
      models: {
        "model-synthetic": {
          limit: 60,
          price: { input: 0.1, output: 0.2, cachedRead: 0.01, cachedWrite: 0.02 },
        },
      },
    },
  };
  const currSingle = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "model-synthetic": {
          limit: 60,
          price: { input: 0.1, output: 0.2, cachedRead: 1234567890123.12, cachedWrite: 0.02 },
        },
      },
    },
  };
  const tableSingle = mod.formatGoDiffTable(currSingle, prevSingle);
  // Single token of 24 chars emitted whole without mid-number cut
  assert.match(tableSingle, /cr 0\.01>1234567890123\.12/);
  assert.doesNotMatch(tableSingle, /cr 0\.01>1234567890123\.12…/);

  // 2. Reachable two-token boundary: pair.length <= 29 vs pair.length > 29
  // 2a. pair.length <= 29 -> both tokens joined with "; "
  const prevTwoShort = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: {
      models: {
        "model-pair": {
          limit: 60,
          price: { input: 0.1, output: 0.2 },
        },
      },
    },
  };
  const currTwoShort = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "model-pair": {
          limit: 60,
          price: { input: 0.3, output: 0.4 },
        },
      },
    },
  };
  const tableTwoShort = mod.formatGoDiffTable(currTwoShort, prevTwoShort);
  // "in 0.10>0.30; out 0.20>0.40" is 27 chars <= 29
  assert.match(tableTwoShort, /in 0\.10>0\.30; out 0\.20>0\.40/);

  // 2b. pair.length > 29 -> first token plus "…"
  const prevTwoLong = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: {
      models: {
        "model-pair-long": {
          limit: 60,
          price: { input: 0.001, output: 0.003 },
        },
      },
    },
  };
  const currTwoLong = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "model-pair-long": {
          limit: 60,
          price: { input: 0.002, output: 0.004 },
        },
      },
    },
  };
  const tableTwoLong = mod.formatGoDiffTable(currTwoLong, prevTwoLong);
  // "in 0.001>0.002; out 0.003>0.004" is 31 chars > 29, so first token + "…"
  assert.match(tableTwoLong, /in 0\.001>0\.002…/);
  assert.doesNotMatch(tableTwoLong, /in 0\.001>0\.002; out/);
});

test("formatGoDiffTable decodes HTML entities in model names and preserves paren qualifiers", () => {
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "MiniMax-Text-01 (&gt; 512K tokens)": { limit: 60 },
        "A &amp; B": { limit: 15 },
        "SuperLongModelNameThatIsOverThirtySixCharacters (Off-Peak)": { limit: 60 },
      },
    },
  };
  const table = mod.formatGoDiffTable(current, current);

  // Name ≤ 36 chars is rendered in full.
  assert.match(table, /MiniMax-Text-01 \(> 512K tokens\)/);
  assert.doesNotMatch(table, /MiniMax-…\(> 512K tokens\)/);
  assert.doesNotMatch(table, /&gt;/);

  // Short name with &amp;: decoded to "A & B" before early return
  assert.match(table, /A & B/);
  assert.doesNotMatch(table, /&amp;/);

  // Name > 36 chars with trailing qualifier keeps base…(qualifier).
  assert.match(table, /SuperLongModelNameThatIsO…\(Off-Peak\)/);
});

test("formatGoDiffTable decodes HTML entities in a single pass without re-evaluating entities", () => {
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "X &amp;gt; Y": { limit: 60 },
      },
    },
  };
  const table = mod.formatGoDiffTable(current, current);

  // Single-pass decode order (&gt;/&lt; before &amp;) ensures &amp;gt; yields literal "X &gt; Y", not "X > Y"
  assert.match(table, /X &gt; Y/);
  assert.doesNotMatch(table, /X > Y/);
});

test("formatGoDiffTable width with all 5 counters > 0 ensures every line is <= 118 chars", () => {
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: {
      models: {
        "model-removed": { limit: 60 },
        "model-limit-changed": { limit: 15 },
        "model-price-changed": {
          limit: 60,
          price: { input: 0.1, output: 0.2 },
        },
        "model-or-changed": { limit: 60 },
      },
    },
    openrouter: {
      models: {
        "provider/model-or-changed": { input: 0.01, output: 0.05 },
      },
    },
  };
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "model-added": { limit: 60 },
        "model-limit-changed": { limit: 60 },
        "model-price-changed": {
          limit: 60,
          price: { input: 0.15, output: 0.25 },
        },
        "model-or-changed": { limit: 60 },
      },
    },
    openrouter: {
      models: {
        "provider/model-or-changed": { input: 0.02, output: 0.06 },
      },
    },
  };

  const table = mod.formatGoDiffTable(current, previous);
  const lines = table.split("\n");

  let summaryLineFound = false;
  for (const line of lines) {
    assert.ok(
      line.length <= 118,
      `Line length ${line.length} exceeds 118 characters:\n${line}`,
    );
    if (line.startsWith("Summary:")) {
      summaryLineFound = true;
      assert.match(line, /\+1 Go model added/, "truncated summary must keep the first segment");
      assert.match(line, /Run \/go-diff to view\./, "Summary line must preserve trailing hint");
      assert.match(line, /…/, "Summary line must contain ellipsis indicating truncation");
    }
  }
  assert.ok(summaryLineFound, "Summary line must be present in output");
});

test("formatGoDiffTable sorts by limit desc, unlimited first, ties A–Z, removed last", () => {
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: {
      models: {
        "Zulu-15": { limit: 15 },
        "Alpha-100": { limit: 100 },
        "Beam-Free": { limit: "unlimited" },
        "Gamma-60": { limit: 60 },
        "Removed-30": { limit: 30 },
      },
    },
    openrouter: { models: {} },
  };
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "Zulu-15": { limit: 15 },
        "Alpha-100": { limit: 100 },
        "Beam-Free": { limit: "unlimited" },
        "Gamma-60": { limit: 60 },
      },
    },
    openrouter: { models: {} },
  };
  const table = mod.formatGoDiffTable(current, previous);
  const modelLines = table.split("\n").filter((line) => line.includes("|") && !line.includes("Model"));
  const names = modelLines.map((line) => line.split("|")[0].trim());
  assert.deepEqual(names, [
    "Beam-Free",
    "Alpha-100",
    "Gamma-60",
    "Zulu-15",
    "Removed-30",
  ]);
});

test("formatGoDiffTable fmtPrice collapses leading zero and keeps 3-decimal distinctions", () => {
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "price-sweep": {
          limit: 60,
          price: { input: 0.006, output: 0.008, cachedRead: 0.125, cachedWrite: 0.132 },
        },
        "int-price": {
          limit: 60,
          price: { input: 100, output: 10, cachedRead: 0.19, cachedWrite: 4 },
        },
        "free-stuff": { limit: 60, price: { input: 0, output: 0 } },
        "no-price": { limit: 60 },
      },
    },
    openrouter: { models: {} },
  };
  const table = mod.formatGoDiffTable(current, current);
  assert.match(table, /\.006\/\.008/);
  assert.match(table, /\.125\/\.132/);
  assert.match(table, /\|\s*100\/10\s*\|/);
  assert.match(table, /\|\s*\.19\/4\s*\|/);
  assert.match(table, /Free\/Free/);
  assert.match(table, /—\/—/);
});

test("formatGoDiffTable fmtPrice renders sub-cent prices as <.001 and exact zero as Free", () => {
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "sub-cent-one": { limit: 60, price: { input: 0.0003, output: 0.5 } },
        "sub-cent-both": { limit: 60, price: { input: 0.0004, output: 0.0002 } },
        "zero-price": { limit: 60, price: { input: 0, output: 0 } },
      },
    },
    openrouter: { models: {} },
  };
  const table = mod.formatGoDiffTable(current, current);
  // A single sub-cent side must not collapse to Free.
  assert.match(table, /<\.001\/.5/, "single sub-cent input must render <.001, not Free");
  // Both sides sub-cent overflow the 10-char In/Out cap and end-truncate.
  // Real Go/OpenRouter prices never reach this range, so the truncation is accepted.
  assert.match(table, /<\.001\/<\.0…/, "both-sides sub-cent pair truncates to <.001/<.0…");
  assert.match(table, /Free\/Free/, "exactly zero still renders Free");
});

test("formatGoDiffTable tie-breaks equal limits alphabetically A→Z", () => {
  const previous = {
    schemaVersion: 2,
    date: "2026-10-20",
    opencode: {
      models: {
        "Beam-Unlimited": { limit: "unlimited" },
        "Alpha-60": { limit: 60 },
        "Zulu-60": { limit: 60 },
        "Delta-30": { limit: 30 },
        "Removed-60": { limit: 60 },
      },
    },
    openrouter: { models: {} },
  };
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "Beam-Unlimited": { limit: "unlimited" },
        "Alpha-60": { limit: 60 },
        "Zulu-60": { limit: 60 },
        "Delta-30": { limit: 30 },
      },
    },
    openrouter: { models: {} },
  };
  const table = mod.formatGoDiffTable(current, previous);
  const modelLines = table.split("\n").filter((line) => line.includes("|") && !line.includes("Model"));
  const names = modelLines.map((line) => line.split("|")[0].trim());
  assert.deepEqual(names, [
    "Beam-Unlimited",
    "Alpha-60",
    "Zulu-60",
    "Delta-30",
    "Removed-60",
  ]);
});

test("formatGoDiffTable includes the description line within the 118-char budget", () => {
  const current = {
    schemaVersion: 2,
    date: "2026-10-21",
    opencode: {
      models: {
        "glm5.3flash": { limit: 60, price: { input: 0.15, output: 0.5 } },
      },
    },
    openrouter: { models: {} },
  };
  const table = mod.formatGoDiffTable(current, current);
  const DESCRIPTION = "Prices: USD per 1M tokens · Limit: USD/month · sorted by limit desc, ties A–Z";
  assert.ok(table.includes(DESCRIPTION), "table must contain the exact description line");
  const line = table.split("\n").find((l) => l.includes(DESCRIPTION));
  assert.ok(line, "description line must be present as a standalone line");
  assert.ok(line.length <= 118, `description line length ${line.length} exceeds 118 characters`);
});

test("computePriceDiff re-baselines on a source or plan change", () => {
  const prev = {
    schemaVersion: 2,
    date: "2026-11-24",
    source: "https://opencode.ai/v2/docs/console/go",
    models: { "glm5.3flash": 60 },
  };
  const curr = {
    schemaVersion: 2,
    date: "2026-11-25",
    source: "https://opencode.ai/inference/go/v1/models",
    models: { "glm5.3flash": 60 },
  };

  const sourceSwitch = mod.computePriceDiff(prev, curr);
  assert.equal(sourceSwitch.hasChanges, false, "source switch is not a price change");
  assert.match(sourceSwitch.summary, /source changed/);

  const planSwitch = mod.computePriceDiff(
    { ...prev, source: curr.source, plan: "go" },
    { ...curr, plan: "go-plus" },
  );
  assert.equal(planSwitch.hasChanges, false, "plan switch is not a price change");
  assert.match(planSwitch.summary, /plan changed/);
});
