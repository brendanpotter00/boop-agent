import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Read-only filesystem access to the Obsidian vault that backs boop's wiki
 * tools. The vault is the SOURCE OF TRUTH; nothing here ever writes to it.
 *
 * The vault root is configured via `WIKI_VAULT_PATH` and is NEVER hardcoded —
 * boop-agent is a public repo, so no real paths may land in committed code.
 * Every path derived from a tool argument is guarded so it can never escape
 * the vault (`..`, absolute paths, symlinks) and only `.md` files are served.
 */

export class WikiNotConfiguredError extends Error {
  constructor() {
    super(
      "wiki not configured — set WIKI_VAULT_PATH to your Obsidian vault root",
    );
    this.name = "WikiNotConfiguredError";
  }
}

/** True when a vault path is configured. Lets tools degrade gracefully. */
export function wikiConfigured(): boolean {
  return !!process.env.WIKI_VAULT_PATH;
}

let cachedRoot: { raw: string; resolved: string } | null = null;

/**
 * Absolute, symlink-resolved vault root. Throws `WikiNotConfiguredError` when
 * `WIKI_VAULT_PATH` is unset so callers can return a clear "not configured"
 * message instead of leaking a stack trace.
 */
export function vaultRoot(): string {
  const raw = process.env.WIKI_VAULT_PATH;
  if (!raw) throw new WikiNotConfiguredError();
  if (cachedRoot && cachedRoot.raw === raw) return cachedRoot.resolved;
  const resolved = realpathSync(resolve(raw));
  cachedRoot = { raw, resolved };
  return resolved;
}

/**
 * Which subtrees under the vault are searchable. Default = the curated `wiki/`
 * only (the safe, generic default). Set `WIKI_SYNC_INCLUDE` (comma-separated,
 * vault-relative) to opt specific `raw/` source subtrees in — e.g. an
 * auto-ingested meeting-transcript folder — without changing committed code.
 */
export function includeRoots(): string[] {
  const cfg = process.env.WIKI_SYNC_INCLUDE;
  if (cfg) return cfg.split(",").map((s) => s.trim()).filter(Boolean);
  return ["wiki"];
}

/** "wiki" for curated pages, "raw" for unsynthesized sources (transcripts). */
export function sectionOf(relPath: string): "wiki" | "raw" {
  return relPath === "wiki" || relPath.startsWith(`wiki${sep}`) || relPath.startsWith("wiki/")
    ? "wiki"
    : "raw";
}

// Files that are navigation/meta rather than content — excluded from search
// and enumeration so they don't pollute results.
const SKIP_RELATIVE = new Set([
  "wiki/index.md",
  "wiki/log.md",
  "raw/index.md",
  "raw/_tree.md",
]);

function normalizeRel(relPath: string): string {
  return relPath.split(sep).join("/");
}

/**
 * Resolve a vault-relative path to an absolute path, rejecting anything that
 * escapes the vault or is not a markdown file. Used by `wiki_read`.
 */
export function safeResolve(relPath: string): string {
  if (relPath.includes("\0")) throw new Error("invalid path");
  const root = vaultRoot();
  const abs = resolve(root, relPath);
  if (!abs.endsWith(".md")) throw new Error("only .md files are readable");
  // Resolve symlinks if the file exists; fall back to the lexical path so a
  // not-yet-created file still gets the containment check.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    real = abs;
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path escapes the vault");
  }
  return real;
}

/**
 * Canonical dedup key for a page: its real, lowercased path. macOS is
 * case-insensitive, so two hits that differ only in case are the SAME page —
 * lowercasing here is what guarantees the unified search returns one entry
 * per page (the R1 single-surface guarantee).
 */
export function dedupKey(absPath: string): string {
  let real = absPath;
  try {
    real = realpathSync(absPath);
  } catch {
    /* keep lexical path */
  }
  return real.toLowerCase();
}

export interface VaultFile {
  /** Vault-relative path with forward slashes, e.g. "wiki/people/jared.md". */
  rel: string;
  /** Absolute, symlink-resolved path. */
  abs: string;
  section: "wiki" | "raw";
}

const IGNORED_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);

/**
 * Walk the configured include roots and yield every content markdown file,
 * skipping meta files and hidden/system directories. Read-only.
 */
export async function enumerateMarkdown(): Promise<VaultFile[]> {
  const root = vaultRoot();
  const out: VaultFile[] = [];
  for (const includeRel of includeRoots()) {
    const start = resolve(root, includeRel);
    // Containment guard for configured roots too.
    const rel0 = relative(root, start);
    if (rel0.startsWith("..") || isAbsolute(rel0)) continue;
    await walk(start, root, out);
  }
  return out;
}

async function walk(dir: string, root: string, out: VaultFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing include root is fine (e.g. raw/career/cisco absent)
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, root, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const rel = normalizeRel(relative(root, abs));
      if (SKIP_RELATIVE.has(rel)) continue;
      out.push({ rel, abs, section: sectionOf(rel) });
    }
  }
}
