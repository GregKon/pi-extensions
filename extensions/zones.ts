/**
 * zones — traffic-light "zone" indicator + prompt gate for the active model.
 *
 * Zone = safety level of the active model:
 *   green  — local model: provider/model name contains 'local' (e.g. apiKey: "local")
 *   red    — model name contains 'free' OR provider is nvidia/google (they train on your data)
 *   yellow — everything else
 *
 * Zone can be overridden by a file in the directory where pi was opened (cwd):
 *   .zonegreen / .zoneyellow / .zonered   (precedence: red > yellow > green)
 *
 * UI (option B): colored zone indicator as a widget above the editor. pi's own footer stays intact.
 *
 * Prompt gate — only at session start (also on /resume):
 *   green  -> nothing
 *   yellow -> ask once: user must type "yes" before the prompt is sent
 *   red    -> ask twice
 * Once confirmed, the rest of the prompts in that session pass normally.
 * Gate runs only in interactive (TUI) mode; it never blocks rpc/print/json.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Zone = "green" | "yellow" | "red";

const RED_PROVIDERS = ["nvidia", "google"];

/** Precedence of zone override files in cwd: red > yellow > green. */
function fileOverride(cwd: string): Zone | undefined {
  if (!cwd) return undefined;
  if (existsSync(join(cwd, ".zonered"))) return "red";
  if (existsSync(join(cwd, ".zoneyellow"))) return "yellow";
  if (existsSync(join(cwd, ".zonegreen"))) return "green";
  return undefined;
}

/** Auto-detect zone from the model. */
function autoZone(provider: string, id: string, name: string): Zone {
  const p = (provider || "").toLowerCase();
  const i = (id || "").toLowerCase();
  const n = (name || "").toLowerCase();

  // green: local model — 'local' in provider/model name (apiKey: "local")
  if (p.includes("local") || i.includes("local") || n.includes("local")) return "green";

  // red: 'free' in the name, or provider is nvidia/google
  if (i.includes("free") || n.includes("free")) return "red";
  if (RED_PROVIDERS.some((rp) => p.includes(rp))) return "red";

  // everything else -> yellow
  return "yellow";
}

function computeZone(provider: string, id: string, name: string, cwd: string): Zone {
  return fileOverride(cwd) ?? autoZone(provider, id, name);
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

export default function (pi: ExtensionAPI) {
  // Session state — reset on every start (also /resume, /new, /fork).
  let gatePending = false;
  let cwd = "";

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    gatePending = true;
    updateWidget(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateWidget(ctx);
  });

  pi.on("session_shutdown", async () => {
    gatePending = false;
  });

  // Colored zone indicator above the editor (option B — pi's footer untouched).
  function updateWidget(ctx: { model?: unknown; thinkingLevel?: string; mode?: string }) {
    if (ctx.mode !== "tui") return;
    const model = ctx.model as
      | { provider?: string; id?: string; name?: string; reasoning?: boolean }
      | undefined;
    ctx.ui.setWidget("zones", (tui, theme) => {
      let lines: string[] = [];
      if (model) {
        const provider = model.provider ?? "";
        const id = model.id ?? "";
        const name = model.name ?? "";
        const zone = computeZone(provider, id, name, cwd);
        const label = modelLabel(provider, id, name, ctx.thinkingLevel, model.reasoning);
        lines = [theme.fg(zoneColor(zone), `[${zone}] ${label}`)];
      }
      return { render: () => lines, invalidate: () => {} };
    });
  }

  // Prompt gate — only at session start, only interactively.
  pi.on("input", async (event, ctx) => {
    if (ctx.mode !== "tui") return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };
    if (!gatePending) return { action: "continue" };

    const model = ctx.model as
      | { provider?: string; id?: string; name?: string; reasoning?: boolean }
      | undefined;
    if (!model) return { action: "continue" };

    const provider = model.provider ?? "";
    const id = model.id ?? "";
    const name = model.name ?? "";
    const zone = computeZone(provider, id, name, cwd);

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
      const model = ctx.model as
        | { provider?: string; id?: string; name?: string; reasoning?: boolean }
        | undefined;
      if (!model) {
        ctx.ui.notify("No active model", "info");
        return;
      }
      const zone = computeZone(model.provider ?? "", model.id ?? "", model.name ?? "", cwd);
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
      ctx.ui.notify(
        `${label} → zone ${zone}${overrides ? ` (override: ${overrides})` : ""}`,
        zone === "red" ? "error" : zone === "yellow" ? "warning" : "info",
      );
    },
  });
}
