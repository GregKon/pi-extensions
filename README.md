# pi-extensions

Pi extensions by GregKon. Install as a [pi package](https://pi.dev/packages) via git.

## Extensions

| Extension | Command / flag | What it does |
|---|---|---|
| `low-temp.ts` | `--temp 0.1` · `/temp 0.7` | Override the LLM model temperature (0–2). CLI flag works in `-p` and interactive mode; `/temp` overrides it for the current session. |
| `notify.ts` | `/notify on\|off` | Emit an OSC 777 desktop notification when Pi settles (finished work). Default OFF, state persisted in `~/.pi/agent/notify-config.json`. |
| `check_git_extensions.ts` | `/check_git_extensions` | Compare pinned `git:` packages in `~/.pi/agent/settings.json` against the latest remote tags. Writes a report to `~/.pi/agent/data/git-extension-check.md`. |

## Install

```bash
pi install git:github.com/GregKon/pi-extensions@v0.2.0
```

or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/GregKon/pi-extensions@v0.2.0"
  ]
}
```

## Requirements

- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (declared as a peer dependency; pi bundles it).

## License

MIT
