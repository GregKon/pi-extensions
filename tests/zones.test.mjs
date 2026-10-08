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
import { readFileSync, readdirSync } from "node:fs";
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

function makeCtx(cwd, { mode = "tui", answer = true, hasUI = mode !== "print" } = {}) {
  const calls = { confirm: [], notify: [] };
  return {
    calls,
    ctx: {
      mode, hasUI, cwd,
      model: { provider: "llama.cpp", id: "qwen35b-text", name: "q", baseUrl: "http://127.0.0.1:8080/v1" },
      scopedModels: [],
      abort() { calls.aborted = true; },
      ui: {
        confirm: async (title, message) => { calls.confirm.push({ title, message }); return answer; },
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

// ------------------------------------------------------------- English-only
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
