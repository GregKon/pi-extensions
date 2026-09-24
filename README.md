# pi-extensions

Pi extensions by GregKon. Install as a [pi package](https://pi.dev/packages) via git.

## Extensions

| Extension | Command / flag | What it does |
|---|---|---|
| `low-temp.ts` | `--temp 0.1` · `/temp 0.7` | Override the LLM model temperature (0–2). CLI flag works in `-p` and interactive mode; `/temp` overrides it for the current session. |
| `notify.ts` | `/notify on\|off` | Emit an OSC 777 desktop notification when Pi settles (finished work). Default OFF, state persisted in `~/.pi/agent/notify-config.json`. |
| `zones.ts` | widget + prompt gate | Traffic-light zone (green/yellow/red) for the active model. Colored indicator above the editor; overridable via `.zonegreen`/`.zoneyellow`/`.zonered` in cwd; prompt gate (type `yes`) at session start for yellow (1×) / red (2×). See `/zone`. |
| `check_git_extensions.ts` | `/check_git_extensions` | Compare pinned `git:` packages in `~/.pi/agent/settings.json` against the latest remote tags. Writes a report to `~/.pi/agent/data/git-extension-check.md`. |
| `permission_gate.ts` | `/permission-gate` | Mirror the pi-hooks permission level into the model's context and gate the first prompt above a threshold. Injects a short block **only** at the threshold level (`low` by default) so the model knows built-in tools are never gated and that approval dialogs exist; above the threshold it shows a list dialog before the first prompt is sent (interactive TUI only — print/RPC are never swallowed). Also warns when the pinned pi-hooks version differs from the verified one (`VERIFIED_PI_HOOKS`), because the injected text must be re-checked when upstream changes. Config: `"permissionGate": { "threshold": "low", "gate": true }`. |

## Install

```bash
pi install git:github.com/GregKon/pi-extensions@v0.5.0
```

or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/GregKon/pi-extensions@v0.5.0"
  ]
}
```

## Requirements

- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (declared as a peer dependency; pi bundles it).

## License

MIT
