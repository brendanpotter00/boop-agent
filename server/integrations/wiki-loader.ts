import { createWikiMcp, createWikiTools } from "../wiki/tools.js";
import { registerIntegration } from "./registry.js";

/**
 * Registers the read-only "wiki" integration. Enabled whenever WIKI_VAULT_PATH
 * points at an Obsidian vault. Registering it here means spawned execution
 * agents automatically receive `mcp__wiki__*` via the integration wildcard;
 * the dispatcher wires the same tools in directly (see interaction-agent.ts).
 */
export function registerWikiIntegration(): void {
  registerIntegration({
    name: "wiki",
    description:
      "Read-only access to the user's personal Obsidian knowledge vault: a single unified search over curated pages plus opted-in raw sources, full-page reads, and a browsable catalog. The vault is the source of truth; boop never writes to it.",
    isEnabled: async () => !!process.env.WIKI_VAULT_PATH,
    createServer: async () => createWikiMcp(),
    createTools: async () => createWikiTools(),
  });
  console.log("[wiki] registered wiki vault integration");
}
