import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Checks pinned git extension packages for newer tags. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("check_git_extensions", {
    description:
      "Compare pinned git package refs in settings.json against the latest remote tags",
    handler: async (_args, ctx) => {
      const report = await checkGitExtensions();
      const summary = report.summary;
      writeReportFile(report);
      ctx.ui.notify(`${summary} — details: ${report.filePath}`);
    },
  });
}

interface GitPackage {
  source: string;
  repo: string; // host/path, e.g. "github.com/dbachelder/pi-btw"
  ref?: string; // pinned ref after '@', undefined when unpinned
}

interface Report {
  summary: string;
  rows: string[];
  filePath: string;
}

function agentSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function readGitPackages(): GitPackage[] {
  const settings = JSON.parse(readFileSync(agentSettingsPath(), "utf8")) as {
    packages?: unknown[];
  };
  const result: GitPackage[] = [];
  for (const entry of settings.packages ?? []) {
    const source: string = typeof entry === "string" ? entry : (entry as { source: string }).source;
    if (!source.startsWith("git:")) continue;
    const rest = source.slice("git:".length);
    const atIndex = rest.lastIndexOf("@");
    if (atIndex > 0) {
      result.push({ source, repo: rest.slice(0, atIndex), ref: rest.slice(atIndex + 1) });
    } else {
      result.push({ source, repo: rest });
    }
  }
  return result;
}

function stripTagPrefix(tag: string): string {
  const match = tag.match(/(?:\/|^)([vV]?[\d].*)$/);
  return match ? match[1] : tag;
}

function compareVersions(a: string, b: string): number {
  const toParts = (s: string) =>
    stripTagPrefix(s)
      .replace(/^[^0-9]+/, "")
      .split(/[.\-]/)
      .map((p) => parseInt(p, 10) || 0);
  const partsA = toParts(a);
  const partsB = toParts(b);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isVersionLike(tag: string): boolean {
  return /^[vV]?\.?\d+\.\d+/.test(stripTagPrefix(tag));
}

function latestTag(tags: string[]): string | undefined {
  const unique = new Set(tags.map((t) => t.replace(/\^\{\}$/, "")));
  let latest: string | undefined;
  for (const tag of unique) {
    if (!isVersionLike(tag)) continue;
    if (!latest || compareVersions(tag, latest) > 0) latest = tag;
  }
  return latest;
}

function looksLikeCommit(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** Namespace prefix of a ref: "raw-paste/v0.1.0" -> "raw-paste/", "v0.2.0" -> "". */
function namespaceOf(ref: string): string {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(0, i + 1) : "";
}

async function listRemoteTags(repo: string): Promise<string[]> {
  const url = `https://${repo}.git`;
  const output = await new Promise<string>((resolve, reject) => {
    execFile("git", ["ls-remote", "--tags", url], { timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  const tags: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/refs\/tags\/(.+)$/);
    if (match) tags.push(match[1].trim());
  }
  return tags;
}

async function checkGitExtensions(): Promise<Report> {
  const packages = readGitPackages();
  const rows: string[] = [];
  let ok = 0;
  let newer = 0;
  let unpinned = 0;
  let errors = 0;

  for (const pkg of packages) {
    if (!pkg.ref) {
      rows.push(`- ${pkg.repo}: unpinned (follow main) — pi notifies on updates`);
      unpinned++;
      continue;
    }
    try {
      const tags = await listRemoteTags(pkg.repo);
      // Pin must exist as an actual tag (or be a commit SHA). A namespaced tag
      // like "usage-extension/v0.9.4" does NOT satisfy a pin of "v0.9.4" — only
      // comparing version numbers would report a false OK for a broken pin.
      if (!tags.includes(pkg.ref) && !looksLikeCommit(pkg.ref)) {
        rows.push(`- ${pkg.repo}: PIN NOT FOUND — tag "${pkg.ref}" doesn't exist on remote`);
        errors++;
        continue;
      }
      const latest = latestTag(
        // Monorepos namespace tags per sub-project (e.g. "raw-paste/v0.1.0").
        // Find the latest within the pin's own namespace, otherwise a higher
        // version from another sub-project (e.g. "usage-extension/v0.9.4")
        // yields a false NEWER.
        tags.filter((t) => t.startsWith(namespaceOf(pkg.ref))),
      );
      if (!latest) {
        rows.push(`- ${pkg.repo}: no version tags found (pin: ${pkg.ref})`);
        continue;
      }
      if (compareVersions(latest, pkg.ref) > 0) {
        rows.push(`- ${pkg.repo}: NEWER ${latest} available (pin: ${pkg.ref})`);
        newer++;
      } else {
        rows.push(`- ${pkg.repo}: OK (pin: ${pkg.ref}, latest: ${latest})`);
        ok++;
      }
    } catch (error) {
      rows.push(`- ${pkg.repo}: check failed (${error instanceof Error ? error.message : String(error)})`);
      errors++;
    }
  }

  const summary = `git extensions: ${ok} ok, ${newer} newer, ${unpinned} unpinned, ${errors} errors`;
  const filePath = join(homedir(), ".pi", "agent", "data", "git-extension-check.md");
  return { summary, rows, filePath };
}

function writeReportFile(report: Report): void {
  const header = `# git extension check — ${new Date().toISOString()}\n\n${report.summary}\n\n`;
  mkdirSync(join(homedir(), ".pi", "agent", "data"), { recursive: true });
  writeFileSync(report.filePath, header + report.rows.join("\n") + "\n");
}