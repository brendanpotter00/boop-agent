---
name: wiki
description: Search, answer from, and synthesize the user's personal Obsidian knowledge vault — interview prep, people, companies, current work, projects, and personal notes. Use when a request touches the user's own documented knowledge, or asks to summarize/compare/draft across multiple of their pages.
---

# Wiki — the user's personal knowledge vault

The user maintains a curated Obsidian vault. It is the **source of truth** for
their documented knowledge. You have three read-only MCP tools:

- `wiki_search(query, section?, limit?)` — ONE ranked list of the most relevant
  pages. Fuses semantic + curated-catalog + keyword signals and dedupes by page,
  so you never get duplicate or competing result sets.
- `wiki_read(path)` — full markdown of one page. Accepts a vault-relative path
  (e.g. `wiki/people/<name>.md`) or a `[[slug]]` from search/index results.
- `wiki_index(category?)` — browse the curated catalog (one hook per page),
  optionally filtered by category (e.g. `people`, `stories`, `companies`).

## Vault map
- `wiki/` — **curated** pages (trust these first); rich `[[backlinks]]`, organized
  by category. Start here.
- Opted-in `raw/` subtrees — **raw** sources, which may include meeting/AI
  transcripts (noisier; speech-to-text errors possible). Useful for primary-source
  detail; prefer the synthesized `wiki/` page when one exists.

## How to use it
1. If you don't know what exists, call `wiki_index` (optionally by category).
2. Otherwise call `wiki_search` with the topic/person/question. Use `section:"wiki"`
   to force curated-only, or `section:"raw"` for raw sources.
3. `wiki_read` the top hit(s). Follow `[[wikilinks]]` by reading those pages too.
4. Answer with citations as `[[slug]]`. Prefer curated `wiki/` content over raw.

## Read-only + capture-to-inbox (important)
- **Never write to the vault.** There is no wiki write tool by design. Promotion of
  new knowledge into curated pages is a manual step the user runs via the vault's
  own ingest workflow.
- When you learn a **new durable fact** during a wiki conversation, persist it with
  `write_memory` (the inbox) so it can be promoted into the wiki later. Do not try
  to edit vault files.

## Good tasks for this skill
- "What's my latest interview status for <company>?" → search → read the grade/aggregator page.
- "Summarize all my interview prep into themes." → index/search broadly → read several → synthesize.
- "Who is <person> and what do I know about them?" → search people → read.
- "What's my current work strategy?" → search → read the strategy page.
