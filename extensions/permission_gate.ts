import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * permission_gate — tells the model what the pi-hooks permission level actually means, and
 * gates the first prompt when the session starts above a threshold.
 *
 * Why: pi-hooks (prateekmedia/pi-hooks) never puts the level into the model's context, so the
 * model cannot know what is gated or that a dialog is even possible. We read the same key
 * (`permissionLevel`) from the same file pi-hooks writes, mirror the level into the system
 * prompt, and — above the threshold — ask before the first prompt is sent (same pattern as
 * zones.ts).
 *
 * Deliberately NOT copied from pi-hooks: the command classifier (which command needs which
 * level). Listing commands here would silently rot whenever upstream changes its tables.
 * Instead we watch the pin: if pi-hooks moves off VERIFIED_PI_HOOKS, we warn so a human can
 * re-read their diff. Text describes the mechanism, never the command lists.
 *
 * Known limitations (accepted):
 *   - the gate is interactive-only (TUI + `event.source === "interactive"`), so print/RPC/json
 *     modes are never swallowed: in `-p` the block is still injected, but nothing is blocked —
 *     what pi-hooks would gate is either allowed or blocked by pi-hooks itself,
 *   - a session-only level change (`/permission medium` → "Session only") lives in pi-hooks
 *     memory and is invisible here; we only see the value persisted in settings.json,
 *   - we cannot detect whether pi-hooks is loaded at all (no API lists loaded extensions),
 *     so in a profile without it the injected text describes a gate that is not there.
 *
 * Config in ~/.pi/agent/settings.json:
 *   "permissionGate": { "threshold": "low", "gate": true }
 */

type Level = "minimal" | "low" | "medium" | "high" | "bypassed";

const LEVELS: Level[] = ["minimal", "low", "medium", "high", "bypassed"];

/** pi-hooks version whose behaviour this file was written against. */
const VERIFIED_PI_HOOKS = "1.0.2";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

const BLOCK = `## Shell and permissions
\`read\`/\`edit\`/\`write\`/\`grep\`/\`find\`/\`ls\` are never gated — use them instead of shell
equivalents (\`cat\`, \`awk\`, \`python -c\`, \`node -e\`). Some shell commands need approval: the
user gets a dialog. A bash call is graded by its worst segment: \`;\`, \`&&\`, \`|\` and
\`$(...)\` split it, and unknown commands default to high — so one \`python -c\` or a
substitution gates an otherwise read-only chain; give such a step its own call. Need more than
the current level? Say so in text — never chain commands to slip past a prompt.`;

interface GateConfig {
  threshold: Level;
  gate: boolean;
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asLevel(value: unknown): Level | undefined {
  const level = typeof value === "string" ? value.toLowerCase() : "";
  return LEVELS.includes(level as Level) ? (level as Level) : undefined;
}

/** Same precedence as pi-hooks handleSessionStart: env var, then settings, then minimal. */
function resolveLevel(settings: Record<string, unknown>): Level {
  return asLevel(process.env.PI_PERMISSION_LEVEL) ?? asLevel(settings.permissionLevel) ?? "minimal";
}

function resolveConfig(settings: Record<string, unknown>): GateConfig {
  const raw = settings.permissionGate;
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    threshold: asLevel(cfg.threshold) ?? "low",
    gate: cfg.gate !== false,
  };
}

/** Installed pin of pi-hooks, e.g. "git:github.com/prateekmedia/pi-hooks@1.0.2" -> "1.0.2". */
function piHooksPin(settings: Record<string, unknown>): string | undefined {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  for (const entry of packages) {
    const source =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string"
          ? ((entry as { source: string }).source)
          : "";
    if (!source.includes("prateekmedia/pi-hooks")) continue;
    const pin = source.split("@").pop() ?? "";
    return pin.replace(/^v/, "") || undefined;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let level: Level = "minimal";
  let config: GateConfig = { threshold: "low", gate: true };
  let drift: string | undefined;
  let gatePending = false;

  function refresh(): void {
    const settings = readSettings();
    level = resolveLevel(settings);
    config = resolveConfig(settings);
    const pin = piHooksPin(settings);
    drift = pin === VERIFIED_PI_HOOKS ? undefined : pin ? `${pin} != ${VERIFIED_PI_HOOKS}` : "brak wpisu w packages";
  }

  pi.on("session_start", (_event, ctx) => {
    refresh();
    // Gate only above the threshold; at or below it the block (if any) is enough.
    gatePending = config.gate && LEVELS.indexOf(level) > LEVELS.indexOf(config.threshold);
    if (!ctx.hasUI) return;
    if (drift) {
      ctx.ui.notify(`permission_gate: pi-hooks ${drift} — sprawdź założenia (permission_gate.ts)`, "warning");
      ctx.ui.setStatus("permgate", " | [pi-hooks?]");
    }
    if (gatePending) {
      ctx.ui.notify(`permission_gate: poziom ${level} — potwierdź pierwszy prompt`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    gatePending = false;
    ctx.ui.setStatus("permgate", undefined);
  });

  // Ask before the first prompt when the level is above the threshold. Interactive only.
  // `select` (list dialog) instead of `input` on purpose: zones.ts already uses an input box at
  // session start, and two identical-looking input dialogs are easy to confuse. The input
  // component also hardcodes `theme.fg("accent", title)` and has no background, so the only
  // way to look different is a different component.
  pi.on("input", async (event, ctx) => {
    if (!gatePending) return { action: "continue" };
    if (ctx.mode !== "tui") return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };

    const SEND = "Send anyway";
    const choice = await ctx.ui.select(
      `permission_gate: level "${level}" is above "${config.threshold}" — send this prompt?`,
      [SEND, "Cancel"],
    );
    if (choice === SEND) {
      gatePending = false;
      return { action: "continue" };
    }

    ctx.ui.notify(`Prompt NOT sent (permission level ${level}).`, "warning");
    return { action: "handled" };
  });

  // Mirror the level into the system prompt — only at the threshold (low by default).
  pi.on("before_agent_start", (event) => {
    if (level !== config.threshold) return;
    const opts = event.systemPromptOptions;
    opts.appendSystemPrompt = opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n${BLOCK}` : BLOCK;
  });

  pi.registerCommand("permission-gate", {
    description: "Show permission_gate state (level, threshold, pi-hooks pin drift)",
    handler: async (_args, ctx) => {
      refresh();
      const pin = drift ? `drift: ${drift}` : `pin ${VERIFIED_PI_HOOKS} (verified)`;
      ctx.ui.notify(
        `permission_gate: level=${level}, threshold=${config.threshold}, gate=${config.gate ? "on" : "off"}, block=${level === config.threshold ? "injected" : "not injected"}, ${pin}`,
        drift ? "warning" : "info",
      );
    },
  });
}
