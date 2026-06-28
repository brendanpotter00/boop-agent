import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  dedupKey,
  enumerateMarkdown,
  safeResolve,
  sectionOf,
  vaultRoot,
  wikiConfigured,
  type VaultFile,
} from "./paths.js";
import { parseIndex, resolveSlug, slugMap } from "./index-cache.js";

/**
 * The unified wiki search. There is exactly ONE search surface (`wikiSearch`)
 * that fuses a SEMANTIC pass (Convex embeddings — Phase 2) and a LEXICAL pass
 * (the curated `index.md` hooks + a full-text scan) and dedupes by canonical
 * page path. The agent therefore only ever sees a single ranked list — the
 * reconciliation the user worried about happens once, inside this module.
 *
 * Phase 1 ships the lexical pass only; `semanticPass()` is a stub that returns
 * nothing, so `fuse()` degrades to lexical-only. When Phase 2 lands, the agent
 * surface does not change — only `semanticPass()` starts returning hits.
 */

const READ_CAP_BYTES = 24_000;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "my", "me", "i", "you", "it", "this", "that",
  "what", "whats", "how", "do", "does", "did", "about", "from", "at", "as", "by",
]);

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Lexical pass
// ---------------------------------------------------------------------------

interface LexHit {
  rel: string;
  section: "wiki" | "raw";
  title: string;
  hookScore: number;
  grepScore: number;
  snippet: string;
}

// Small mtime-keyed content cache so repeated searches in a session don't
// re-read every file. At 10x scale the semantic pass (Phase 2) carries the
// load and this full scan becomes a fallback.
const contentCache = new Map<string, { mtimeMs: number; text: string }>();

async function readCached(f: VaultFile): Promise<string> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(f.abs)).mtimeMs;
  } catch {
    return "";
  }
  const hit = contentCache.get(f.abs);
  if (hit && hit.mtimeMs === mtimeMs) return hit.text;
  let text = "";
  try {
    text = await readFile(f.abs, "utf8");
  } catch {
    text = "";
  }
  contentCache.set(f.abs, { mtimeMs, text });
  return text;
}

function scoreText(tokens: string[], phrase: string, hay: string): number {
  if (tokens.length === 0) return 0;
  const lc = hay.toLowerCase();
  let matched = 0;
  for (const t of tokens) if (lc.includes(t)) matched++;
  let score = matched / tokens.length;
  if (phrase.length >= 4 && lc.includes(phrase)) score = Math.min(1, score + 0.4);
  return score;
}

function firstContentLine(text: string, tokens: string[]): string {
  const lines = text.split("\n");
  // Skip YAML frontmatter.
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++;
  }
  // Prefer the first line that contains a query token.
  for (let j = i; j < lines.length; j++) {
    const l = lines[j].trim();
    if (!l || l.startsWith("#")) continue;
    if (tokens.some((t) => l.toLowerCase().includes(t))) return l.slice(0, 200);
  }
  for (let j = i; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l && !l.startsWith("#")) return l.slice(0, 200);
  }
  return "";
}

export async function lexicalPass(
  query: string,
  section?: "wiki" | "raw",
): Promise<Map<string, LexHit>> {
  const tokens = tokenize(query);
  const phrase = query.toLowerCase().trim();
  const out = new Map<string, LexHit>();

  // (a) Curated index.md hooks — the strongest lexical signal.
  const entries = await parseIndex();
  const map = await slugMap();
  for (const e of entries) {
    const rel = map.get(e.slug);
    if (!rel) continue;
    const sec = sectionOf(rel);
    if (section && sec !== section) continue;
    const hookScore = scoreText(tokens, phrase, `${e.slug} ${e.hook} ${e.category}`);
    if (hookScore <= 0) continue;
    const key = dedupKey(vaultRoot() + "/" + rel);
    out.set(key, {
      rel,
      section: sec,
      title: humanizeSlug(e.slug),
      hookScore,
      grepScore: 0,
      snippet: e.hook.slice(0, 200),
    });
  }

  // (b) Full-text scan over the included files (catches body matches and any
  // page not yet present in index.md — e.g. raw transcripts).
  const files = await enumerateMarkdown();
  for (const f of files) {
    if (section && f.section !== section) continue;
    const text = await readCached(f);
    if (!text) continue;
    const slug = basename(f.rel).replace(/\.md$/, "");
    const grepScore = scoreText(tokens, phrase, `${slug} ${text}`);
    if (grepScore <= 0) continue;
    const key = dedupKey(f.abs);
    const existing = out.get(key);
    if (existing) {
      existing.grepScore = Math.max(existing.grepScore, grepScore);
      if (!existing.snippet) existing.snippet = firstContentLine(text, tokens);
    } else {
      out.set(key, {
        rel: f.rel,
        section: f.section,
        title: humanizeSlug(slug),
        hookScore: 0,
        grepScore,
        snippet: firstContentLine(text, tokens),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Semantic pass (Phase 2 — Convex embeddings). Stub for now.
// ---------------------------------------------------------------------------

export interface SemHit {
  rel: string;
  section: "wiki" | "raw";
  title: string;
  semScore: number;
  snippet: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function semanticPass(
  _query: string,
  _section?: "wiki" | "raw",
  _limit?: number,
): Promise<Map<string, SemHit>> {
  // Phase 2 wires this to `embed()` + `convex.action(api.wikiChunks.vectorSearch)`,
  // collapsing chunk hits to one entry per page (max chunk score). Until then,
  // returning empty makes `fuse()` degrade cleanly to lexical-only.
  return new Map();
}

// ---------------------------------------------------------------------------
// Fuse — one deduped, ranked list (the R1 single-surface guarantee)
// ---------------------------------------------------------------------------

export interface FusedHit {
  rel: string;
  title: string;
  section: "wiki" | "raw";
  score: number;
  snippet: string;
  why: string;
}

const W_SEM = 0.6;
const W_LEX = 0.4;
const CURATED_BOOST = 0.05;
const AGREEMENT_BONUS = 0.1;

export function fuse(
  lex: Map<string, LexHit>,
  sem: Map<string, SemHit>,
): FusedHit[] {
  const keys = new Set([...lex.keys(), ...sem.keys()]);
  const fused: FusedHit[] = [];
  for (const key of keys) {
    const l = lex.get(key);
    const s = sem.get(key);
    const lexScore = l ? Math.max(l.hookScore, 0.7 * l.grepScore) : 0;
    const semScore = s ? s.semScore : 0;
    const hasLex = lexScore > 0;
    const hasSem = semScore > 0;
    // Present-weight normalization: a single-signal page isn't penalized for
    // the missing signal.
    const den = W_SEM * (hasSem ? 1 : 0) + W_LEX * (hasLex ? 1 : 0);
    if (den === 0) continue;
    const base = (W_SEM * semScore + W_LEX * lexScore) / den;
    const rel = (l ?? s)!.rel;
    const section = (l ?? s)!.section;
    const score =
      base +
      (hasSem && hasLex ? AGREEMENT_BONUS : 0) +
      (section === "wiki" ? CURATED_BOOST : 0);
    const parts: string[] = [];
    if (hasSem) parts.push("sem");
    if (l && l.hookScore > 0) parts.push("hook");
    if (l && l.grepScore > 0) parts.push("grep");
    fused.push({
      rel,
      title: (l ?? s)!.title,
      section,
      score,
      snippet: (l?.snippet || s?.snippet || "").slice(0, 200),
      why: `${score.toFixed(2)} ${parts.join("+")}`,
    });
  }
  fused.sort((a, b) => b.score - a.score);
  return fused;
}

// ---------------------------------------------------------------------------
// Public tool entry points
// ---------------------------------------------------------------------------

export async function wikiSearch(opts: {
  query: string;
  section?: "wiki" | "raw";
  limit?: number;
}): Promise<string> {
  if (!wikiConfigured()) {
    return "wiki not configured — set WIKI_VAULT_PATH to your Obsidian vault root.";
  }
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
  const [lex, sem] = await Promise.all([
    lexicalPass(opts.query, opts.section),
    semanticPass(opts.query, opts.section, limit * 4),
  ]);
  const hits = fuse(lex, sem).slice(0, limit);
  if (hits.length === 0) {
    return `No wiki pages matched "${opts.query}". Try wiki_index to browse the catalog.`;
  }
  const body = hits
    .map((h) => `• ${h.rel} — ${h.snippet}  [${h.why}]`)
    .join("\n");
  return `Top ${hits.length} wiki pages for "${opts.query}" (read with wiki_read):\n${body}`;
}

export async function wikiRead(opts: { path: string }): Promise<string> {
  if (!wikiConfigured()) {
    return "wiki not configured — set WIKI_VAULT_PATH to your Obsidian vault root.";
  }
  // Accept either a vault-relative path or a bare [[slug]].
  let rel = opts.path.trim().replace(/^\[\[|\]\]$/g, "");
  if (!rel.endsWith(".md")) {
    const resolved = await resolveSlug(rel.replace(/^.*\//, ""));
    if (resolved) rel = resolved;
    else rel = `${rel}.md`;
  }
  let abs: string;
  try {
    abs = safeResolve(rel);
  } catch (err) {
    return `Cannot read "${opts.path}": ${(err as Error).message}`;
  }
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    return `Page not found: ${rel}. Use wiki_search or wiki_index to find the right path.`;
  }
  if (Buffer.byteLength(text, "utf8") > READ_CAP_BYTES) {
    text = text.slice(0, READ_CAP_BYTES) + "\n\n…[truncated — page longer than 24KB]";
  }
  return `# ${rel}\n\n${text}`;
}

export async function wikiIndex(opts: { category?: string }): Promise<string> {
  if (!wikiConfigured()) {
    return "wiki not configured — set WIKI_VAULT_PATH to your Obsidian vault root.";
  }
  const entries = await parseIndex();
  if (entries.length === 0) {
    return "wiki index is empty or wiki/index.md is missing.";
  }
  const filter = opts.category?.toLowerCase();
  const filtered = filter
    ? entries.filter((e) => e.category.toLowerCase().includes(filter))
    : entries;
  if (filtered.length === 0) {
    const cats = [...new Set(entries.map((e) => e.category))].filter(Boolean);
    return `No catalog entries under "${opts.category}". Categories: ${cats.join(", ")}.`;
  }
  let current = "";
  const lines: string[] = [];
  for (const e of filtered) {
    if (e.category !== current) {
      current = e.category;
      lines.push(`\n## ${current}`);
    }
    lines.push(`- [[${e.slug}]] — ${e.hook}`);
  }
  return `Wiki catalog (${filtered.length} pages; read any with wiki_read):${lines.join("\n")}`;
}
