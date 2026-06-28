import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { wikiIndex, wikiRead, wikiSearch } from "./search.js";

/**
 * MCP tools for read-only access to the user's personal Obsidian vault.
 * Namespace "wiki" (so the execution agent's `mcp__wiki__*` wildcard picks it
 * up when registered as an integration). There is deliberately NO write tool —
 * the vault is the source of truth and boop never mutates it. New durable facts
 * are captured via `write_memory`, then promoted manually via the vault's
 * ingest workflow.
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
  ];
}

export function createWikiMcp() {
  return createClaudeMcpServer(NAMESPACE, createWikiTools());
}
