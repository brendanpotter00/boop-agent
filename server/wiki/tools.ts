import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { wikiIndex, wikiRead, wikiSearch } from "./search.js";
import { wikiAppend, wikiEdit, wikiWrite } from "./write.js";

/**
 * MCP tools for the user's personal Obsidian vault. Namespace "wiki" (so the
 * execution agent's `mcp__wiki__*` wildcard picks these up when registered as
 * an integration).
 *
 * These were read-only by design — durable facts went to `write_memory` and
 * were promoted by hand later. That round trip is now the bottleneck: the user
 * dictates notes over iMessage and expects them to land, so the vault is
 * writable via `wiki_write` / `wiki_append` / `wiki_edit`.
 *
 * Layering still applies (vault CLAUDE.md §2): `raw/` holds the user's own
 * sources and the agent only ever *adds* new capture files there; `wiki/` is
 * the agent's synthesis layer; the vault's `CLAUDE.md` schema is off-limits and
 * enforced in `safeResolveForWrite`.
 *
 * There is no undo — the vault is not version-controlled — so prefer
 * `wiki_append` over `wiki_edit`, and `wiki_edit` over an overwriting
 * `wiki_write`.
 */

const NAMESPACE = "wiki";

export function createWikiTools(): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "wiki_search",
      "Search the user's personal Obsidian knowledge vault and get back ONE ranked list of the most relevant pages. Use this for curated, long-form personal knowledge: interview prep, people, companies, current work, projects, and personal notes. Then open the top hits with wiki_read. This is local, read-only knowledge — use it directly without spawning a sub-agent (like recall).",
      {
        query: z
          .string()
          .describe("What to look for — a topic, person, question, or keywords."),
        section: z
          .enum(["wiki", "raw"])
          .optional()
          .describe(
            "Optional: limit to curated pages ('wiki') or raw sources/transcripts ('raw'). Default searches both, ranking curated pages higher.",
          ),
        limit: z
          .number()
          .optional()
          .describe("Max pages to return (default 8, max 25)."),
      },
      async (args) => runtimeText(await wikiSearch(args)),
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_read",
      "Read one wiki page's full markdown. Accepts a vault-relative path (e.g. 'wiki/people/jared.md') or a [[slug]] from search/index results. Read-only; long pages are truncated.",
      {
        path: z
          .string()
          .describe(
            "Vault-relative path ('wiki/....md') or a [[slug]] surfaced by wiki_search / wiki_index.",
          ),
      },
      async (args) => runtimeText(await wikiRead(args)),
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_index",
      "Browse the curated catalog of wiki pages — one short hook per page, grouped by category. A good first call to see what personal knowledge exists. Optionally filter by category.",
      {
        category: z
          .string()
          .optional()
          .describe(
            "Optional category filter, e.g. 'people', 'stories', 'cisco', 'companies'.",
          ),
      },
      async (args) => runtimeText(await wikiIndex(args)),
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_append",
      "Append a section to the end of an existing wiki page. PREFER THIS over wiki_edit — it cannot destroy existing content, and the vault has no version control or undo. Use for adding new notes, sections, or dated entries to a page.",
      {
        path: z
          .string()
          .describe("Vault-relative path, e.g. 'wiki/career/cisco/semantic-router.md'."),
        content: z
          .string()
          .describe("Markdown to append. Start with a '## Heading' to match page conventions."),
      },
      async (args) => runtimeText(await wikiAppend(args)),
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_write",
      "Create a NEW wiki or raw page. Use this to capture the user's dictated notes as a new source under 'raw/...' (which the ingest workflow then synthesises into wiki pages). Refuses to clobber an existing page unless overwrite is explicitly true — there is no undo.",
      {
        path: z
          .string()
          .describe(
            "Vault-relative path ending in .md, e.g. 'raw/career/cisco/worklog/Log — 2026-07-26.md'. Parent folders are created as needed.",
          ),
        content: z.string().describe("Full markdown body of the page, including YAML frontmatter if the destination convention calls for it."),
        overwrite: z
          .boolean()
          .optional()
          .describe("Set true ONLY to intentionally replace an existing page wholesale."),
      },
      async (args) => runtimeText(await wikiWrite(args)),
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_edit",
      "Replace an exact snippet inside an existing wiki page — use when new content must land in the MIDDLE of a page (e.g. inserting a section before '## Related PRs'). oldText must match exactly once, or the edit is refused as ambiguous. Read the page with wiki_read first.",
      {
        path: z.string().describe("Vault-relative path to the page."),
        oldText: z
          .string()
          .describe(
            "Exact existing text to replace, including indentation. Must appear exactly once — add surrounding context if it doesn't.",
          ),
        newText: z.string().describe("Replacement text."),
      },
      async (args) => runtimeText(await wikiEdit(args)),
    ),
  ];
}

export function createWikiMcp() {
  return createClaudeMcpServer(NAMESPACE, createWikiTools());
}
