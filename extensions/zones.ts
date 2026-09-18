/**
 * zones — traffic-light "zone" indicator + prompt gate for the active model.
 *
 * Zone = safety level of the active model:
 *   green  — local model: provider/model name contains 'local' (e.g. apiKey: "local")
 *            OR the endpoint is loopback (127.0.0.0/8, localhost, ::1, 0.0.0.0) —
 *            e.g. provider "llama-server=http://127.0.0.1:8082" / llama.cpp
 *   red    — model name contains 'free' OR provider is nvidia/google (they train on your data)
 *   yellow — everything else
 *
 * Zone can be overridden by a file in the directory where pi was opened (cwd):
 *   .zonegreen / .zoneyellow / .zonered   (precedence: red > yellow > green)
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

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // red: 'free' in the name, or provider is nvidia/google
  if (i.includes("free") || n.includes("free")) return "red";
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
// Source of truth: https://opencode.ai/docs/go/ ("Usage limits" table).
// Limits change day-to-day, so we fetch the docs page at most once per day and
// cache the parsed table in os.tmpdir(). If today's fetch fails, we fall back
// to the newest older cache; if there is no cache at all, the limit segment
// simply stays hidden (never blocks, never crashes).

const GO_DOCS_URL = "https://opencode.ai/docs/go/";
const GO_CACHE_PREFIX = "opencode-go-prices-";
type GoLimit = number | "unlimited";

/** Current UTC day (YYYY-MM-DD), used as cache file stamp. */
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Cache path: {tmpdir}/opencode-go-prices-YYYY-MM-DD.json */
function cachePath(day: string): string {
  return join(tmpdir(), `${GO_CACHE_PREFIX}${day}.json`);
}

/** Read today's cache, or the newest older one (offline fallback). */
function loadCache(): Record<string, GoLimit> | undefined {
  try {
    const files = readdirSync(tmpdir())
      .filter((f) => f.startsWith(GO_CACHE_PREFIX) && f.endsWith(".json"))
      .sort()
      .reverse();
    const today = cachePath(dayStamp());
    const paths = [today, ...files.map((f) => join(tmpdir(), f))];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const json = JSON.parse(readFileSync(p, "utf8")) as { models?: Record<string, GoLimit> };
      if (json.models && Object.keys(json.models).length > 0) return json.models;
    }
  } catch {
    // tmpdir unreadable / broken cache — limit segment stays hidden.
  }
  return undefined;
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

/**
 * Parse the "Usage limits" table out of the docs HTML.
 * Row shape: <tr><td>Name</td><td>...</td><td>LIMIT</td></tr>
 * LIMIT shape: <strong>$60</strong> | <del>$15</del> <strong>$60</strong><br><small>promo</small>
 *            | <strong>Unlimited</strong><br><small>limited time</small>
 * Promo rows keep both struck-through and current values — take the <strong> one.
 */
function parseLimits(html: string): Record<string, GoLimit> {
  const models: Record<string, GoLimit> = {};
  const table = html.match(/<table><thead><tr><th>Model<\/th>.*?<\/table>/s);
  const body = table ? table[0] : html;
  const rows = body.matchAll(/<tr>([\s\S]*?)<\/tr>/g);
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 2) continue;
    const name = cells[0].replace(/<[^>]+>/g, "").trim();
    const limitCell = cells[cells.length - 1];
    let limit: GoLimit | undefined;
    const strongUsd = limitCell.match(/<strong>\s*\$([\d.]+)/);
    if (strongUsd) {
      limit = parseFloat(strongUsd[1]);
    } else if (/<strong>\s*unlimited/i.test(limitCell)) {
      limit = "unlimited";
    } else {
      const usd = limitCell.match(/\$([\d.]+)/);
      if (usd) limit = parseFloat(usd[1]);
    }
    if (limit !== undefined && name) models[normId(name)] = limit;
  }
  return models;
}

/** pi theme has no orange — raw ANSI 256 color 208 (orange) for unlimited. */
const ORANGE = "\x1b[38;5;208m";
const RESET_FG = "\x1b[39m";

/** Limit display: "$60" / "unlimited", colored green/yellow/red/orange. */
function limitLabel(
  limit: GoLimit,
  bold: (s: string) => string,
  fg: (c: "success" | "warning" | "error", s: string) => string,
): string {
  if (limit === "unlimited") {
    return bold(`${ORANGE} | unlimited${RESET_FG}`);
  }
  const color: "success" | "warning" | "error" = limit >= 60 ? "success" : limit > 15 ? "warning" : "error";
  return bold(fg(color, ` | $${limit}`));
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

  // opencode-go limits state (module-level per extension instance).
  let goPrices: Record<string, GoLimit> | undefined;
  let goFetching = false;
  let lastCtx: { model?: unknown; thinkingLevel?: string } | undefined;

  function isGoModel(provider: string | undefined): boolean {
    return (provider || "").toLowerCase().includes("opencode-go");
  }

  /** Background fetch of today's limits; re-renders the status when done. */
  function fetchGoPrices(): void {
    if (goFetching) return;
    goFetching = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    fetch(GO_DOCS_URL, { signal: controller.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((html) => {
        const models = parseLimits(html);
        if (Object.keys(models).length > 0) {
          goPrices = models;
          try {
            writeFileSync(
              cachePath(dayStamp()),
              JSON.stringify({ date: dayStamp(), source: GO_DOCS_URL, models }),
            );
          } catch {
            // cache write is best-effort only
          }
          if (lastCtx) updateStatus(lastCtx);
        }
      })
      .catch(() => {
        // offline / layout change — older cache already loaded, stay silent
      })
      .finally(() => {
        clearTimeout(timer);
        goFetching = false;
      });
  }

  /** Monthly limit for a go model, or undefined when unknown/not go. */
  function goLimit(provider: string | undefined, id: string): GoLimit | undefined {
    if (!isGoModel(provider)) return undefined;
    if (goPrices === undefined) {
      goPrices = loadCache();
      if (goPrices === undefined) fetchGoPrices();
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
    // Vivid+bold: theme "success" -> bazowy ANSI green (blady); bold podbija do bright green.
    // Separator " | " oddziela zone-tag wyraznie od statusow innych extension.
    let status = ctx.ui.theme.bold(ctx.ui.theme.fg(zoneColor(zone), ` | [zone ${zone}]`));
    // Right of the zone: monthly go limit for opencode-go models only.
    lastCtx = ctx;
    const limit = goLimit(model.provider, model.id ?? "");
    if (limit !== undefined) {
      status += limitLabel(limit, (s) => ctx.ui.theme.bold(s), (c, s) => ctx.ui.theme.fg(c, s));
    }
    ctx.ui.setStatus("zones", status);
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    gatePending = true;
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
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    gatePending = false;
    ctx.ui.setStatus("zones", undefined);
  });

  // Prompt gate — only at session start / on model change, only interactively.
  pi.on("input", async (event, ctx) => {
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
      const go = isGoModel(model.provider)
        ? goLimit(model.provider, model.id ?? "")
        : undefined;
      const goInfo = isGoModel(model.provider)
        ? ` | go-limit: ${go === undefined ? "loading/unknown" : go}`
        : "";
      ctx.ui.notify(
        `${label} → zone ${zone}${overrides ? ` (override: ${overrides})` : ""}${goInfo}`,
        zone === "red" ? "error" : zone === "yellow" ? "warning" : "info",
      );
    },
  });
}