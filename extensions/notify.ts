/**
 * Pi Notify Extension
 *
 * Emits OSC 777 notification when Pi settles (finished work).
 * Title: session name (e.g. "extension")
 * Body: last 3 words of the last user prompt + time + run duration.
 *
 * Toggle: /notify on|off (default OFF, persisted in ~/.pi/agent/notify-config.json)
 *
 * OSC 777 is parsed natively by VS Code 1.131+ (and Ghostty/iTerm2/WezTerm),
 * and flows through SSH to the local terminal.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "notify-config.json");

let lastPrompt: string | undefined;
let runStart: number | undefined;

function fmtDur(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function loadEnabled(): boolean {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		return JSON.parse(raw).enabled === true;
	} catch {
		return false; // default OFF
	}
}

function saveEnabled(enabled: boolean): void {
	writeFileSync(CONFIG_PATH, JSON.stringify({ enabled }, null, 2) + "\n");
}

function sanitize(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/;/g, ",").trim();
}

function lastWords(text: string, count: number): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	return words.slice(-count).join(" ");
}

function getText(message: { content: unknown[] }): string {
	return message.content
		.filter((block): block is { type: string; text: string } => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${sanitize(title)};${sanitize(body)}\x07`);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", async () => {
		runStart = Date.now();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "user") {
			const text = getText(event.message);
			if (text.trim()) lastPrompt = text;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!loadEnabled()) return;
		if (!ctx.isIdle()) return;
		const sessionName = pi.getSessionName() || "pi";
		let body = lastPrompt ? lastWords(lastPrompt, 3) : "done";
		const end = Date.now();
		body += ` · ${new Date(end).toLocaleTimeString("pl-PL", { hour12: false })}`;
		if (runStart !== undefined) body += ` · total ${fmtDur(end - runStart)}`;
		runStart = undefined;

		notifyOSC777(sessionName, body);
	});

	pi.registerCommand("notify", {
		description: "Toggle finish notifications: /notify on|off (default off), /notify shows status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				saveEnabled(true);
				ctx.ui.notify("Finish notifications: ON", "info");
			} else if (arg === "off") {
				saveEnabled(false);
				ctx.ui.notify("Finish notifications: OFF", "info");
			} else {
				ctx.ui.notify(
					`Notifications: ${loadEnabled() ? "ON" : "OFF"} — use /notify on|off`,
					"info",
				);
			}
		},
	});
}
