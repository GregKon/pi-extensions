import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Overrides the LLM model temperature.
 *   --temp 0.1   -> CLI flag (works in -p and interactively)
 *   /temp 0.7    -> interactive command, overrides the flag for the current session
 *
 * Value is read LAZILY at request time, because CLI flags are applied only
 * AFTER factories load (applyExtensionFlagValues). Reading getFlag() inside
 * the factory body always returns the default — old bug.
 */
export default function (pi: ExtensionAPI) {
  pi.registerFlag("temp", {
    description: "Set temperature (0-2). Usage: --temp 0.1",
    type: "string",
    default: "",
  });

  // Temperature set by /temp during the session (overrides the CLI flag).
  let commandTemp: number | undefined;

  function resolveTemp(): number | undefined {
    // A /temp from the session takes precedence over the CLI flag.
    if (commandTemp !== undefined) return commandTemp;
    const tempVal = pi.getFlag("temp");
    if (typeof tempVal !== "string" || tempVal === "") return undefined;
    const temp = parseFloat(tempVal);
    if (isNaN(temp) || temp < 0 || temp > 2) return undefined;
    return temp;
  }

  // ONE handler, registered unconditionally: it reads the value at request time.
  pi.on("before_provider_request", (event) => {
    const temp = resolveTemp();
    if (temp === undefined) return; // nothing to override
    if (!event.payload || typeof event.payload !== "object") return;
    // Documented contract: return the new payload.
    return { ...event.payload, temperature: temp };
  });

  pi.registerCommand("temp", {
    description: "Set temperature (0-2). Usage: /temp 0.7",
    handler: async (args, ctx) => {
      const val = parseFloat((args ?? "").trim());
      if (isNaN(val) || val < 0 || val > 2) {
        ctx.ui.notify(`Bad temperature: "${args}". Use 0-2.`, "error");
        return;
      }
      commandTemp = val;
      ctx.ui.notify(`Temperature set to ${val}`, "info");
    },
  });
}
