import { isClickUpConfigured } from "../clickup/client.js";
import { createClickUpMcp, createClickUpTools } from "../clickup/tools.js";
import { registerIntegration } from "./registry.js";

/**
 * Registers the "clickup" integration. Enabled whenever CLICKUP_API_KEY is set.
 *
 * Boop uses a personal ClickUp API token against the REST API rather than
 * ClickUp's hosted MCP, which meters tool calls per day. The REST API budget is
 * per-token requests-per-minute instead, so the tools favour server-side
 * filtering and cache workspace structure.
 */
export function registerClickUpIntegration(): void {
  registerIntegration({
    name: "clickup",
    description:
      "ClickUp ticketing: search, read, create, and update tasks; comment on them; book and report time; and read/write ClickUp Docs. Use this for anything the user calls a ticket, card, or issue.",
    requiredEnv: ["CLICKUP_API_KEY"],
    isEnabled: async () => isClickUpConfigured(),
    createServer: async () => createClickUpMcp(),
    createTools: async () => createClickUpTools(),
  });
  console.log("[clickup] registered ClickUp ticketing integration");
}
