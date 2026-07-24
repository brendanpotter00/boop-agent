import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { enumerateMarkdown, vaultRoot } from "./paths.js";

/**
 * Parses `wiki/index.md` — the vault's hand-curated catalog where every page
 * is one bullet `- [[slug]] — one-line hook`, grouped under `##`/`###`
 * category headings. This is the single highest-quality, already-maintained
 * ranking signal in the system, so the lexical pass leans on it heavily.
 *
 * Both the parsed entries and the slug→path map are cached and invalidated by
 * `index.md`'s mtime, so repeated searches in one session don't re-read disk.
 */

export interface IndexEntry {
  /** The slug inside `[[ ]]`, e.g. "saronic-hm-real-may-18". */
  slug: string;
  /** The one-line hook after the em dash (markdown stripped of `[[ ]]`). */
  hook: string;
  /** Nearest preceding `##`/`###` heading, e.g. "Stories". */
  category: string;
}

const INDEX_REL = "wiki/index.md";

// `- [[slug]] — hook`  /  `- [[slug|alias]] — hook` (em dash, en dash, or `-`)
const BULLET = /^\s*[-*]\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*[—–-]\s*(.*)$/;
const HEADING = /^#{2,6}\s+(.*)$/;

let indexCache:
  | { mtimeMs: number; entries: IndexEntry[] }
  | null = null;

let slugCache:
  | { mtimeMs: number; builtAt: number; map: Map<string, string> }
  | null = null;

/** How long a slug→path map is trusted before the vault is re-walked. */
const SLUG_TTL_MS = 60_000;

async function indexMtime(): Promise<number> {
  try {
    return (await stat(join(vaultRoot(), INDEX_REL))).mtimeMs;
  } catch {
    return 0;
  }
}

/** Parsed `wiki/index.md` entries, cached by mtime. Empty if absent. */
export async function parseIndex(): Promise<IndexEntry[]> {
  const mtimeMs = await indexMtime();
  if (indexCache && indexCache.mtimeMs === mtimeMs) return indexCache.entries;

  let text = "";
  try {
    text = await readFile(join(vaultRoot(), INDEX_REL), "utf8");
  } catch {
    // NEVER cache a failed read. `index.md` is rewritten in place by the
    // vault's ingest workflow, so a read landing mid-rewrite fails even though
    // the file is fine a moment later. Caching that empty result keyed by the
    // *new* mtime pinned wiki_index to "index is empty" permanently: the write
    // that broke the read is the same write that set the mtime we cached
    // against, so nothing ever invalidated it again. Serve the last
    // known-good catalog and retry on the next call instead.
    return indexCache?.entries ?? [];
  }

  const entries: IndexEntry[] = [];
  let category = "";
  for (const line of text.split("\n")) {
    const h = HEADING.exec(line);
    if (h) {
      category = h[1].trim();
      continue;
    }
    const m = BULLET.exec(line);
    if (m) {
      entries.push({
        slug: m[1].trim(),
        // Strip wikilink brackets from the hook so it reads cleanly in results.
        hook: m[2].replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1").trim(),
        category,
      });
    }
  }
  indexCache = { mtimeMs, entries };
  return entries;
}

/**
 * Map of slug (markdown filename without `.md`) → vault-relative path. Obsidian
 * resolves `[[wikilinks]]` by filename and filenames are unique across `wiki/`,
 * so this lets us turn an index/wikilink slug into a readable path. On a rare
 * cross-section collision, the curated `wiki/` copy wins over `raw/`.
 *
 * Invalidated by `index.md`'s mtime (the ingest workflow touches it whenever
 * pages are added/removed) *and* a short TTL, so pages added outside an ingest
 * run still become readable without a restart.
 */
export async function slugMap(): Promise<Map<string, string>> {
  const mtimeMs = await indexMtime();
  // `index.md`'s mtime alone is too weak a signal: a page added or renamed
  // without an ingest run leaves the map stale, so `wiki_read [[slug]]` 404s on
  // a page that exists. Pair it with a short TTL so the map self-heals.
  if (
    slugCache &&
    slugCache.mtimeMs === mtimeMs &&
    Date.now() - slugCache.builtAt < SLUG_TTL_MS
  ) {
    return slugCache.map;
  }
  const files = await enumerateMarkdown();
  const map = new Map<string, string>();
  for (const f of files) {
    const slug = f.rel.replace(/^.*\//, "").replace(/\.md$/, "");
    const existing = map.get(slug);
    if (!existing || (f.section === "wiki" && !existing.startsWith("wiki/"))) {
      map.set(slug, f.rel);
    }
  }
  // An empty map means the walk found nothing — a transient vault read error,
  // not a real answer. Caching it would poison slug resolution the same way a
  // cached empty catalog poisoned wiki_index; keep the previous map instead.
  if (map.size === 0 && slugCache) return slugCache.map;
  slugCache = { mtimeMs, builtAt: Date.now(), map };
  return map;
}

/** Resolve an index/wikilink slug to a vault-relative path, or null. */
export async function resolveSlug(slug: string): Promise<string | null> {
  return (await slugMap()).get(slug) ?? null;
}
