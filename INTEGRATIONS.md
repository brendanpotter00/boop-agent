# Integrations

Boop's integrations are provided by [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab), a tool-aggregator that exposes 1000+ third-party services (Gmail, GitHub, Slack, Notion, Linear, Google Drive, HubSpot, Salesforce, …) behind one API.

Some integrations are built in rather than provided by Composio, because they talk to a local machine or benefit from hand-tuned tools:

- **Local browser use** registers as `browser` only when enabled in the debug dashboard, and gives spawned agents a local Patchright Chrome profile for login-required services, visual workflows, JS-heavy pages, or sites that may detect ordinary automation.
- **ClickUp** registers as `clickup` when `CLICKUP_API_KEY` is set, and talks to ClickUp's REST API directly to avoid the per-day tool-call cap on ClickUp's hosted MCP. See [ClickUp](#clickup).
- **Local Mac data** (`apple`) and the **personal wiki** (`wiki`) are documented in the main README.

For everything else you don't write integration code. You:

1. Put `COMPOSIO_API_KEY` in `.env.local`.
2. Open the debug dashboard → **Connections** tab.
3. Click **Connect** on a toolkit.
4. Authenticate on Composio's hosted page. Composio stores the tokens and keeps them fresh.
5. The toolkit becomes available to `spawn_agent(integrations: [...])` by its slug.

That's it.

---

## How it hooks into Boop

Each connected Composio toolkit is registered in Boop's integration registry (`server/integrations/registry.ts`) keyed by its slug. When the dispatcher calls:

```ts
spawn_agent({ task: "…", integrations: ["gmail"] })
```

`buildMcpServersForIntegrations(["gmail"])` looks up the registered `gmail` module, opens a Composio session **scoped to only the Gmail toolkit**:

```ts
const session = await composio.create(boopUserId(), {
  toolkits: ["gmail"],
  manageConnections: false,
});
const tools = await session.tools();
```

and wraps those tools as an MCP server for the sub-agent. The sub-agent sees only Gmail's tools (`mcp__gmail__GMAIL_SEND_EMAIL`, etc.) — no Slack, no GitHub, no 1000-tool context bloat.

Every tool call is logged to Convex as usual, so the Agents tab in the debug dashboard shows them with the right toolkit logo and a humanized name.

---

## Local browser use

Local browser use is registered by `server/integrations/browser-loader.ts`, not by Composio. Its enabled state comes from `browser_enabled` in the Convex `settings` table, with `BOOP_BROWSER_ENABLED=false` as the default fallback.

When disabled:
- `browser` is not included in `listEnabledIntegrations()`.
- The dispatcher tells users to enable **Settings → Local browser use** if they explicitly request a local browser.
- Execution agents cannot call browser tools.

When enabled:
- The dispatcher can spawn `integrations: ["browser"]`.
- Claude receives an MCP server named `browser`.
- Codex receives dynamic tools under the internal `local_browser` namespace to avoid Codex's reserved browser namespace.
- Patchright launches a persistent Chrome profile from `BOOP_BROWSER_PROFILE_DIR` or the saved `browser_profile_dir` setting.

Settings live under **Settings → Local browser use**:
- **Local browser use** — master enable switch.
- **Show browser UI** — headed Chrome window on the user's machine when on; hidden/headless when off.
- **Spawn login instance** — allows `browser_request_login` to open a visible handoff window and return: "I need you to log in first. I’ve spawned an instance on your machine."
- **Advanced settings** — launch URL, profile directory, channel, executable path, extra Chrome flags, and Patchright Chrome install.

Boop does not store third-party passwords or OAuth tokens for this feature. Login state lives in the selected local Chrome profile.

Browser control HTTP routes are local-only and reject public tunnel requests before launching, closing, installing, or inspecting Chrome. The `browser_fill` tool also redacts typed values before tool-use arguments are persisted to Convex logs.

---

## ClickUp

ClickUp is a second built-in non-Composio integration, registered by `server/integrations/clickup-loader.ts`. It gives spawned agents ticketing: search, read, create, and update tasks; comment; book and report time; and read/write ClickUp Docs.

### Why it isn't the hosted ClickUp MCP

ClickUp ships its own hosted MCP server, but that product meters **tool calls per day** (100/day), which an always-on agent burns through quickly. Boop instead talks to the ClickUp **REST API** with a personal API token. That path is governed by a different, far more generous budget: **~100 requests per minute, per token**, reported on every response via `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset`.

Because the budget is per-minute and per-token, the tools are written to be request-frugal:

- Filtering runs server-side wherever ClickUp supports it (`list_ids[]`, `space_ids[]`, `statuses[]`, `assignees[]`).
- The workspace tree (spaces → folders → lists) is cached for ten minutes, and list metadata for five; concurrent callers share one in-flight request.
- Text search scans a **bounded** window of recently-updated tasks rather than paging the whole workspace. ClickUp's v2 API has no server-side full-text search, so narrowing with `list_ids` matters — pass it when you know the list.

For reference, a full exercise of nine tools (browse → create → comment → update → log time → read → search → time report) costs about 14 requests.

If Boop and another client (e.g. a local ClickUp MCP in your editor) share one token, they share one 100/min bucket. Issue separate tokens to give them independent budgets.

### Setup

Add to `.env.local`:

```bash
CLICKUP_API_KEY=pk_...          # ClickUp → Settings → Apps → API Token
CLICKUP_TEAM_ID=9012345678     # optional; auto-resolved for single-workspace tokens
CLICKUP_DEFAULT_LIST_ID=...     # optional but recommended
```

`CLICKUP_API_KEY` alone enables the integration. `CLICKUP_DEFAULT_LIST_ID` is what makes `clickup_create_task` a single API call — without it the agent must call `clickup_list_spaces` first to discover where to file.

### Tools

| Tool | Purpose |
| --- | --- |
| `clickup_list_spaces` | Browse spaces → folders → lists with ids (cached) |
| `clickup_get_list` | List description and the status names valid for it |
| `clickup_search_tasks` | Search/filter tasks |
| `clickup_get_task` | One task in full, optionally with comments |
| `clickup_create_task` | File a ticket |
| `clickup_update_task` | Status, priority, assignees, dates, estimate, append description |
| `clickup_add_comment` | Comment on a task |
| `clickup_log_time` | Book time (decimal hours) |
| `clickup_get_time_entries` | Report logged time |
| `clickup_list_docs` | List ClickUp Docs |
| `clickup_read_doc` | Read doc pages as markdown |
| `clickup_create_doc` | Create a doc, or add a page to one |
| `clickup_update_doc_page` | Update a page (appends by default) |

Two write-safety choices worth knowing: task description edits are **append-only** (use `clickup_add_comment` for progress notes), and doc page updates **append** unless you pass `append: false`.

Reachable via `spawn_agent({ integrations: ["clickup"] })`, which gives the sub-agent `mcp__clickup__*`. Unlike `wiki`, ClickUp is not wired directly into the dispatcher — 13 tools would weigh down every dispatcher prompt. Move `createClickUpTools()` into `interaction-agent.ts` alongside the wiki tools if you'd rather file tickets in a single round-trip.

---

## Curated toolkit list

The Connections tab shows a hand-picked set in `server/composio.ts:CURATED_TOOLKITS`. Edit that array to add or remove cards — the slugs must match Composio's toolkit slugs (see `docs.composio.dev/toolkits` for the full catalog).

Current defaults: Gmail, Google Calendar, Google Drive, Google Sheets, Google Docs, Slack, GitHub, Linear, Notion, HubSpot, Salesforce, Discord, Twitter, LinkedIn, Instagram, YouTube, Trello, Asana, Jira, Airtable, Figma, Dropbox.

---

## Disconnecting

Click **Disconnect** on a connected card. That revokes the Composio connection and re-loads the integration registry — the toolkit drops out of `availableIntegrations()` immediately. Next time the dispatcher tries to spawn with that slug, it'll log `[integrations] unknown integration: …`.

---

## Toolkits that need a one-time auth config

Composio hosts managed OAuth apps for most popular toolkits (Gmail, Slack, GitHub, Linear, Notion, Google Calendar/Drive/Sheets/Docs, etc.) — click Connect and it just works. A handful of toolkits don't have a managed app on Composio's side (Twitter/X is the common one; Salesforce sometimes) because their developer policies make hosting a shared OAuth app impractical.

When you click Connect on one of those, Boop surfaces an amber banner explaining that you need to:

1. Create an OAuth app on the toolkit's developer portal (e.g., `developer.twitter.com` for Twitter).
2. Open [platform.composio.dev/auth-configs](https://platform.composio.dev/auth-configs), pick the toolkit, and register your app's client ID + secret.
3. Come back to the Connections tab and click Connect again.

This is a one-time setup per toolkit (not per user) — all users of your Boop instance reuse the same auth config after that.

## Notes

- **Single-tenant by default.** All connections are keyed under `COMPOSIO_USER_ID` (defaults to `boop-default`). Override if you manage Composio sessions elsewhere and want Boop to share that user.
- **External actions still use the draft flow.** Execution agents are prompted to call `save_draft` first for anything that writes to the outside world. The dispatcher's `send_draft` is the only path that actually commits.
- **No tokens live in Boop.** Composio stores OAuth credentials on their side. Boop never sees them.
- **Tool names are Composio's canonical slugs** (e.g., `GMAIL_LIST_MESSAGES`). The debug dashboard humanizes them for display.
