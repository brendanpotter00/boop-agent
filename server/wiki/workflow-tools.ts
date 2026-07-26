import { z } from "zod";
import { spawnExecutionAgent } from "../execution-agent.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { vaultRoot, wikiConfigured } from "./paths.js";

/**
 * Dispatcher-side tools for operating on the vault as a whole: planning a
 * change for the user to approve, and running the vault's own maintenance
 * workflows.
 *
 * These live on the dispatcher rather than in the `wiki` integration MCP on
 * purpose — they *spawn* execution agents, and an execution agent that can
 * spawn more execution agents recurses.
 *
 * The key mechanic is `cwd`: every agent spawned here runs with its working
 * directory set to the vault, so `settingSources: ["project"]` loads the
 * vault's own CLAUDE.md. That file already defines `reindex-raw`, `ingest`,
 * `lint` and the ticket-stub pass in detail, so these tools deliberately pass
 * the bare op name as the task rather than re-specifying the workflow here —
 * the vault stays the single source of truth for its own semantics.
 */

const NAMESPACE = "boop-wiki-ops";

/** Tools that mutate the vault. The planner is denied these outright. */
const WRITE_TOOLS = [
  "mcp__wiki__wiki_write",
  "mcp__wiki__wiki_edit",
  "mcp__wiki__wiki_append",
  "Write",
  "Edit",
  "NotebookEdit",
];

/**
 * Thinking budget for the planner. The user asked for maximum effort on the
 * planning step specifically: the vault has no version control, so a wrong plan
 * is unrecoverable, while the executor that carries out an already-approved
 * plan is mechanical and can stay cheap.
 */
const PLANNER_THINKING_TOKENS = Number(process.env.WIKI_PLANNER_THINKING_TOKENS ?? 32_000);

/**
 * Plan with Opus regardless of what the session is set to. If the user has
 * switched the session to a cheaper model for everyday chat, planning an
 * irreversible edit to their knowledge base should not silently follow.
 */
function plannerModel(runtimeConfig?: RuntimeConfig): string {
  const configured = process.env.WIKI_PLANNER_MODEL;
  if (configured) return configured;
  const current = runtimeConfig?.model;
  if (current?.startsWith("claude-opus")) return current;
  return "claude-opus-4-7";
}

function plannerConfig(runtimeConfig?: RuntimeConfig): RuntimeConfig | undefined {
  if (!runtimeConfig) return undefined;
  // The planner is a Claude-only path: it depends on `cwd` + settingSources to
  // pick up the vault manual. Leave a Codex session alone rather than silently
  // switching runtimes underneath the user.
  if (runtimeConfig.runtime !== "claude") return runtimeConfig;
  return { ...runtimeConfig, model: plannerModel(runtimeConfig) };
}

const PLANNER_BRIEF = `You are PLANNING a change to the user's Obsidian vault. You are in the vault directory; its CLAUDE.md is your operating manual — follow its layering (§2), naming and frontmatter conventions (§4), and routing table (§8).

You MUST NOT write anything. The write tools are disabled for you. Your only output is a plan.

Steps:
1. Use wiki_search / wiki_read / wiki_index to find the pages this actually touches. Do not guess paths.
2. Decide the concrete file operations, following the routing table. A dictated narrative from the user is a NEW raw source; synthesis belongs on the matching wiki page.
3. Call save_draft with kind "wiki.plan", a one-line summary, and a payload JSON of the form:
   {"request": "<the original ask>", "operations": [{"op": "append|edit|create", "path": "<vault-relative>", "why": "<one line>", "content": "<the exact markdown to write>"}], "workflows": ["reindex-raw", "ingest <path>", "lint"]}
   Put the FULL final markdown in each operation's "content" — the executor writes what you wrote, it does not re-draft it.
4. Reply with a SHORT numbered plan for the user to read on their phone. Lead with which pages change. No preamble.

Prefer append over edit, and edit over overwrite. The vault has no version control and no undo.`;

const EXECUTOR_BRIEF = `You are EXECUTING an already-approved plan against the user's Obsidian vault. You are in the vault directory; its CLAUDE.md is your operating manual.

Carry out the operations exactly as planned — do not re-draft the content, re-scope the change, or add operations. Use wiki_append / wiki_edit / wiki_write.

Then run the vault's own workflows as listed in the plan (they are defined in CLAUDE.md §6): reindex-raw first, then ingest for any new/changed raw source, then lint. Append a log entry to wiki/log.md per §5, using op type "manual-edit" for direct page edits.

Report back tersely: which files changed, and the lint result.`;

export function createWikiOpsTools(
  conversationId: string | undefined,
  runtimeConfig?: RuntimeConfig,
): RuntimeTool[] {
  if (!wikiConfigured()) return [];
  let root: string;
  try {
    root = vaultRoot();
  } catch {
    return [];
  }

  const runVaultOp = async (op: string, name: string): Promise<string> => {
    const res = await spawnExecutionAgent({
      task: `${op}\n\nYou are in the user's Obsidian vault. Follow the workflow of that exact name as defined in this vault's CLAUDE.md §6. Make no other changes. Report a one-line result.`,
      integrations: ["wiki"],
      conversationId,
      name,
      runtimeConfig,
      cwd: root,
    });
    return `[${res.status}] ${res.result}`;
  };

  return [
    defineRuntimeTool(
      NAMESPACE,
      "plan_wiki_edit",
      "Plan a change to the user's Obsidian wiki and stage it for their approval. USE THIS for any request to add, record, update or write something into the wiki — never spawn a plain agent for that. Runs a high-effort Opus planner that cannot write, then stages the plan as a draft; the user replies 'go' and send_draft executes it. Returns the plan to relay to the user.",
      {
        request: z
          .string()
          .describe(
            "What the user wants captured or changed, in full. Include their dictated content verbatim — the planner turns it into the actual page content.",
          ),
      },
      async (args) => {
        const res = await spawnExecutionAgent({
          task: `${PLANNER_BRIEF}\n\n--- USER REQUEST ---\n${args.request}`,
          integrations: ["wiki"],
          conversationId,
          name: "wiki-planner",
          runtimeConfig: plannerConfig(runtimeConfig),
          cwd: root,
          maxThinkingTokens: PLANNER_THINKING_TOKENS,
          disallowedTools: WRITE_TOOLS,
        });
        return runtimeText(
          `[planner ${res.status}]\n\n${res.result}\n\nRelay this plan to the user and ask them to reply "go" to run it (send_draft) or "no" to drop it (reject_draft).`,
        );
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_reindex",
      "Run the vault's `reindex-raw` workflow — refreshes raw/_tree.md and raw/index.md so the catalog matches what's actually on disk. Preflight to any ingest.",
      {},
      async () => runtimeText(await runVaultOp("reindex-raw", "wiki-reindex")),
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_ingest",
      "Run the vault's `ingest` workflow over a path or glob — synthesises raw sources into curated wiki pages, cross-links them, and logs what changed. Runs reindex-raw first automatically.",
      {
        path: z
          .string()
          .optional()
          .describe(
            "Vault-relative path or glob, e.g. 'raw/career/cisco/**/*.md'. Omit to ingest everything new since the last run.",
          ),
      },
      async (args) =>
        runtimeText(
          await runVaultOp(args.path ? `ingest ${args.path}` : "ingest", "wiki-ingest"),
        ),
    ),

    defineRuntimeTool(
      NAMESPACE,
      "wiki_lint",
      "Run the vault's `lint` workflow — checks for broken wikilinks, orphan pages, frontmatter drift and convention violations, and reports findings.",
      {},
      async () => runtimeText(await runVaultOp("lint", "wiki-lint")),
    ),
  ];
}

export function createWikiOpsMcp(conversationId: string | undefined, runtimeConfig?: RuntimeConfig) {
  return createClaudeMcpServer(NAMESPACE, createWikiOpsTools(conversationId, runtimeConfig));
}

/** Vault root + executor brief, for the draft-execution path in draft-tools. */
export function wikiExecutorContext(): { cwd: string; brief: string } | null {
  if (!wikiConfigured()) return null;
  try {
    return { cwd: vaultRoot(), brief: EXECUTOR_BRIEF };
  } catch {
    return null;
  }
}
