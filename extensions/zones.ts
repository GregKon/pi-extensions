/**
 * zones — traffic-light "zone" indicator + prompt gate for the active model.
 *
 * Zone = safety level of the active model:
 *   green  — local model: provider/model name contains 'local' (e.g. apiKey: "local")
 *            OR the endpoint is loopback (127.0.0.0/8, localhost, ::1, 0.0.0.0) —
 *            e.g. provider "llama-server=http://127.0.0.1:8082" / llama.cpp
 *   red    — id/name contains 'free' or 'contributor', OR provider is nvidia/google (they train on your data)
 *   yellow — everything else
 *
 * Zone can be overridden by a file in the directory where pi was opened (cwd):
 *   .zonegreen / .zoneyellow / .zonered   (precedence: red > yellow > green)
 *
 * `.zonelocal` is not a colour — it is a hard mode. Placed in the repo root it means:
 * the prompt and the context may only go to a model on loopback (127.0.0.0/8, localhost,
 * ::1, 0.0.0.0). Tools are gated separately, because a local model can still move data out:
 *   the prompt — `input` asks once per session (ctx.ui.confirm) when the session has network
 *                  or subagent tools; "no" swallows the prompt, nothing is sent. A prompt that
 *                  did not come from the user (an extension's sendUserMessage) is refused with
 *                  the session kept alive.
 *   tools    — `tool_call` refuses network tools and subagent spawners until the user confirms.
 *   interactive — REFUSES prompts while the active model is not loopback, so nothing is sent;
 *                  the way out is the model's own picker (`/model` in TUI). The extension does
 *                  not switch the model itself on purpose — `pi.setModel()` exists, but
 *                  silently replacing a model the user picked is a product decision, not a fix.
 *   non-interactive (print/rpc/json) — refused and the process exits 1: there is nobody to
 *                  ask, and the run must not send anything out. Restart with a local --model.
 * `/compact` (and `ctx.compact()`) send the whole context WITHOUT an `input` event, so they
 *   are gated separately in `session_before_compact`.
 * No escape hatch on purpose: lifting it means editing/removing the file, which leaves a trace.
 * `.zonelocal` and the colour files do NOT override each other: `.zonelocal` is looked up in
 * the repo root, `.zonegreen/.zoneyellow/.zonered` in cwd. There is no precedence contest.
 *
 * Three semantics worth knowing (all measured in a sandbox, 2026-09-28):
 *   - nearest repo root, not every ancestor: a `.zonelocal` in `$HOME` would lock every repo
 *     under it, and the mode has no escape hatch. Consequence worth knowing: inside a
 *     submodule or a nested clone the nearest `.git` is that one, so a `.zonelocal` at the
 *     outer root is NOT active there (fail-open by design; `/zone` prints the root it used).
 *   - ANY filesystem entry named `.zonelocal` activates the mode, a directory included
 *     (fail-closed both ways: a stray directory must not silently leak, and it must not
 *     silently disable the gate either). `/zone` reports which kind it is and where it looked.
 *   - `0.0.0.0` counts as loopback (it is the local-client alias; a server bound to it is
 *     also reachable from the network, so this is a convention, and it is inherited from the
 *     zone regex which has treated it as local since the beginning).
 *
 * UI: the zone is shown as a persistent, colored `setStatus` entry. pi's built-in
 * footer renders extension statuses on a single line, sorted by key. The "zones" key
 * sorts after "caveman"/"deepseek-peak", so the colored zone lands at the RIGHT end of
 * that status line. No extra line, no footer replacement, colors via ANSI (theme.fg).
 *
 * Prompt gate — only at session start (also on /resume) and when the model changes:
 *   green  -> nothing
 *   yellow -> ask once: user must type "yes" before the prompt is sent
 *   red    -> ask twice
 * Once confirmed, the rest of the prompts in that session pass normally.
 * Gate runs only in interactive (TUI) mode; it never blocks rpc/print/json.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Zone = "green" | "yellow" | "red";

const RED_PROVIDERS = ["nvidia", "google"];

/**
 * Loopback endpoint — model runs on this machine (or a tunnel to it), data stays local.
 * Anchored to a host position (start, after "//" or after "@") so that hostnames merely
 * containing a dotted quad ("127.0.0.1.evil.com") are not treated as local.
 */
const LOOPBACK_HOST =
  /(?:^|\/\/|@)(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]|::1|0\.0\.0\.0)(?::\d+)?(?=[/:?]|$)/;

/**
 * Tools that reach the network on their own. Families (not an exhaustive list of names) so a
 * new search package is covered by its prefix; measured in a live session: `web_search`,
 * `source_check`, `fetch_content`, `get_search_content`, `keenable_search`, `keenable_fetch`,
 * `greedy_search`, `greedy_fetch`. Best-effort by design — the `.zonelocal` prompt gate does
 * not depend on this list, only the egress warning does, and it errs towards silence.
 */
const NETWORK_TOOL_RE = /^(?:web_|fetch_|source_check$|get_search_content$|keenable_|greedy_)/;

/**
 * pi-subagents tools that start a model call in a child process. Their model comes from
 * `subagents.agentOverrides` and is remote in our setup, so a local parent prompt would still
 * leave the machine. Names measured in `pi-subagents` (`subagent`, `subagent_supervisor`,
 * `intercom`, `contact_supervisor`); `bg_wait` is excluded — waiting is not egress.
 */
const SPAWN_TOOL_RE = /^(?:subagent|subagent_supervisor|intercom|contact_supervisor)$/;

/** Fallback names for the fail-open path above — the families the regexes match. */
const NETWORK_TOOL_NAMES = [
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  "keenable_search",
  "keenable_fetch",
  "greedy_search",
  "greedy_fetch",
];
const SPAWN_TOOL_NAMES = ["subagent", "subagent_supervisor", "intercom", "contact_supervisor"];

/**
 * Repo root for the `.zonelocal` lookup: walk up from cwd to the nearest `.git` (file for
 * worktrees, dir for normal clones). No subprocess — pure path walk, MSYS-safe. If there is
 * no git root, cwd itself is the root.
 */
function findRepoRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

/** Path of `.zonelocal` when the hard local-only mode is on, else undefined. */
function localOnlyFile(cwd: string): string | undefined {
  if (!cwd) return undefined;
  const p = join(findRepoRoot(cwd), ".zonelocal");
  return existsSync(p) ? p : undefined;
}

/**
 * Strict loopback test for `.zonelocal`: the ENDPOINT must be loopback, in the provider id
 * (it may carry the url: "llama-server=http://127.0.0.1:8082") or in baseUrl. Deliberately
 * does NOT reuse the zone rule "'local' in the name" — that one marks a remote model called
 * `local-mirror` as green. Address only, no exceptions, no escape hatch.
 */
function isLoopbackModel(provider: string, _id: string, baseUrl: string): boolean {
  return LOOPBACK_HOST.test((provider || "").toLowerCase())
    || LOOPBACK_HOST.test((baseUrl || "").toLowerCase());
}

/** Precedence of zone override files in cwd: red > yellow > green. */
function fileOverride(cwd: string): Zone | undefined {
  if (!cwd) return undefined;
  if (existsSync(join(cwd, ".zonered"))) return "red";
  if (existsSync(join(cwd, ".zoneyellow"))) return "yellow";
  if (existsSync(join(cwd, ".zonegreen"))) return "green";
  return undefined;
}

/** Auto-detect zone from the model. */
function autoZone(provider: string, id: string, name: string, baseUrl: string): Zone {
  const p = (provider || "").toLowerCase();
  const i = (id || "").toLowerCase();
  const n = (name || "").toLowerCase();

  // green: local model — 'local' in provider/model name (apiKey: "local")
  if (p.includes("local") || i.includes("local") || n.includes("local")) return "green";

  // green: loopback endpoint — llama.cpp / llama-server / any self-hosted server.
  // The provider id itself may carry the URL ("llama-server=http://127.0.0.1:8082").
  if (LOOPBACK_HOST.test(p) || LOOPBACK_HOST.test((baseUrl || "").toLowerCase())) return "green";

  // red: 'free' or 'contributor' in id/name, or provider is nvidia/google
  if (i.includes("free") || n.includes("free")) return "red";
  if (i.includes("contributor") || n.includes("contributor")) return "red";
  if (RED_PROVIDERS.some((rp) => p.includes(rp))) return "red";

  // everything else -> yellow
  return "yellow";
}

function computeZone(
  provider: string,
  id: string,
  name: string,
  baseUrl: string,
  cwd: string,
): Zone {
  return fileOverride(cwd) ?? autoZone(provider, id, name, baseUrl);
}

// --- opencode-go monthly limits ---
//
// Source of truth: https://opencode.ai/v2/docs/console/go ("Usage limits" table).
// The old path /docs/go/ answers 404 (verified 2026-10-13) and /docs/go.md too, so
// the v2 console page is the live one. That page renders TWO tab panels with a full
// table each ("Go" and "Go Plus"); the parser picks the FIRST table whose headers
// contain BOTH "model" and "limit", i.e. the Go panel, so the Plus limits
// ($180/$240...) are deliberately ignored. A parser that scanned every row
// would end up with Plus values.
// Limits change day-to-day, so we fetch the docs page at most once per day and
// cache the parsed table in os.tmpdir(). If today's fetch fails, we fall back to the
// newest older cache and mark the number with `*`; with no cache at all the segment
// becomes a visible `$? (why)` error for opencode-go models. Previously both cases
// were silent, which is how a dead URL could hide the limits indefinitely.

const GO_DOCS_URL = "https://opencode.ai/v2/docs/console/go";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const GO_CACHE_PREFIX = "opencode-go-prices-";
const GO_DIFF_PREFIX = "opencode-go-diff-";

export type GoLimit = number | "unlimited";

export interface GoTokenPrice {
  input: number; // USD per 1M tokens (0 for Free)
  output: number; // USD per 1M tokens (0 for Free)
  cachedRead?: number; // USD per 1M tokens (undefined for "-")
  cachedWrite?: number; // USD per 1M tokens (undefined for "-")
}

export interface GoModelEntry {
  limit: GoLimit;
  price?: GoTokenPrice; // optional for v1 cache compatibility
}

export interface OpenRouterPrice {
  input: number; // USD per 1M tokens
  output: number; // USD per 1M tokens
}

export interface CachedPrices {
  schemaVersion?: number; // 2 for new format with token prices
  date: string;
  source?: string;
  models?: Record<string, GoLimit>; // flat fast lookup for footer limit: normId -> limit
  opencode?: {
    models: Record<string, GoModelEntry | GoLimit>; // union for backward compatibility
  };
  openrouter?: {
    models: Record<string, OpenRouterPrice>;
  };
}

export interface PriceDiff {
  opencode: {
    added: Array<{ model: string; entry: GoModelEntry }>;
    removed: Array<{ model: string; entry: GoModelEntry }>;
    limitChanged: Array<{ model: string; oldLimit: GoLimit; newLimit: GoLimit }>;
    priceChanged: Array<{
      model: string;
      oldPrice: GoTokenPrice;
      newPrice: GoTokenPrice;
    }>;
  };
  openrouter: {
    changed: Array<{ model: string; oldPrice: OpenRouterPrice; newPrice: OpenRouterPrice }>;
  };
  hasChanges: boolean;
  summary: string;
}

/** Normalize raw cache value (v1 number/unlimited or v2 GoModelEntry) to GoModelEntry. */
export function toGoEntry(val: unknown): GoModelEntry {
  if (typeof val === "number" || val === "unlimited") {
    return { limit: val as GoLimit, price: undefined };
  }
  if (val && typeof val === "object") {
    const entry = val as GoModelEntry;
    return {
      limit: entry.limit ?? "unlimited",
      price: entry.price,
    };
  }
  return { limit: "unlimited", price: undefined };
}

/** Current UTC day (YYYY-MM-DD), used as cache file stamp. */
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Cache path: {tmpdir}/opencode-go-prices-YYYY-MM-DD.json */
function cachePath(day: string): string {
  return join(tmpdir(), `${GO_CACHE_PREFIX}${day}.json`);
}

/** Daily diff notification flag path: {tmpdir}/opencode-go-diff-YYYY-MM-DD.flag */
function flagPath(day: string): string {
  return join(tmpdir(), `${GO_DIFF_PREFIX}${day}.flag`);
}

/**
 * Read today's cache, or the newest older one (offline fallback).
 * `stale` is true when the values come from an older file — the caller shows them
 * with a `*` so a frozen number is never mistaken for a fresh one.
 */
function loadCache(): { models: Record<string, GoLimit>; stale: boolean; raw?: CachedPrices } | undefined {
  try {
    const files = readdirSync(tmpdir())
      .filter((f) => f.startsWith(GO_CACHE_PREFIX) && f.endsWith(".json"))
      .sort()
      .reverse();
    const today = cachePath(dayStamp());
    const paths = [today, ...files.map((f) => join(tmpdir(), f))];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const json = JSON.parse(readFileSync(p, "utf8")) as CachedPrices;
      let flatLimits: Record<string, GoLimit> = json.models || {};
      if (Object.keys(flatLimits).length === 0 && json.opencode?.models) {
        flatLimits = Object.fromEntries(
          Object.entries(json.opencode.models).map(([k, v]) => [
            normId(k),
            toGoEntry(v).limit,
          ]),
        );
      }
      if (Object.keys(flatLimits).length > 0) {
        return { models: flatLimits, stale: p !== today, raw: json };
      }
    }
  } catch {
    // tmpdir unreadable / broken cache — caller falls back to the `$?` error segment.
  }
  return undefined;
}

/** Read today's cached prices if present. */
function loadTodayCache(): CachedPrices | undefined {
  try {
    const p = cachePath(dayStamp());
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as CachedPrices;
  } catch {
    return undefined;
  }
}

/**
 * Read the newest older cache file before `currentDay` to compare diffs.
 */
function loadPreviousCache(currentDay: string): CachedPrices | undefined {
  try {
    const files = readdirSync(tmpdir())
      .filter((f) => f.startsWith(GO_CACHE_PREFIX) && f.endsWith(".json"))
      .map((f) => {
        const match = f.match(new RegExp(`^${GO_CACHE_PREFIX}(\\d{4}-\\d{2}-\\d{2})\\.json$`));
        return match ? { file: f, day: match[1] } : null;
      })
      .filter((item): item is { file: string; day: string } => item !== null && item.day < currentDay)
      .sort((a, b) => b.day.localeCompare(a.day));

    if (files.length === 0) return undefined;
    const p = join(tmpdir(), files[0].file);
    return JSON.parse(readFileSync(p, "utf8")) as CachedPrices;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a model name/id for matching across doc display names and pi model ids:
 * lowercase, drop parenthetical qualifiers (Peak/Off-Peak, ≤256K tokens),
 * remove spaces and dashes, drop a trailing "free" (Union Alpha Free -> union-alpha).
 */
function normId(name: string): string {
  const s = (name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s-]+/g, "")
    .replace(/free$/, "");
  return s;
}

function parsePriceValue(cell: string): number | undefined {
  if (!cell) return undefined;
  const strongUsd = cell.match(/<strong>\s*\$([\d.]+)/);
  if (strongUsd) return parseFloat(strongUsd[1]);
  const normalUsd = cell.match(/\$([\d.]+)/);
  if (normalUsd) return parseFloat(normalUsd[1]);
  const text = cell.replace(/<[^>]+>/g, "").trim();
  if (/^free$/i.test(text) || /free/i.test(cell)) return 0;
  return undefined;
}

function parseLimitValue(cell: string): GoLimit | undefined {
  if (!cell) return undefined;
  const strongUsd = cell.match(/<strong>\s*\$([\d.]+)/);
  if (strongUsd) return parseFloat(strongUsd[1]);
  if (/<strong>\s*unlimited/i.test(cell)) return "unlimited";
  const normalUsd = cell.match(/\$([\d.]+)/);
  if (normalUsd) return parseFloat(normalUsd[1]);
  if (/unlimited/i.test(cell)) return "unlimited";
  if (/free/i.test(cell)) return 0;
  return undefined;
}

/**
 * Parse Go pricing table from docs HTML, isolating the first panel ("Go" panel)
 * and ignoring subsequent panels like "Go Plus".
 */
export function parseGoPricing(html: string): {
  flatLimits: Record<string, GoLimit>;
  fullModels: Record<string, GoModelEntry>;
} {
  const flatLimits: Record<string, GoLimit> = {};
  const fullModels: Record<string, GoModelEntry> = {};

  if (!html) return { flatLimits, fullModels };

  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi);
  if (!tableMatches) return { flatLimits, fullModels };

  let targetTable: string | null = null;
  let targetCleanTh: string[] = [];

  for (const tableHtml of tableMatches) {
    const thMatches = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => m[1]);
    const cleanTh = thMatches.map((th) =>
      th.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase(),
    );
    const hasModel = cleanTh.some((h) => h.includes("model"));
    const hasLimit = cleanTh.some((h) => h.includes("limit"));
    if (hasModel && hasLimit) {
      targetTable = tableHtml;
      targetCleanTh = cleanTh;
      break;
    }
  }

  if (!targetTable) return { flatLimits, fullModels };

  let modelIdx = -1;
  let inputIdx = -1;
  let outputIdx = -1;
  let cachedReadIdx = -1;
  let cachedWriteIdx = -1;
  let limitIdx = -1;

  for (let i = 0; i < targetCleanTh.length; i++) {
    const h = targetCleanTh[i];
    if (h.includes("cached read")) {
      cachedReadIdx = i;
    } else if (h.includes("cached write")) {
      cachedWriteIdx = i;
    } else if (h.includes("input")) {
      inputIdx = i;
    } else if (h.includes("output")) {
      outputIdx = i;
    } else if (h.includes("limit")) {
      limitIdx = i;
    } else if (h.includes("model")) {
      modelIdx = i;
    }
  }

  if (modelIdx === -1) modelIdx = 0;

  const rowMatches = targetTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const row of rowMatches) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue;

    const nameCell = cells[modelIdx] ?? cells[0] ?? "";
    const name = nameCell.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!name) continue;

    const limitCell =
      limitIdx !== -1 && cells[limitIdx] !== undefined
        ? cells[limitIdx]
        : cells[cells.length - 1];
    const limit = parseLimitValue(limitCell);
    if (limit === undefined) continue;

    let price: GoTokenPrice | undefined;
    if (inputIdx !== -1 && outputIdx !== -1) {
      const inVal = parsePriceValue(cells[inputIdx] ?? "");
      const outVal = parsePriceValue(cells[outputIdx] ?? "");
      if (inVal !== undefined && outVal !== undefined) {
        price = { input: inVal, output: outVal };
        if (cachedReadIdx !== -1) {
          const crVal = parsePriceValue(cells[cachedReadIdx] ?? "");
          if (crVal !== undefined) price.cachedRead = crVal;
        }
        if (cachedWriteIdx !== -1) {
          const cwVal = parsePriceValue(cells[cachedWriteIdx] ?? "");
          if (cwVal !== undefined) price.cachedWrite = cwVal;
        }
      }
    }

    const entry: GoModelEntry = { limit, price };
    fullModels[name] = entry;
    flatLimits[normId(name)] = limit;
  }

  return { flatLimits, fullModels };
}

/**
 * Parse the "Usage limits" table out of the docs HTML.
 * Kept 100% backward-compatible: returns flat map normId(name) -> limit.
 */
export function parseLimits(html: string): Record<string, GoLimit> {
  return parseGoPricing(html).flatLimits;
}

/**
 * Parse public OpenRouter pricing into token prices per 1M tokens.
 */
export function parseOpenRouterPricing(data: unknown): Record<string, OpenRouterPrice> {
  const result: Record<string, OpenRouterPrice> = {};
  if (!data || typeof data !== "object") return result;
  const list = (data as { data?: unknown[] }).data;
  if (!Array.isArray(list)) return result;

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    const pricing = (item as { pricing?: unknown }).pricing;
    if (typeof id !== "string" || !id || !pricing || typeof pricing !== "object") continue;

    const p = pricing as { prompt?: unknown; completion?: unknown };
    const prompt = typeof p.prompt === "string" ? parseFloat(p.prompt) : typeof p.prompt === "number" ? p.prompt : NaN;
    const completion = typeof p.completion === "string" ? parseFloat(p.completion) : typeof p.completion === "number" ? p.completion : NaN;

    if (!isNaN(prompt) && !isNaN(completion)) {
      result[id] = {
        input: Math.round(prompt * 1_000_000 * 10000) / 10000,
        output: Math.round(completion * 1_000_000 * 10000) / 10000,
      };
    }
  }
  return result;
}

/**
 * Compute differences comparing today's cached prices against previous cache.
 */
export function computePriceDiff(
  prev: CachedPrices | undefined,
  curr: CachedPrices,
): PriceDiff {
  const diff: PriceDiff = {
    opencode: { added: [], removed: [], limitChanged: [], priceChanged: [] },
    openrouter: { changed: [] },
    hasChanges: false,
    summary: "",
  };

  if (!prev) {
    diff.summary = "OpenCode Go & OpenRouter: initial data loaded, no previous cache to compare.";
    return diff;
  }

  const isV2Migration = prev.schemaVersion !== 2 || curr.schemaVersion !== 2;

  if (isV2Migration) {
    const prevLimits: Record<string, GoLimit> = {};
    const currLimits: Record<string, GoLimit> = {};

    const prevSource = prev.models || prev.opencode?.models || {};
    for (const [k, v] of Object.entries(prevSource)) {
      prevLimits[normId(k)] = toGoEntry(v).limit;
    }

    const currSource = curr.models || curr.opencode?.models || {};
    for (const [k, v] of Object.entries(currSource)) {
      currLimits[normId(k)] = toGoEntry(v).limit;
    }

    for (const [model, newLimit] of Object.entries(currLimits)) {
      if (model in prevLimits) {
        const oldLimit = prevLimits[model];
        if (oldLimit !== newLimit) {
          diff.opencode.limitChanged.push({ model, oldLimit, newLimit });
        }
      }
    }

    if (diff.opencode.limitChanged.length > 0) {
      diff.hasChanges = true;
      const count = diff.opencode.limitChanged.length;
      diff.summary = `OpenCode Go price baseline established (schema v2); ${count} Go limit change${count > 1 ? "s" : ""} detected.`;
    } else {
      diff.hasChanges = false;
      diff.summary = "OpenCode Go price baseline established (schema v2); diffing active from next update.";
    }

    return diff;
  }

  // Schema v2 diffing
  const prevGoRaw = prev.opencode?.models || prev.models || {};
  const currGoRaw = curr.opencode?.models || curr.models || {};
  const prevOR = prev.openrouter?.models || {};
  const currOR = curr.openrouter?.models || {};

  const prevGo: Record<string, GoModelEntry> = {};
  for (const [k, v] of Object.entries(prevGoRaw)) {
    prevGo[k] = toGoEntry(v);
  }

  const currGo: Record<string, GoModelEntry> = {};
  for (const [k, v] of Object.entries(currGoRaw)) {
    currGo[k] = toGoEntry(v);
  }

  for (const [model, entry] of Object.entries(currGo)) {
    if (!(model in prevGo)) {
      diff.opencode.added.push({ model, entry });
    } else {
      const oldEntry = prevGo[model];
      if (oldEntry.limit !== entry.limit) {
        diff.opencode.limitChanged.push({ model, oldLimit: oldEntry.limit, newLimit: entry.limit });
      }
      if (oldEntry.price !== undefined && entry.price !== undefined) {
        const op = oldEntry.price;
        const np = entry.price;
        if (
          op.input !== np.input ||
          op.output !== np.output ||
          op.cachedRead !== np.cachedRead ||
          op.cachedWrite !== np.cachedWrite
        ) {
          diff.opencode.priceChanged.push({
            model,
            oldPrice: op,
            newPrice: np,
          });
        }
      }
    }
  }

  for (const [model, entry] of Object.entries(prevGo)) {
    if (!(model in currGo)) {
      diff.opencode.removed.push({ model, entry });
    }
  }

  // OpenRouter changes: narrow to Go models only
  const goNormIds = new Set(Object.keys(currGo).map((name) => normId(name)));

  for (const [id, price] of Object.entries(currOR)) {
    const slug = id.split("/")[1] ?? id;
    if (!goNormIds.has(normId(slug))) continue;
    if (id in prevOR) {
      const old = prevOR[id];
      if (old.input !== price.input || old.output !== price.output) {
        diff.openrouter.changed.push({ model: id, oldPrice: old, newPrice: price });
      }
    }
  }

  const goAdded = diff.opencode.added.length;
  const goRemoved = diff.opencode.removed.length;
  const goLimitChanged = diff.opencode.limitChanged.length;
  const goPriceChanged = diff.opencode.priceChanged.length;
  const orChanged = diff.openrouter.changed.length;

  diff.hasChanges =
    goAdded > 0 || goRemoved > 0 || goLimitChanged > 0 || goPriceChanged > 0 || orChanged > 0;

  if (diff.hasChanges) {
    const parts: string[] = [];
    if (goAdded > 0) parts.push(`+${goAdded} Go model${goAdded > 1 ? "s" : ""} added`);
    if (goRemoved > 0) parts.push(`-${goRemoved} Go model${goRemoved > 1 ? "s" : ""} removed`);
    if (goLimitChanged > 0) parts.push(`${goLimitChanged} Go limit change${goLimitChanged > 1 ? "s" : ""}`);
    if (goPriceChanged > 0) parts.push(`${goPriceChanged} Go price change${goPriceChanged > 1 ? "s" : ""}`);
    if (orChanged > 0) parts.push(`${orChanged} OpenRouter price change${orChanged > 1 ? "s" : ""}`);
    diff.summary = `OpenCode / OpenRouter changes detected: ${parts.join(", ")}. Run /go-diff to view.`;
  } else {
    diff.summary = "OpenCode Go & OpenRouter: no price changes detected.";
  }

  return diff;
}

function truncateModelName(name: string, maxLen = 24): string {
  const decoded = name
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
  if (decoded.length <= maxLen) return decoded;
  const match = decoded.match(/^(.*?)(\s*\([^)]+\))$/);
  if (match) {
    const base = match[1].trim();
    const paren = match[2].trim();
    if (paren.length + 4 > maxLen) {
      return decoded.slice(0, maxLen - 1) + "…";
    }
    const availBase = maxLen - paren.length - 1;
    const truncatedBase = base.slice(0, availBase).trimEnd();
    return `${truncatedBase}…${paren}`;
  }
  return decoded.slice(0, maxLen - 1) + "…";
}

function truncateSummary(summary: string, maxLen = 118): string {
  const prefix = "Summary: ";
  if (prefix.length + summary.length <= maxLen) return summary;

  const hint = " Run /go-diff to view.";
  const hintIdx = summary.lastIndexOf(hint);
  const hasHint = hintIdx !== -1 && hintIdx + hint.length === summary.length;
  const hintText = hasHint ? hint : "";
  let body = hasHint ? summary.slice(0, hintIdx) : summary;
  if (hasHint && body.endsWith(".")) {
    body = body.slice(0, -1);
  }

  const segments = body.split(", ");
  for (let k = segments.length - 1; k >= 1; k--) {
    const candidate = `${segments.slice(0, k).join(", ")}…${hintText}`;
    if (prefix.length + candidate.length <= maxLen) {
      return candidate;
    }
  }

  // maxLen is the whole-line budget INCLUDING the "Summary: " prefix.
  const avail = Math.max(0, maxLen - prefix.length - hintText.length - 1);
  const sliced = body.slice(0, avail);
  const atBoundary = sliced.replace(/\s+\S*$/, "").trimEnd();
  if (atBoundary.length > 0) {
    return `${atBoundary}…${hintText}`;
  }
  return `${sliced}…${hintText}`;
}

function formatSingleTokenPrice(val: number | undefined): string {
  if (val === undefined) return "—";
  if (val === 0) return "Free";
  if (val >= 10) {
    return `$${val.toFixed(2)}`;
  }
  return `$${val.toFixed(3)}`;
}

function formatTokenNum(v: number | undefined): string {
  if (v === undefined) return "—";
  if (v === 0) return "0";
  if (v < 0.01) return v.toFixed(3);
  return v.toFixed(2);
}

function fmtLimit(l: GoLimit): string {
  return l === "unlimited" ? "unl" : `$${l}`;
}

/**
 * Format a Markdown / console table showing Model, Go Limit, Go In/Out, Go Cache, OR In/Out, and Status.
 */
export function formatGoDiffTable(
  todayCache?: CachedPrices,
  prevCache?: CachedPrices,
): string {
  const cached = todayCache || loadTodayCache() || loadCache()?.raw;
  if (!cached) {
    return "No OpenCode Go pricing data available. Fetching may still be in flight.";
  }

  const previous =
    prevCache !== undefined
      ? prevCache
      : loadPreviousCache(cached.date || dayStamp());
  const diff = computePriceDiff(previous, cached);

  const goModels = cached.opencode?.models || cached.models || {};
  const orModels = cached.openrouter?.models || {};

  // Build lookup for OpenRouter pricing by normalized model slug
  const orByNorm = new Map<string, { id: string; price: OpenRouterPrice }>();
  for (const [id, price] of Object.entries(orModels)) {
    const slug = id.includes("/") ? id.split("/")[1] : id;
    const norm = normId(slug);
    if (!orByNorm.has(norm) || (!id.includes(":") && orByNorm.get(norm)!.id.includes(":"))) {
      orByNorm.set(norm, { id, price });
    }
  }

  const addedSet = new Set(diff.opencode.added.map((m) => m.model));
  const limitChangeMap = new Map(diff.opencode.limitChanged.map((m) => [m.model, m]));
  const priceChangeMap = new Map(diff.opencode.priceChanged.map((m) => [m.model, m]));
  const orChangeMap = new Map(diff.openrouter.changed.map((m) => [m.model, m]));

  const rows: string[][] = [];
  let matchedCount = 0;
  const totalGoModels = Object.keys(goModels).length;

  for (const [modelKey, rawEntry] of Object.entries(goModels)) {
    const entry = toGoEntry(rawEntry);
    const limitStr = entry.limit === "unlimited" ? "unlimited" : `$${entry.limit}`;
    const norm = normId(modelKey);
    const orEntry = orByNorm.get(norm);
    if (orEntry) matchedCount++;

    const inOutStr = entry.price
      ? `${formatSingleTokenPrice(entry.price.input)}/${formatSingleTokenPrice(entry.price.output)}`
      : "—/—";

    let cacheStr = "—/—";
    if (entry.price) {
      if (entry.price.cachedRead !== undefined || entry.price.cachedWrite !== undefined) {
        const crStr = formatSingleTokenPrice(entry.price.cachedRead);
        const cwStr = formatSingleTokenPrice(entry.price.cachedWrite);
        cacheStr = `${crStr}/${cwStr}`;
      } else {
        cacheStr = "—/—";
      }
    }

    const orPriceStr = orEntry
      ? `${formatSingleTokenPrice(orEntry.price.input)}/${formatSingleTokenPrice(orEntry.price.output)}`
      : "—";

    let status = "ok";
    if (addedSet.has(modelKey)) {
      status = "added";
    } else {
      const tokens: string[] = [];
      const lc = limitChangeMap.get(modelKey) ?? limitChangeMap.get(norm);
      if (lc) {
        tokens.push(`limit ${fmtLimit(lc.oldLimit)}>${fmtLimit(lc.newLimit)}`);
      }
      const pc = priceChangeMap.get(modelKey);
      if (pc) {
        if (pc.oldPrice.input !== pc.newPrice.input) {
          tokens.push(`in ${formatTokenNum(pc.oldPrice.input)}>${formatTokenNum(pc.newPrice.input)}`);
        }
        if (pc.oldPrice.output !== pc.newPrice.output) {
          tokens.push(`out ${formatTokenNum(pc.oldPrice.output)}>${formatTokenNum(pc.newPrice.output)}`);
        }
        if (pc.oldPrice.cachedRead !== pc.newPrice.cachedRead) {
          tokens.push(`cr ${formatTokenNum(pc.oldPrice.cachedRead)}>${formatTokenNum(pc.newPrice.cachedRead)}`);
        }
        if (pc.oldPrice.cachedWrite !== pc.newPrice.cachedWrite) {
          tokens.push(`cw ${formatTokenNum(pc.oldPrice.cachedWrite)}>${formatTokenNum(pc.newPrice.cachedWrite)}`);
        }
      }
      if (orEntry && orChangeMap.has(orEntry.id)) {
        const orc = orChangeMap.get(orEntry.id)!;
        if (orc.oldPrice.input !== orc.newPrice.input) {
          tokens.push(`OR ${formatTokenNum(orc.oldPrice.input)}>${formatTokenNum(orc.newPrice.input)}`);
        } else if (orc.oldPrice.output !== orc.newPrice.output) {
          tokens.push(`OR ${formatTokenNum(orc.oldPrice.output)}>${formatTokenNum(orc.newPrice.output)}`);
        }
      }

      if (tokens.length === 0) {
        status = "ok";
      } else if (tokens.length === 1) {
        status = tokens[0];
      } else if (tokens.length === 2) {
        const pair = tokens.join("; ");
        status = pair.length <= 29 ? pair : `${tokens[0]}…`;
      } else {
        status = `${tokens[0]}…`;
      }
    }

    rows.push([truncateModelName(modelKey), limitStr, inOutStr, cacheStr, orPriceStr, status]);
  }

  for (const rem of diff.opencode.removed) {
    const remEntry = toGoEntry(rem.entry);
    const limitStr = remEntry.limit === "unlimited" ? "unlimited" : `$${remEntry.limit}`;
    const inOutStr = remEntry.price
      ? `${formatSingleTokenPrice(remEntry.price.input)}/${formatSingleTokenPrice(remEntry.price.output)}`
      : "—/—";
    const cacheStr = remEntry.price
      ? `${formatSingleTokenPrice(remEntry.price.cachedRead)}/${formatSingleTokenPrice(remEntry.price.cachedWrite)}`
      : "—/—";
    rows.push([truncateModelName(rem.model), limitStr, inOutStr, cacheStr, "—", "removed"]);
  }

  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const headers = ["Model", "Go Limit", "Go In/Out", "Go Cache", "OR In/Out", "Status"];
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = colWidths.map((w) => "-".repeat(w)).join("-+-");
  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ");
  const rowLines = rows.map((r) =>
    r.map((cell, i) => (cell ?? "").padEnd(colWidths[i])).join(" | "),
  );

  const title = `=== OpenCode Go & OpenRouter Pricing (${cached.date}) ===\n`;
  const formattedSummary = diff.summary ? truncateSummary(diff.summary) : "";
  const summaryLine = formattedSummary ? `Summary: ${formattedSummary}\n\n` : "\n";
  const footer = `\nMatched ${matchedCount}/${totalGoModels} Go models to OpenRouter market pricing.\n`;
  return title + summaryLine + [headerLine, sep, ...rowLines].join("\n") + footer;
}

/**
 * Fetch market pricing from public OpenRouter API.
 * Free, unauthenticated, timeout 5s, catches errors gracefully.
 */
function fetchOpenRouterPricing(): Promise<Record<string, OpenRouterPrice>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  return fetch(OPENROUTER_MODELS_URL, { signal: controller.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data) => parseOpenRouterPricing(data))
    .catch(() => ({}))
    .finally(() => clearTimeout(timer));
}

/** pi theme has no orange — raw ANSI 256 color 208 (orange) for unlimited. */
const ORANGE = "\x1b[38;5;208m";
const RESET_FG = "\x1b[39m";

/** Limit display: "$60" / "unlimited", colored green/yellow/red/orange. */
function limitLabel(
  limit: GoLimit,
  bold: (s: string) => string,
  fg: (c: "success" | "warning" | "error", s: string) => string,
  stale = false,
): string {
  const mark = stale ? "*" : "";
  if (limit === "unlimited") {
    return bold(`${ORANGE} | unlimited${RESET_FG}${mark}`);
  }
  const color: "success" | "warning" | "error" = limit >= 60 ? "success" : limit > 15 ? "warning" : "error";
  return bold(fg(color, ` | $${limit}${mark}`));
}

/**
 * Visible failure for an opencode-go model with no limit data. `why` names the cause
 * (`no data` = nothing fetched yet, `fetch failed` = offline/404/layout change,
 * `model not in docs` = docs have no row for this id) so the segment is actionable
 * instead of a silently missing number.
 */
function limitErrorLabel(
  why: string,
  bold: (s: string) => string,
  fg: (c: "success" | "warning" | "error", s: string) => string,
): string {
  return bold(fg("error", ` | $? (${why})`));
}

/** pi theme color for a zone (success=green, warning=yellow, error=red). */
function zoneColor(zone: Zone): "success" | "warning" | "error" {
  return zone === "red" ? "error" : zone === "yellow" ? "warning" : "success";
}

/** Model label close to pi's footer one: (provider) id • thinking */
function modelLabel(
  provider: string,
  id: string,
  name: string,
  thinking: string | undefined,
  reasoning: boolean | undefined,
): string {
  const base = name || id;
  const withProvider = `(${provider}) ${base}`;
  let label = withProvider;
  if (reasoning) {
    label = thinking && thinking !== "off" ? `${withProvider} • ${thinking}` : `${withProvider} • off`;
  }
  return label;
}

interface ModelLike {
  provider?: string;
  id?: string;
  name?: string;
  baseUrl?: string;
  reasoning?: boolean;
}

export default function (pi: ExtensionAPI) {
  // Session state — reset on every start (also /resume, /new, /fork).
  let gatePending = false;
  let cwd = "";
  // `.zonelocal` — hard mode: the model must be on loopback. Wins over `.zonered`.
  let localOnly = false;
  let localOnlyAt = "";
  // `.zonelocal` + egress: the user accepted the risk once for this session.
  let egressConfirmed = false;
  let localOnlyKind = ""; // "file" | "directory" | "unreadable" | "" — reported by /zone

  // opencode-go limits state (module-level per extension instance).
  let goPrices: Record<string, GoLimit> | undefined;
  let goStale = false; // values came from an older cache file
  let goFetchFailed = false; // today's fetch failed (offline / 404 / layout change)
  let goFetching = false;
  let lastCtx: (CtxLike & { thinkingLevel?: string; ui?: any }) | undefined;

  function isGoModel(provider: string | undefined): boolean {
    return (provider || "").toLowerCase().includes("opencode-go");
  }

  // --- .zonelocal helpers -------------------------------------------------

  /** Structural subset of the handler context that the local-only gate needs. */
  type CtxLike = {
    mode?: string;
    model?: ModelLike;
    scopedModels?: readonly { model?: ModelLike }[];
    ui?: { notify?: (message: string, level?: string) => void };
    abort?: () => void;
  };

  function modelLocal(model: ModelLike | undefined): boolean {
    if (!model) return false;
    return isLoopbackModel(model.provider ?? "", model.id ?? "", model.baseUrl ?? "");
  }

  /**
   * Loopback models available in this session, for the "use /model" hint.
   *
   * `ctx.scopedModels` is a getter on the handler context (NOT `getScopedModels()` — that one
   * lives on the internal actions bag and is never exposed to handlers; using it silently
   * yields `[]`). It is also legitimately empty unless a model scope is configured, so an
   * empty list must not be reported as "there are no local models" — just point at /model.
   */
  function localModelsList(ctx: { scopedModels?: readonly { model?: ModelLike }[] }): string {    const scoped = ctx.scopedModels ?? [];
    const names = scoped
      .map((s) => s?.model)
      .filter((m): m is ModelLike => !!m && modelLocal(m))
      .map((m) => `${m.provider ?? "?"}/${m.id ?? "?"}`);
    if (names.length > 0) return names.join(", ");
    return "check the list via /model (scopedModels is empty without a configured scope)";
  }

  function localOnlyWhy(model: ModelLike | undefined, ctx: CtxLike): string {
    const id = model ? `${model.provider ?? "?"}/${model.id ?? "?"}` : "none";
    const addr = model?.baseUrl || (model?.provider ?? "?");
    // `/model` only exists in TUI; print/json get --model, rpc has its own set_model call.
    const how = ctx.mode === "tui" ? "/model" : ctx.mode === "rpc" ? "set_model (RPC)" : "--model";
    return localOnly
      ? `zones: .zonelocal (${localOnlyAt}) — model ${id} is not loopback (address: ${addr}). `
        + `Pick a local model via ${how}. Local models in this session: ${localModelsList(ctx)}`
      : "";
  }

  /**
   * Secondary guard for the non-interactive modes that DO fire `model_select`. The primary
   * boundary is `input` (see the handler below): measured, `model_select` does not fire in
   * print mode, so it can never be the only line of defence.
   *
   * `process.exit(1)` instead of the orderly `ctx.shutdown()`: shutdown finishes with exit
   * code 0, so a script reads a refused run as success (measured rc=0). A refused run has
   * produced nothing, so an immediate non-zero exit is correct and safe.
   */
  function hardStop(ctx: { abort?: () => void }, why: string): void {
    sayRefused(why);
    ctx.abort?.();
    process.exit(1);
  }

  /** Reason on stderr, written synchronously — console.error to a pipe can be lost on exit. */
  function sayRefused(why: string): void {
    try {
      writeSync(2, `${why}\n[zones] non-interactive run in a .zonelocal directory — nothing was sent to the model.\n`);
    } catch {
      /* stderr closed */
    }
  }

  /**
   * Enforce `.zonelocal` for a model change. Fire-and-forget: the handlers that call it
   * either notified (TUI) or stopped the process (non-interactive).
   *
   * Only enforced when the model is KNOWN (`ctx.model` may still be undefined at
   * `session_start`), and refusing on "unknown" would block local models too. The real
   * pre-request boundary is `input` (verified: `session.prompt()` runs the input handlers
   * before `before_agent_start`, model check and auth).
   *
   * RPC is treated like print on purpose: `hasUI` is true there, but there is no human at a
   * terminal to answer, so a silent "try again" would be a lie.
   */
  function enforceLocalOnly(model: ModelLike | undefined, ctx: CtxLike): void {
    if (!localOnly || !model || modelLocal(model)) return;
    const why = localOnlyWhy(model, ctx);
    if (ctx.mode === "tui") {
      // Keep the session alive: the model can still be switched with /model, and prompts are
      // refused by the `input` handler. Only warn here.
      try {
        ctx.ui?.notify?.(why, "warning");
      } catch {
        /* UI not ready */
      }
    } else {
      hardStop(ctx, why);
    }
  }

  /** `/compact` and `ctx.compact()` send the whole context to the model WITHOUT an `input`
   * event (TUI intercepts the command before session.prompt()), so the `input` gate would
   * never see it. `session_before_compact` is the only cancellable boundary there. */
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!localOnly) return;
    const model = (ctx as { model?: ModelLike }).model;
    if (modelLocal(model)) return;
    const why = `${localOnlyWhy(model, ctx)} Compaction to a non-loopback model refused.`;
    if ((ctx as { mode?: string }).mode === "tui") {
      try {
        ctx.ui?.notify?.(why, "error");
      } catch {
        /* UI not ready */
      }
    } else {
      sayRefused(why);
    }
    return { cancel: true };
  });

  /** Background fetch of today's limits; re-renders the status when done. */
  async function fetchGoPrices(): Promise<void> {
    if (goFetching) return;
    // A session that claims to be local-only makes no outbound request of its own, and pi's
    // own code is offline-aware (`process.env.PI_OFFLINE`), so honour both.
    if (localOnly || process.env.PI_OFFLINE) return;
    goFetching = true;
    const goController = new AbortController();
    const goTimer = setTimeout(() => goController.abort(), 15000);

    try {
      const [html, orPricing] = await Promise.all([
        fetch(GO_DOCS_URL, { signal: goController.signal })
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .finally(() => clearTimeout(goTimer)),
        fetchOpenRouterPricing(),
      ]);

      const { flatLimits, fullModels } = parseGoPricing(html);
      if (Object.keys(fullModels).length > 0) {
        goPrices = flatLimits;
        goStale = false;
        goFetchFailed = false;

        const prevCache = loadPreviousCache(dayStamp());
        const todayData: CachedPrices = {
          schemaVersion: 2,
          date: dayStamp(),
          source: GO_DOCS_URL,
          models: flatLimits,
          opencode: { models: fullModels },
          openrouter: { models: orPricing },
        };

        try {
          writeFileSync(
            cachePath(dayStamp()),
            JSON.stringify(todayData, null, 2),
            "utf8",
          );
        } catch {
          // cache write is best-effort only
        }

        const diff = computePriceDiff(prevCache, todayData);
        if (diff.hasChanges) {
          const flag = flagPath(dayStamp());
          if (!existsSync(flag)) {
            try {
              writeFileSync(flag, new Date().toISOString(), "utf8");
            } catch {
              // flag write is best-effort only
            }
            if (lastCtx?.ui?.notify) {
              lastCtx.ui.notify(diff.summary, "info");
            }
          }
        }

        if (lastCtx) updateStatus(lastCtx);
      }
    } catch {
      // offline / 404 / layout change — keep whatever older cache was loaded, mark it
      // stale and surface the failure in the status line instead of hiding the segment.
      goFetchFailed = true;
      if (lastCtx) updateStatus(lastCtx);
    } finally {
      clearTimeout(goTimer);
      goFetching = false;
    }
  }

  function checkDailyNotification(ctx: { ui?: { notify?: (m: string, l?: string) => void } }): void {
    const flag = flagPath(dayStamp());
    if (existsSync(flag)) return;
    const todayData = loadTodayCache();
    if (!todayData) return;
    const prevCache = loadPreviousCache(dayStamp());
    const diff = computePriceDiff(prevCache, todayData);
    if (diff.hasChanges) {
      try {
        writeFileSync(flag, new Date().toISOString(), "utf8");
      } catch {
        // best-effort
      }
      ctx.ui?.notify?.(diff.summary, "info");
    }
  }

  /** Monthly limit for a go model, or undefined when unknown/not go. */
  function goLimit(provider: string | undefined, id: string): GoLimit | undefined {
    if (!isGoModel(provider)) return undefined;
    if (goPrices === undefined) {
      const cached = loadCache();
      if (cached) {
        goPrices = cached.models;
        goStale = cached.stale;
        if (cached.stale) fetchGoPrices();
      } else {
        fetchGoPrices();
      }
    }
    if (!goPrices) return undefined; // fetch in flight, no cache yet
    return goPrices[normId(id)];
  }

  /** Refresh the persistent colored zone status in the footer. */
  function updateStatus(ctx: { model?: unknown; thinkingLevel?: string }) {
    const model = ctx.model as ModelLike | undefined;
    if (!model) {
      ctx.ui.setStatus("zones", undefined);
      return;
    }
    const zone = computeZone(
      model.provider ?? "",
      model.id ?? "",
      model.name ?? "",
      model.baseUrl ?? "",
      cwd,
    );
    // Key "zones" sorts after "caveman"/"deepseek-peak" -> lands at the right end of the status line.
    // Only the zone tag is shown; the model name already appears on the right side of the footer.
    // Vivid+bold: theme "success" -> base ANSI green; bold boosts to bright green.
    // Separator " | " clearly divides zone-tag from other extension statuses.
    let status = ctx.ui.theme.bold(ctx.ui.theme.fg(zoneColor(zone), ` | [zone ${zone}]`));
    // `.zonelocal` is not a colour: show it as a separate tag, green when the active model
    // is loopback, red when it is not (the `input` handler refuses prompts in that case).
    if (localOnly) {
      const okLocal = modelLocal(model);
      status += " " + ctx.ui.theme.bold(
        ctx.ui.theme.fg(okLocal ? "success" : "error", `| [local-only: ${okLocal ? "ok" : "refused"}]`),
      );
    }
    // Right of the zone: monthly go limit for opencode-go models only.
    lastCtx = ctx;
    const limit = goLimit(model.provider, model.id ?? "");
    const boldLabel = (s: string) => ctx.ui.theme.bold(s);
    const fgLabel = (c: "success" | "warning" | "error", s: string) => ctx.ui.theme.fg(c, s);
    if (limit !== undefined) {
      status += limitLabel(limit, boldLabel, fgLabel, goStale || goFetchFailed);
    } else if (isGoModel(model.provider)) {
      status += limitErrorLabel(
        goFetchFailed ? "fetch failed" : goPrices ? "model not in docs" : "no data",
        boldLabel,
        fgLabel,
      );
    }
    ctx.ui.setStatus("zones", status);
  }

  /**
   * Tools in THIS session that can still reach the network, and the pi-subagents spawners.
   * `pi.getActiveTools()` is the effective list — it already reflects `--exclude-tools`
   * (measured: `pinoweb` reports 5 tools, `piultralight` 9). `systemPromptOptions.selectedTools`
   * must NOT be used here: it is the pre-exclusion registry list and still contains
   * `keenable_search` in a profile that excluded it.
   *
   * `unknown: true` when the call fails (it throws on a stale context after
   * `ctx.reload()`/`fork()`/`newSession()`, via `assertActive()`). Callers must then assume
   * the worst — an empty list would silently skip the confirmation.
   */
  function egressTools(): { net: string[]; spawn: string[]; unknown: boolean } {
    let active: string[];
    try {
      active = pi.getActiveTools();
    } catch (err) {
      try {
        writeSync(2, `[zones] could not read the active tool list (${err instanceof Error ? err.message : String(err)}) — assuming network tools are present.\n`);
      } catch {
        /* stderr closed */
      }
      return { net: [...NETWORK_TOOL_NAMES], spawn: [...SPAWN_TOOL_NAMES], unknown: true };
    }
    return {
      net: active.filter((n) => NETWORK_TOOL_RE.test(n)),
      spawn: active.filter((n) => SPAWN_TOOL_RE.test(n)),
      unknown: false,
    };
  }

  function egressWhy(net: string[], spawn: string[]): string {
    const parts: string[] = [];
    if (net.length > 0) parts.push(`network tools: ${net.join(", ")}`);
    if (spawn.length > 0) {
      parts.push(`subagent tools: ${spawn.join(", ")} — they call their own models, which are not loopback`);
    }
    return `zones: .zonelocal (${localOnlyAt}) keeps the prompt on this machine, but this session can still reach the network: ${parts.join("; ")}.`;
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    gatePending = true;
    egressConfirmed = false; // once per session, so /new and /resume ask again
    goFetchFailed = false;
    goStale = false;
    localOnlyAt = localOnlyFile(cwd) ?? "";
    localOnly = localOnlyAt !== "";
    localOnlyKind = !localOnly
      ? ""
      : (() => {
          try {
            return statSync(localOnlyAt).isDirectory() ? "directory" : "file";
          } catch {
            return "unreadable";
          }
        })();
    if (localOnly) {
      // `ctx.model` (getter on the handler context) — NOT `ctx.getModel()`, which is an
      // internal action and is undefined on handlers.
      enforceLocalOnly((ctx as CtxLike).model, ctx as CtxLike);
    }
    if (!localOnly && !process.env.PI_OFFLINE && (ctx as CtxLike).mode === "tui") {
      const today = cachePath(dayStamp());
      if (existsSync(today)) {
        checkDailyNotification(ctx as CtxLike);
      } else {
        fetchGoPrices();
      }
    }
    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    // Model change mid-session = zone change -> re-arm the gate and refresh the status.
    const model = event.model as ModelLike | undefined;
    if (model) {
      const zone = computeZone(
        model.provider ?? "",
        model.id ?? "",
        model.name ?? "",
        model.baseUrl ?? "",
        cwd,
      );
      gatePending = zone !== "green";
      // `.zonelocal`: a non-loopback model is refused. Interactive keeps the session (prompts
      // are refused by `input`, /model can still fix it); non-interactive stops the process.
      if (localOnly && !modelLocal(model)) enforceLocalOnly(model, ctx as CtxLike);
    }
    updateStatus(ctx);
  });

  /**
   * Hard stop while egress is unconfirmed. Covers the paths the `input` gate does not see: a
   * message injected with `pi.sendMessage` (agent-session.js `sendCustomMessage` never calls
   * `_runInputHandlers`, so `deliverAs: nextTurn` / `followUp` / `steer` / `triggerTurn` reach
   * the model unconfirmed), and the agent deciding mid-session to delegate or to search.
   *
   * Blocks BOTH spawners and network tools: the prompt gate alone cannot cover the injected
   * paths, and a blocked tool call is the last boundary that does.
   */
  pi.on("tool_call", async (event, ctx) => {
    if (!localOnly || egressConfirmed) return;
    const name = (event as { toolName?: string }).toolName ?? "";
    const spawn = SPAWN_TOOL_RE.test(name);
    const net = NETWORK_TOOL_RE.test(name);
    if (!spawn && !net) return;
    const why = spawn
      ? `zones: .zonelocal (${localOnlyAt}) — subagent tool "${name}" refused: it calls its own model, which is not loopback. Confirm the prompt interactively to allow it.`
      : `zones: .zonelocal (${localOnlyAt}) — network tool "${name}" refused: the session has not confirmed egress. Confirm the prompt interactively to allow it.`;
    if ((ctx as { mode?: string }).mode === "tui") {
      try {
        ctx.ui.notify(why, "error");
      } catch {
        /* UI not ready */
      }
    } else {
      sayRefused(why);
    }
    return { block: true, reason: why };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    gatePending = false;
    egressConfirmed = false;
    ctx.ui.setStatus("zones", undefined);
  });

  // Prompt gate — only at session start / on model change, only interactively.
  pi.on("input", async (event, ctx) => {
    // `.zonelocal` first: refuse the prompt outright while the model is not loopback. This is
    // the guarantee (nothing is sent); the session stays alive so /model can fix it.
    if (localOnly) {
      const active = ctx.model as ModelLike | undefined;
      if (active && !modelLocal(active)) {
        const why = localOnlyWhy(active, ctx);
        if (ctx.mode === "tui") {
          // Keep the session: the model can still be switched with /model, and the prompt is
          // simply not sent. This is the interactive half of the guarantee.
          try {
            ctx.ui.notify(why, "error");
          } catch {
            /* UI not ready */
          }
          return { action: "handled" };
        }
        // print/rpc/json: refuse AND exit non-zero. `input` is the only pre-request boundary
        // that fires in these modes (measured: `model_select` does not fire in print mode), so
        // this is the guarantee for scripted runs.
        sayRefused(why);
        ctx.abort?.();
        process.exit(1);
      }
    }
    // `.zonelocal` second gate: the PROMPT is local, but tools (and subagents) are not. Asks
    // once per session.
    //
    // `ctx.mode === "tui"` is the only reliable "a human is watching" test: RPC also passes a
    // uiContext (rpc-mode.js), so `ctx.hasUI` is true there while nobody can answer a modal.
    // A prompt that did not come from the user (extension sendUserMessage -> source
    // "extension") is refused WITHOUT exiting — process.exit(1) inside a live TUI would kill
    // the user's session, which is exactly what a subagent reply would trigger.
    if (localOnly && !egressConfirmed) {
      const { net, spawn, unknown } = egressTools();
      if (net.length > 0 || spawn.length > 0) {
        const why = unknown
          ? egressWhy(net, spawn) + " (tool list unavailable — assume the worst.)"
          : egressWhy(net, spawn);
        if (ctx.mode !== "tui") {
          // print/rpc/json: nobody to ask, so fail closed and exit non-zero.
          sayRefused(`${why} No interactive TUI to confirm, so the prompt is refused.`);
          ctx.abort?.();
          process.exit(1);
        }
        if (event.source !== "interactive") {
          // Extension-injected prompt in a live session: swallow it, keep the session alive.
          try {
            ctx.ui.notify(`${why} Prompt from an extension, not sent.`, "warning");
          } catch {
            /* UI not ready */
          }
          return { action: "handled" };
        }
        let ok = false;
        try {
          ok = await ctx.ui.confirm(
            "Local-only mode",
            `${why}\n\nSend this prompt anyway? Tools can move data off this machine.`,
          );
        } catch {
          ok = false;
        }
        if (!ok) {
          try {
            ctx.ui.notify(`${why} Prompt not sent.`, "warning");
          } catch {
            /* UI not ready */
          }
          return { action: "handled" };
        }
        egressConfirmed = true;
      }
    }
    if (ctx.mode !== "tui") return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };
    if (!gatePending) return { action: "continue" };

    const model = ctx.model as ModelLike | undefined;
    if (!model) return { action: "continue" };

    const provider = model.provider ?? "";
    const id = model.id ?? "";
    const name = model.name ?? "";
    const zone = computeZone(provider, id, name, model.baseUrl ?? "", cwd);

    // green -> no question
    if (zone === "green") {
      gatePending = false;
      return { action: "continue" };
    }

    const label = modelLabel(provider, id, name, ctx.thinkingLevel, model.reasoning);
    const asks = zone === "red" ? 2 : 1; // yellow: 1 question, red: 2 questions
    let ok = true;
    for (let i = 0; i < asks; i++) {
      const answer = await ctx.ui.input(
        `Are you sure to send to this model: ${label} since it is ${zone}. Type 'yes' to send`,
        "yes",
      );
      if ((answer ?? "").trim().toLowerCase() !== "yes") {
        ok = false;
        break;
      }
    }

    if (ok) {
      gatePending = false;
      return { action: "continue" };
    }

    ctx.ui.notify(`Prompt NOT sent to ${label} (${zone}). Type 'yes' next time to allow.`, "warning");
    return { action: "handled" };
  });

  // Inspect zone: /zone
  pi.registerCommand("zone", {
    description: "Show current model zone (green/yellow/red) and override files",
    handler: async (_args, ctx) => {
      const model = ctx.model as ModelLike | undefined;
      if (!model) {
        ctx.ui.notify("No active model", "info");
        return;
      }
      const zone = computeZone(
        model.provider ?? "",
        model.id ?? "",
        model.name ?? "",
        model.baseUrl ?? "",
        cwd,
      );
      const label = modelLabel(
        model.provider ?? "",
        model.id ?? "",
        model.name ?? "",
        ctx.thinkingLevel,
        model.reasoning,
      );
      const overrides = ["green", "yellow", "red"]
        .filter((z) => existsSync(join(cwd, `.zone${z}`)))
        .join(", ");
      const localInfo = localOnly
        ? ` | local-only: ${localOnlyAt} (${localOnlyKind}; searched root ${findRepoRoot(cwd)}; `
          + `${modelLocal(model) ? "model OK" : "model REFUSED"})`
        : "";
      const go = isGoModel(model.provider)
        ? goLimit(model.provider, model.id ?? "")
        : undefined;
      const goInfo = isGoModel(model.provider)
        ? ` | go-limit: ${go === undefined ? "loading/unknown" : go}`
        : "";
      ctx.ui.notify(
        `${label} → zone ${zone}${overrides ? ` (override: ${overrides})` : ""}${localInfo}${goInfo}`,
        localOnly && !modelLocal(model) ? "error" : zone === "red" ? "error" : zone === "yellow" ? "warning" : "info",
      );
    },
  });

  // OpenCode Go and OpenRouter diff: /go-diff
  pi.registerCommand("go-diff", {
    description: "Show OpenCode Go limits, OpenRouter market pricing, and daily diff table",
    handler: async (_args, ctx) => {
      let todayData = loadTodayCache();
      if (!todayData) {
        fetchGoPrices();
        const fallback = loadCache();
        if (fallback?.raw) {
          todayData = fallback.raw;
        }
      }
      if (!todayData) {
        const msg = "No pricing data available yet. Fetching in progress...";
        console.log(msg);
        ctx?.ui?.notify?.(msg, "info");
        return;
      }
      const table = formatGoDiffTable(todayData);
      console.log(table);
      if (ctx?.ui?.notify) {
        ctx.ui.notify("OpenCode Go / OpenRouter diff table printed to console", "info");
      }
    },
  });
}
