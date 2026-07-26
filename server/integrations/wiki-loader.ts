import { createWikiMcp, createWikiTools } from "../wiki/tools.js";
import { registerIntegration } from "./registry.js";

/**
 * Registers the "wiki" integration. Enabled whenever WIKI_VAULT_PATH points at
 * an Obsidian vault. Registering it here means spawned execution agents
 * automatically receive `mcp__wiki__*` via the integration wildcard; the
 * dispatcher wires the read-only subset in directly (see interaction-agent.ts).
 */
export function registerWikiIntegration(): void {
  registerIntegration({
    name: "wiki",
    description:
      "Read and write the user's personal Obsidian knowledge vault: a unified search over curated pages plus opted-in raw sources, full-page reads, a browsable catalog, and append/edit/create for capturing dictated notes. Prefer appending; the vault has no undo.",
    isEnabled: async () => !!process.env.WIKI_VAULT_PATH,
    createServer: async () => createWikiMcp(),
    createTools: async () => createWikiTools(),
  });
  console.log("[wiki] registered wiki vault integration");
}
