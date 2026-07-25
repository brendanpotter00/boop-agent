import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import {
  cached,
  clickupRequest,
  fromEpochMs,
  getCurrentUser,
  getTeamId,
  hoursToMs,
  listUrl,
  msToHours,
  priorityToName,
  priorityToNumber,
  taskUrl,
  toEpochMs,
} from "./client.js";

/**
 * ClickUp ticketing tools. Namespace "clickup" so execution agents spawned with
 * `integrations: ["clickup"]` receive them as `mcp__clickup__*`.
 *
 * These talk to the ClickUp REST API with a personal token, which is metered by
 * requests-per-minute rather than the per-day tool-call cap on ClickUp's hosted
 * MCP. Each tool is written to be request-frugal: filtering happens server-side
 * where ClickUp supports it, and workspace structure is cached.
 */

const NAMESPACE = "clickup";

const TREE_TTL_MS = 10 * 60 * 1000;
const LIST_TTL_MS = 5 * 60 * 1000;

/** ClickUp caps the filtered-task endpoint at 100 tasks per page. */
const PAGE_SIZE = 100;
const DEFAULT_SEARCH_PAGES = 2;
const MAX_SEARCH_PAGES = 5;

function ok(text: string) {
  return runtimeText(text);
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return runtimeText(`[clickup error] ${message}`, false);
}

async function wrap(fn: () => Promise<string>) {
  try {
    return ok(await fn());
  } catch (err) {
    return toolError(err);
  }
}

function defaultListId(): string | undefined {
  return process.env.CLICKUP_DEFAULT_LIST_ID?.trim() || undefined;
}

function resolveListId(explicit?: string): string {
  const listId = explicit?.trim() || defaultListId();
  if (!listId) {
    throw new Error(
      "No list_id given and CLICKUP_DEFAULT_LIST_ID isn't set. Call clickup_list_spaces to find a list id, or set a default in .env.local.",
    );
  }
  return listId;
}

// ---------------------------------------------------------------------------
// ClickUp response shapes (only the fields these tools read)
// ---------------------------------------------------------------------------

interface ClickUpStatus {
  status: string;
  type?: string;
}

interface ClickUpList {
  id: string;
  name: string;
  task_count?: number | string | null;
  statuses?: ClickUpStatus[];
  content?: string;
  space?: { id: string; name: string };
  folder?: { id: string; name: string };
}

interface ClickUpFolder {
  id: string;
  name: string;
  lists?: ClickUpList[];
}

interface ClickUpSpace {
  id: string;
  name: string;
}

interface ClickUpTask {
  id: string;
  name: string;
  status?: { status?: string };
  priority?: unknown;
  assignees?: Array<{ id: number; username?: string }>;
  due_date?: string | number | null;
  start_date?: string | number | null;
  date_updated?: string | number | null;
  time_estimate?: string | number | null;
  tags?: Array<{ name: string }>;
  list?: { id: string; name: string };
  folder?: { id: string; name: string };
  space?: { id: string; name: string };
  url?: string;
  description?: string | null;
  markdown_description?: string | null;
  text_content?: string | null;
  parent?: string | null;
}

interface ClickUpComment {
  id: string;
  comment_text?: string;
  user?: { username?: string };
  date?: string | number;
}

interface ClickUpTimeEntry {
  id: string;
  duration?: string | number;
  start?: string | number;
  description?: string;
  task?: { id: string; name?: string };
  user?: { username?: string };
}

interface ClickUpDoc {
  id: string;
  name?: string;
  parent?: { id?: string; type?: number };
  date_updated?: string | number;
}

interface ClickUpDocPage {
  id: string;
  name?: string;
  content?: string;
  parent_page_id?: string | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTaskLine(task: ClickUpTask): string {
  const bits = [`[${task.id}] ${task.name}`];
  if (task.status?.status) bits.push(`status: ${task.status.status}`);
  const priority = priorityToName(task.priority);
  if (priority) bits.push(`priority: ${priority}`);
  const assignees = (task.assignees ?? []).map((a) => a.username).filter(Boolean);
  if (assignees.length) bits.push(`assignees: ${assignees.join(", ")}`);
  const due = fromEpochMs(task.due_date);
  if (due) bits.push(`due: ${due}`);
  if (task.list?.name) bits.push(`list: ${task.list.name}`);
  bits.push(taskUrl(task.id));
  return bits.join(" — ");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} more characters)`;
}

function docUrl(teamId: string, docId: string, pageId?: string): string {
  const base = `https://app.clickup.com/${teamId}/v/dc/${docId}`;
  return pageId ? `${base}/${pageId}` : base;
}

// ---------------------------------------------------------------------------
// Workspace tree
// ---------------------------------------------------------------------------

interface TreeList {
  id: string;
  name: string;
  taskCount: number | null;
}

interface TreeFolder {
  id: string;
  name: string;
  lists: TreeList[];
}

interface TreeSpace {
  id: string;
  name: string;
  folders: TreeFolder[];
  lists: TreeList[];
}

function toTreeList(list: ClickUpList): TreeList {
  const count = Number(list.task_count);
  return { id: list.id, name: list.name, taskCount: Number.isFinite(count) ? count : null };
}

/**
 * Fetches spaces → folders → lists. This is the most request-hungry call in the
 * integration (1 + 2 per space), so it is cached for ten minutes; workspace
 * structure changes far more slowly than tasks do.
 */
async function loadWorkspaceTree(): Promise<TreeSpace[]> {
  const teamId = await getTeamId();
  return cached(`tree:${teamId}`, TREE_TTL_MS, async () => {
    const spacesResponse = await clickupRequest<{ spaces?: ClickUpSpace[] }>(
      `/team/${teamId}/space`,
      { query: { archived: false } },
    );
    const spaces = spacesResponse.spaces ?? [];

    return Promise.all(
      spaces.map(async (space): Promise<TreeSpace> => {
        const [folderResponse, listResponse] = await Promise.all([
          clickupRequest<{ folders?: ClickUpFolder[] }>(`/space/${space.id}/folder`, {
            query: { archived: false },
          }),
          // Lists that live directly in the space rather than inside a folder.
          clickupRequest<{ lists?: ClickUpList[] }>(`/space/${space.id}/list`, {
            query: { archived: false },
          }),
        ]);

        return {
          id: space.id,
          name: space.name,
          folders: (folderResponse.folders ?? []).map((folder) => ({
            id: folder.id,
            name: folder.name,
            // The folder payload already embeds its lists — no extra request.
            lists: (folder.lists ?? []).map(toTreeList),
          })),
          lists: (listResponse.lists ?? []).map(toTreeList),
        };
      }),
    );
  });
}

function renderTree(tree: TreeSpace[]): string {
  if (!tree.length) return "No spaces found in this ClickUp workspace.";
  const lines: string[] = [];
  for (const space of tree) {
    lines.push(`Space "${space.name}" (space_id: ${space.id})`);
    for (const list of space.lists) {
      lines.push(`  • list "${list.name}" (list_id: ${list.id}${countSuffix(list)}) ${listUrl(list.id)}`);
    }
    for (const folder of space.folders) {
      lines.push(`  Folder "${folder.name}" (folder_id: ${folder.id})`);
      if (!folder.lists.length) lines.push("    (no lists)");
      for (const list of folder.lists) {
        lines.push(
          `    • list "${list.name}" (list_id: ${list.id}${countSuffix(list)}) ${listUrl(list.id)}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function countSuffix(list: TreeList): string {
  return list.taskCount === null ? "" : `, ${list.taskCount} tasks`;
}

// ---------------------------------------------------------------------------
// Task search
// ---------------------------------------------------------------------------

interface SearchArgs {
  query?: string;
  list_ids?: string[];
  space_ids?: string[];
  statuses?: string[];
  assigned_to_me?: boolean;
  include_closed?: boolean;
  limit?: number;
}

function matchesQuery(task: ClickUpTask, needles: string[]): boolean {
  if (!needles.length) return true;
  const haystack = [
    task.id,
    task.name,
    task.text_content ?? "",
    (task.tags ?? []).map((t) => t.name).join(" "),
    (task.assignees ?? []).map((a) => a.username ?? "").join(" "),
    task.list?.name ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

async function searchTasks(args: SearchArgs): Promise<string> {
  const teamId = await getTeamId();
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
  const needles = (args.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const assignees = args.assigned_to_me ? [String((await getCurrentUser()).id)] : undefined;

  // Without a text query ClickUp's own filters are enough, so one page suffices.
  // With one, we scan a bounded number of recent pages and match locally —
  // ClickUp's v2 API has no server-side full-text search.
  const maxPages = needles.length ? Math.min(DEFAULT_SEARCH_PAGES, MAX_SEARCH_PAGES) : 1;

  const matches: ClickUpTask[] = [];
  let scanned = 0;

  for (let page = 0; page < maxPages; page++) {
    const response = await clickupRequest<{ tasks?: ClickUpTask[]; last_page?: boolean }>(
      `/team/${teamId}/task`,
      {
        query: {
          page,
          order_by: "updated",
          subtasks: true,
          include_closed: args.include_closed ?? false,
          list_ids: args.list_ids,
          space_ids: args.space_ids,
          statuses: args.statuses,
          assignees,
        },
      },
    );
    const tasks = response.tasks ?? [];
    scanned += tasks.length;
    for (const task of tasks) {
      if (matchesQuery(task, needles)) matches.push(task);
    }
    if (matches.length >= limit) break;
    if (response.last_page || tasks.length < PAGE_SIZE) break;
  }

  if (!matches.length) {
    const scope = needles.length ? ` matching "${args.query}"` : "";
    return `No tasks found${scope} (scanned ${scanned} recent tasks).`;
  }

  const shown = matches.slice(0, limit);
  const header = `${shown.length} task${shown.length === 1 ? "" : "s"}${
    needles.length ? ` matching "${args.query}"` : ""
  } (scanned ${scanned} recent tasks):`;
  return [header, ...shown.map((t) => `- ${formatTaskLine(t)}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createClickUpTools(namespace = NAMESPACE): RuntimeTool[] {
  const defaultList = defaultListId();
  const defaultListNote = defaultList
    ? ` Defaults to the configured list ${defaultList} when omitted.`
    : " Required — call clickup_list_spaces first to find one.";

  return [
    // ---- Discovery -------------------------------------------------------
    defineRuntimeTool(
      namespace,
      "clickup_list_spaces",
      "Browse the ClickUp workspace structure: spaces, folders, and the lists inside them, with their ids. Call this to find the list_id to file a ticket into. Cached for ten minutes, so it is cheap to call repeatedly.",
      {},
      async () => wrap(async () => renderTree(await loadWorkspaceTree())),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_get_list",
      "Get one list's details: its description and the exact status names valid for tasks in it. Call this before creating or updating a task if you intend to set a status, since status names vary per list.",
      {
        list_id: z.string().describe("The list id (from clickup_list_spaces)."),
      },
      async ({ list_id }) =>
        wrap(async () => {
          const list = await cached(`list:${list_id}`, LIST_TTL_MS, () =>
            clickupRequest<ClickUpList>(`/list/${list_id}`),
          );
          const statuses = (list.statuses ?? []).map((s) => s.status);
          const lines = [
            `List "${list.name}" (list_id: ${list.id}) ${listUrl(list.id)}`,
            list.space?.name ? `Space: ${list.space.name}` : null,
            list.folder?.name ? `Folder: ${list.folder.name}` : null,
            statuses.length ? `Valid statuses: ${statuses.join(", ")}` : null,
            list.content?.trim() ? `\nDescription:\n${list.content.trim()}` : null,
          ].filter(Boolean) as string[];
          return lines.join("\n");
        }),
    ),

    // ---- Tickets: read ---------------------------------------------------
    defineRuntimeTool(
      namespace,
      "clickup_search_tasks",
      "Search ClickUp tasks (tickets). Filters run server-side; the optional text query is matched locally against a bounded window of recently-updated tasks, so narrow with list_ids or space_ids when you can. Omit query to simply list the most recently updated tasks.",
      {
        query: z
          .string()
          .optional()
          .describe("Optional text to match against task name, body, tags, assignee, or id."),
        list_ids: z.array(z.string()).optional().describe("Restrict to these list ids."),
        space_ids: z.array(z.string()).optional().describe("Restrict to these space ids."),
        statuses: z
          .array(z.string())
          .optional()
          .describe("Restrict to these status names (see clickup_get_list for valid values)."),
        assigned_to_me: z
          .boolean()
          .optional()
          .describe("Only tasks assigned to the token's own user."),
        include_closed: z
          .boolean()
          .optional()
          .describe("Include closed/done tasks. Defaults to false."),
        limit: z.number().optional().describe("Max tasks to return (default 25, max 100)."),
      },
      async (args) => wrap(() => searchTasks(args)),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_get_task",
      "Read one ClickUp task in full: description, status, assignees, dates, estimate, and optionally its comment thread.",
      {
        task_id: z.string().describe("The task id, e.g. '86c1abcde' (no '#' or URL prefix)."),
        include_comments: z
          .boolean()
          .optional()
          .describe("Also fetch the comment thread (costs one extra request). Defaults to true."),
      },
      async ({ task_id, include_comments }) =>
        wrap(async () => {
          const task = await clickupRequest<ClickUpTask>(`/task/${task_id}`, {
            query: { include_markdown_description: true },
          });

          const lines = [
            `[${task.id}] ${task.name}`,
            taskUrl(task.id),
            `Status: ${task.status?.status ?? "unknown"}`,
          ];
          const priority = priorityToName(task.priority);
          if (priority) lines.push(`Priority: ${priority}`);
          const assignees = (task.assignees ?? []).map((a) => a.username).filter(Boolean);
          if (assignees.length) lines.push(`Assignees: ${assignees.join(", ")}`);
          const due = fromEpochMs(task.due_date);
          if (due) lines.push(`Due: ${due}`);
          const start = fromEpochMs(task.start_date);
          if (start) lines.push(`Start: ${start}`);
          const estimate = msToHours(task.time_estimate);
          if (estimate) lines.push(`Estimate: ${estimate}h`);
          const tags = (task.tags ?? []).map((t) => t.name);
          if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
          if (task.list?.name) lines.push(`List: ${task.list.name} (list_id: ${task.list.id})`);
          if (task.parent) lines.push(`Parent task: ${task.parent}`);

          const body = (task.markdown_description ?? task.description ?? "").trim();
          lines.push("", "Description:", body ? truncate(body, 4000) : "(empty)");

          if (include_comments !== false) {
            const commentResponse = await clickupRequest<{ comments?: ClickUpComment[] }>(
              `/task/${task_id}/comment`,
            );
            const comments = commentResponse.comments ?? [];
            lines.push("", `Comments (${comments.length}):`);
            if (!comments.length) lines.push("(none)");
            for (const comment of comments.slice(0, 25)) {
              const who = comment.user?.username ?? "unknown";
              const when = fromEpochMs(comment.date) ?? "unknown date";
              const text = (comment.comment_text ?? "").trim() || "(empty)";
              lines.push(`- ${who} @ ${when}: ${truncate(text, 600)}`);
            }
          }

          return lines.join("\n");
        }),
    ),

    // ---- Tickets: write --------------------------------------------------
    defineRuntimeTool(
      namespace,
      "clickup_create_task",
      `Create a ClickUp task (ticket) and return its clickable URL. Search first with clickup_search_tasks to avoid filing a duplicate. Status names are per-list — check clickup_get_list before passing one.`,
      {
        name: z.string().describe("The task title."),
        list_id: z.string().optional().describe(`The list to create the task in.${defaultListNote}`),
        description: z
          .string()
          .optional()
          .describe("Markdown body: requirements, context, links to related tasks."),
        status: z
          .string()
          .optional()
          .describe("Status name valid for this list. Omit to use the list's default."),
        priority: z
          .enum(["urgent", "high", "normal", "low"])
          .optional()
          .describe("Priority level."),
        assignees: z
          .array(z.string())
          .optional()
          .describe("Numeric ClickUp user ids. Omit to assign the token's own user."),
        due_date: z.string().optional().describe("ISO date string, e.g. '2026-08-01T17:00:00Z'."),
        start_date: z.string().optional().describe("ISO date string."),
        time_estimate: z.number().optional().describe("Estimate in hours, e.g. 2.5."),
        tags: z.array(z.string()).optional().describe("Tag names to apply."),
        parent_task_id: z
          .string()
          .optional()
          .describe("Create as a subtask of this task id."),
      },
      async (args) =>
        wrap(async () => {
          const listId = resolveListId(args.list_id);
          const assignees = args.assignees ?? [String((await getCurrentUser()).id)];

          const body: Record<string, unknown> = {
            name: args.name,
            assignees: assignees.map((id) => Number(id)).filter((id) => Number.isFinite(id)),
          };
          if (args.description !== undefined) body.markdown_description = args.description;
          if (args.status !== undefined) body.status = args.status;
          if (args.priority !== undefined) body.priority = priorityToNumber(args.priority);
          if (args.due_date !== undefined) body.due_date = toEpochMs(args.due_date);
          if (args.start_date !== undefined) body.start_date = toEpochMs(args.start_date);
          if (args.time_estimate !== undefined) body.time_estimate = hoursToMs(args.time_estimate);
          if (args.tags !== undefined) body.tags = args.tags;
          if (args.parent_task_id !== undefined) body.parent = args.parent_task_id;

          const task = await clickupRequest<ClickUpTask>(`/list/${listId}/task`, {
            method: "POST",
            body,
          });

          return [
            `Created task "${task.name}" (task_id: ${task.id})`,
            taskUrl(task.id),
            `List: ${task.list?.name ?? listId}`,
            `Status: ${task.status?.status ?? "default"}`,
          ].join("\n");
        }),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_update_task",
      "Update an existing ClickUp task: status, priority, assignees, dates, estimate, name, or append to its description. Description edits are append-only so existing content is never destroyed — use clickup_add_comment for progress notes.",
      {
        task_id: z.string().describe("The task id to update."),
        name: z.string().optional().describe("New title."),
        append_description: z
          .string()
          .optional()
          .describe("Markdown appended to the existing description (never overwrites)."),
        status: z
          .string()
          .optional()
          .describe("New status name — see clickup_get_list for valid values."),
        priority: z.enum(["urgent", "high", "normal", "low"]).optional().describe("New priority."),
        assignees: z
          .array(z.string())
          .optional()
          .describe("Numeric ClickUp user ids to add as assignees."),
        due_date: z.string().optional().describe("ISO date string."),
        start_date: z.string().optional().describe("ISO date string."),
        time_estimate: z.number().optional().describe("Estimate in hours."),
        parent_task_id: z.string().optional().describe("Re-parent this task under another task."),
      },
      async (args) =>
        wrap(async () => {
          const body: Record<string, unknown> = {};
          if (args.name !== undefined) body.name = args.name;
          if (args.status !== undefined) body.status = args.status;
          if (args.priority !== undefined) body.priority = priorityToNumber(args.priority);
          if (args.due_date !== undefined) body.due_date = toEpochMs(args.due_date);
          if (args.start_date !== undefined) body.start_date = toEpochMs(args.start_date);
          if (args.time_estimate !== undefined) body.time_estimate = hoursToMs(args.time_estimate);
          if (args.parent_task_id !== undefined) body.parent = args.parent_task_id;
          // On update ClickUp expects an add/remove diff rather than a plain array.
          if (args.assignees !== undefined) {
            body.assignees = {
              add: args.assignees.map((id) => Number(id)).filter((id) => Number.isFinite(id)),
              rem: [],
            };
          }

          if (args.append_description !== undefined) {
            const existing = await clickupRequest<ClickUpTask>(`/task/${args.task_id}`, {
              query: { include_markdown_description: true },
            });
            const current = (existing.markdown_description ?? "").trim();
            const stamp = new Date().toISOString().slice(0, 10);
            const separator = current ? "\n\n---\n" : "";
            body.markdown_description = `${current}${separator}**Update (${stamp}):** ${args.append_description}`;
          }

          if (!Object.keys(body).length) {
            return "Nothing to update — pass at least one field.";
          }

          const task = await clickupRequest<ClickUpTask>(`/task/${args.task_id}`, {
            method: "PUT",
            body,
          });

          return [
            `Updated task "${task.name}" (task_id: ${task.id})`,
            taskUrl(task.id),
            `Status: ${task.status?.status ?? "unknown"}`,
            `Fields changed: ${Object.keys(body).join(", ")}`,
          ].join("\n");
        }),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_add_comment",
      "Add a comment to a ClickUp task. Prefer this over editing the description for progress updates, findings, and status notes.",
      {
        task_id: z.string().describe("The task id to comment on."),
        comment: z.string().describe("Comment text. Reference related tasks by their ClickUp URL."),
        notify_all: z
          .boolean()
          .optional()
          .describe("Notify everyone watching the task. Defaults to false."),
      },
      async ({ task_id, comment, notify_all }) =>
        wrap(async () => {
          const created = await clickupRequest<{ id?: string }>(`/task/${task_id}/comment`, {
            method: "POST",
            body: { comment_text: comment, notify_all: notify_all ?? false },
          });
          return [
            `Comment added to task ${task_id}${created.id ? ` (comment_id: ${created.id})` : ""}`,
            taskUrl(task_id),
          ].join("\n");
        }),
    ),

    // ---- Time tracking ---------------------------------------------------
    defineRuntimeTool(
      namespace,
      "clickup_log_time",
      "Book time against a ClickUp task for the token's own user. Use decimal hours (0.25 = 15 minutes).",
      {
        task_id: z.string().describe("The task id to book time against."),
        hours: z.number().describe("Hours to book as a decimal, e.g. 1.5 for 1h30m."),
        description: z.string().optional().describe("What the time was spent on."),
        start_time: z
          .string()
          .optional()
          .describe("ISO start time. Defaults to now minus the booked duration."),
      },
      async ({ task_id, hours, description, start_time }) =>
        wrap(async () => {
          if (!(hours > 0)) throw new Error("hours must be greater than zero.");
          const teamId = await getTeamId();
          const durationMs = hoursToMs(hours);
          // Default the entry to end "now" so booked time reads as work just done.
          const start = start_time ? toEpochMs(start_time) : Date.now() - durationMs;

          const entry = await clickupRequest<{ data?: ClickUpTimeEntry }>(
            `/team/${teamId}/time_entries`,
            {
              method: "POST",
              body: {
                tid: task_id,
                start,
                duration: durationMs,
                ...(description ? { description } : {}),
              },
            },
          );

          return [
            `Booked ${hours}h against task ${task_id}${entry.data?.id ? ` (entry_id: ${entry.data.id})` : ""}`,
            `Started: ${new Date(start).toISOString()}`,
            taskUrl(task_id),
          ].join("\n");
        }),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_get_time_entries",
      "Read logged time entries — for one task or across the workspace. Defaults to the last 30 days for the token's own user.",
      {
        task_id: z.string().optional().describe("Only entries for this task."),
        start_date: z.string().optional().describe("ISO date string. Defaults to 30 days ago."),
        end_date: z.string().optional().describe("ISO date string. Defaults to now."),
      },
      async ({ task_id, start_date, end_date }) =>
        wrap(async () => {
          const teamId = await getTeamId();
          const end = end_date ? toEpochMs(end_date) : Date.now();
          const start = start_date ? toEpochMs(start_date) : end - 30 * 24 * 60 * 60 * 1000;

          const response = await clickupRequest<{ data?: ClickUpTimeEntry[] }>(
            `/team/${teamId}/time_entries`,
            { query: { start_date: start, end_date: end, ...(task_id ? { task_id } : {}) } },
          );

          const entries = (response.data ?? []).filter(
            (entry) => !task_id || entry.task?.id === task_id,
          );
          if (!entries.length) return "No time entries in that window.";

          const totalHours = entries.reduce((sum, entry) => sum + (msToHours(entry.duration) ?? 0), 0);
          const lines = entries.slice(0, 100).map((entry) => {
            const hours = msToHours(entry.duration) ?? 0;
            const when = fromEpochMs(entry.start) ?? "unknown";
            const label = entry.task?.name ?? entry.task?.id ?? "(no task)";
            const note = entry.description ? ` — ${entry.description}` : "";
            return `- ${hours}h on "${label}" @ ${when}${note}`;
          });

          return [
            `${entries.length} time entries, ${Math.round(totalHours * 100) / 100}h total:`,
            ...lines,
          ].join("\n");
        }),
    ),

    // ---- Docs ------------------------------------------------------------
    defineRuntimeTool(
      namespace,
      "clickup_list_docs",
      "List ClickUp Docs in the workspace, optionally limited to one space or list.",
      {
        parent_id: z
          .string()
          .optional()
          .describe("Optional space id or list id to list docs under."),
        limit: z.number().optional().describe("Max docs to return (default 25)."),
      },
      async ({ parent_id, limit }) =>
        wrap(async () => {
          const teamId = await getTeamId();
          const response = await clickupRequest<{ docs?: ClickUpDoc[] }>(
            `/workspaces/${teamId}/docs`,
            { version: "v3", query: { parent_id, limit: Math.min(limit ?? 25, 100) } },
          );
          const docs = response.docs ?? [];
          if (!docs.length) return "No docs found.";
          return [
            `${docs.length} doc${docs.length === 1 ? "" : "s"}:`,
            ...docs.map(
              (doc) =>
                `- ${doc.name ?? "(untitled)"} (doc_id: ${doc.id}) ${docUrl(teamId, doc.id)}`,
            ),
          ].join("\n");
        }),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_read_doc",
      "Read a ClickUp Doc's pages as markdown. Returns every page unless you name one.",
      {
        doc_id: z.string().describe("The doc id (from clickup_list_docs)."),
        page: z.string().optional().describe("Optional page id or page name to read on its own."),
      },
      async ({ doc_id, page }) =>
        wrap(async () => {
          const teamId = await getTeamId();
          const pages = await clickupRequest<ClickUpDocPage[]>(
            `/workspaces/${teamId}/docs/${doc_id}/pages`,
            { version: "v3", query: { content_format: "text/md" } },
          );
          const all = Array.isArray(pages) ? pages : [];
          if (!all.length) return "That doc has no pages.";

          const wanted = page
            ? all.filter(
                (p) => p.id === page || (p.name ?? "").toLowerCase() === page.toLowerCase(),
              )
            : all;
          if (!wanted.length) return `No page matching "${page}" in doc ${doc_id}.`;

          return wanted
            .map((p) =>
              [
                `## ${p.name ?? "(untitled page)"} (page_id: ${p.id})`,
                docUrl(teamId, doc_id, p.id),
                "",
                truncate((p.content ?? "").trim() || "(empty)", 6000),
              ].join("\n"),
            )
            .join("\n\n---\n\n");
        }),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_create_doc",
      "Create a ClickUp Doc (with its first page) in a space or list, or add a new page to an existing doc. Content is markdown.",
      {
        name: z.string().describe("Name of the doc or page being created."),
        content: z.string().optional().describe("Markdown content for the page."),
        space_id: z.string().optional().describe("Create a NEW doc in this space."),
        list_id: z.string().optional().describe("Create a NEW doc in this list."),
        doc_id: z.string().optional().describe("Add a page to this EXISTING doc instead."),
        parent_page_id: z
          .string()
          .optional()
          .describe("With doc_id, nest the new page under this page."),
      },
      async ({ name, content, space_id, list_id, doc_id, parent_page_id }) =>
        wrap(async () => {
          const teamId = await getTeamId();

          if (doc_id) {
            const page = await clickupRequest<{ id?: string; page?: ClickUpDocPage }>(
              `/workspaces/${teamId}/docs/${doc_id}/pages`,
              {
                version: "v3",
                method: "POST",
                body: {
                  name,
                  content: content ?? "",
                  ...(parent_page_id ? { parent_page_id } : {}),
                },
              },
            );
            const pageId = page.page?.id ?? page.id;
            return [
              `Added page "${name}" to doc ${doc_id}${pageId ? ` (page_id: ${pageId})` : ""}`,
              docUrl(teamId, doc_id, pageId),
            ].join("\n");
          }

          const parentId = space_id ?? list_id;
          if (!parentId) {
            throw new Error("Pass space_id or list_id to create a new doc, or doc_id to add a page.");
          }

          const doc = await clickupRequest<{ id: string }>(`/workspaces/${teamId}/docs`, {
            version: "v3",
            method: "POST",
            // ClickUp's parent types: 4 = Space, 6 = List.
            body: { name, create_page: false, parent: { id: parentId, type: space_id ? 4 : 6 } },
          });

          const page = await clickupRequest<{ id?: string; page?: ClickUpDocPage }>(
            `/workspaces/${teamId}/docs/${doc.id}/pages`,
            { version: "v3", method: "POST", body: { name, content: content ?? "" } },
          );
          const pageId = page.page?.id ?? page.id;

          return [
            `Created doc "${name}" (doc_id: ${doc.id})`,
            docUrl(teamId, doc.id, pageId),
          ].join("\n");
        }),
    ),

    defineRuntimeTool(
      namespace,
      "clickup_update_doc_page",
      "Update a ClickUp Doc page's markdown content and/or its name. Appends by default; pass append=false to replace the page outright.",
      {
        doc_id: z.string().describe("The doc id containing the page."),
        page_id: z.string().describe("The page id to update (from clickup_read_doc)."),
        content: z.string().optional().describe("Markdown content."),
        name: z.string().optional().describe("New page name."),
        append: z
          .boolean()
          .optional()
          .describe("Append to existing content (default true) rather than replacing it."),
      },
      async ({ doc_id, page_id, content, name, append }) =>
        wrap(async () => {
          const teamId = await getTeamId();
          const body: Record<string, unknown> = {};
          if (name !== undefined) body.name = name;
          if (content !== undefined) {
            body.content = content;
            body.content_edit_mode = append === false ? "replace" : "append";
          }
          if (!Object.keys(body).length) {
            return "Nothing to update — pass content or name.";
          }

          await clickupRequest(`/workspaces/${teamId}/docs/${doc_id}/pages/${page_id}`, {
            version: "v3",
            method: "PUT",
            body,
          });

          return [
            `Updated page ${page_id} in doc ${doc_id} (${append === false ? "replaced" : "appended"}).`,
            docUrl(teamId, doc_id, page_id),
          ].join("\n");
        }),
    ),
  ];
}

export function createClickUpMcp() {
  return createClaudeMcpServer(NAMESPACE, createClickUpTools(NAMESPACE));
}
