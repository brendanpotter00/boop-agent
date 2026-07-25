import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearClickUpCache,
  clickupRequest,
  fromEpochMs,
  getRateLimit,
  hoursToMs,
  isClickUpConfigured,
  msToHours,
  priorityToName,
  priorityToNumber,
  toEpochMs,
} from "../server/clickup/client.js";
import { createClickUpTools } from "../server/clickup/tools.js";

const ORIGINAL_ENV = {
  key: process.env.CLICKUP_API_KEY,
  team: process.env.CLICKUP_TEAM_ID,
  list: process.env.CLICKUP_DEFAULT_LIST_ID,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Replaces fetch with a queue of canned responses and records every call. */
function stubFetch(responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected extra fetch to ${String(input)}`);
    return next;
  });
  return calls;
}

function toolNamed(name: string) {
  const tool = createClickUpTools().find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  process.env.CLICKUP_API_KEY = "pk_test_token";
  process.env.CLICKUP_TEAM_ID = "9000";
  delete process.env.CLICKUP_DEFAULT_LIST_ID;
  clearClickUpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearClickUpCache();
  process.env.CLICKUP_API_KEY = ORIGINAL_ENV.key;
  process.env.CLICKUP_TEAM_ID = ORIGINAL_ENV.team;
  process.env.CLICKUP_DEFAULT_LIST_ID = ORIGINAL_ENV.list;
  if (ORIGINAL_ENV.key === undefined) delete process.env.CLICKUP_API_KEY;
  if (ORIGINAL_ENV.team === undefined) delete process.env.CLICKUP_TEAM_ID;
  if (ORIGINAL_ENV.list === undefined) delete process.env.CLICKUP_DEFAULT_LIST_ID;
});

describe("conversions", () => {
  it("maps priority names to ClickUp's numeric scale and back", () => {
    expect(priorityToNumber("urgent")).toBe(1);
    expect(priorityToNumber("high")).toBe(2);
    expect(priorityToNumber("normal")).toBe(3);
    expect(priorityToNumber("low")).toBe(4);
    expect(priorityToName(1)).toBe("urgent");
    expect(priorityToName("4")).toBe("low");
    // ClickUp sometimes returns priority as an object rather than a number.
    expect(priorityToName({ priority: "high" })).toBe("high");
    expect(priorityToName(null)).toBeNull();
  });

  it("converts dates and durations the way the ClickUp API expects", () => {
    expect(toEpochMs("2026-08-01T00:00:00.000Z")).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(toEpochMs("1785018513000")).toBe(1785018513000);
    expect(() => toEpochMs("not a date")).toThrow(/valid date/);

    expect(hoursToMs(1.5)).toBe(5_400_000);
    expect(msToHours(5_400_000)).toBe(1.5);
    // ClickUp returns 0/null for "unset" — that should read as absent, not epoch 0.
    expect(fromEpochMs(0)).toBeNull();
    expect(fromEpochMs(null)).toBeNull();
    expect(fromEpochMs("1785018513000")).toBe(new Date(1785018513000).toISOString());
  });
});

describe("clickupRequest", () => {
  it("sends the personal token verbatim, without a Bearer prefix", async () => {
    const calls = stubFetch([jsonResponse(200, { ok: true })]);
    await clickupRequest("/user");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "pk_test_token" });
  });

  it("serialises array query params as repeated bracketed keys", async () => {
    const calls = stubFetch([jsonResponse(200, { tasks: [] })]);
    await clickupRequest("/team/9000/task", {
      query: { list_ids: ["1", "2"], include_closed: false, missing: undefined },
    });
    expect(calls[0].url).toContain("list_ids%5B%5D=1");
    expect(calls[0].url).toContain("list_ids%5B%5D=2");
    expect(calls[0].url).toContain("include_closed=false");
    expect(calls[0].url).not.toContain("missing");
  });

  it("routes v3 calls to the Docs API base", async () => {
    const calls = stubFetch([jsonResponse(200, { docs: [] })]);
    await clickupRequest("/workspaces/9000/docs", { version: "v3" });
    expect(calls[0].url).toContain("https://api.clickup.com/api/v3/workspaces/9000/docs");
  });

  it("records rate-limit headers and converts the reset to milliseconds", async () => {
    stubFetch([
      jsonResponse(200, {}, {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "97",
        "x-ratelimit-reset": "1785018513",
      }),
    ]);
    await clickupRequest("/user");
    expect(getRateLimit()).toEqual({ limit: 100, remaining: 97, resetAt: 1785018513000 });
  });

  it("explains a 429 in terms of the per-minute budget", async () => {
    stubFetch([jsonResponse(429, { err: "Rate limit exceeded" }, { "x-ratelimit-limit": "100" })]);
    await expect(clickupRequest("/user")).rejects.toThrow(/rate limit reached.*per minute/i);
  });

  it("gives actionable messages for auth and missing-item failures", async () => {
    stubFetch([jsonResponse(401, { err: "Token invalid" })]);
    await expect(clickupRequest("/user")).rejects.toThrow(/CLICKUP_API_KEY/);

    stubFetch([jsonResponse(404, { err: "Task not found" })]);
    await expect(clickupRequest("/task/abc")).rejects.toThrow(/couldn't find that item \(404\)/i);
  });

  it("refuses to call out when no token is configured", async () => {
    delete process.env.CLICKUP_API_KEY;
    expect(isClickUpConfigured()).toBe(false);
    await expect(clickupRequest("/user")).rejects.toThrow(/CLICKUP_API_KEY/);
  });
});

describe("clickup_create_task", () => {
  it("converts priority, dates and estimate, and defaults the assignee to the token user", async () => {
    const calls = stubFetch([
      jsonResponse(200, { user: { id: 42, username: "tester" } }),
      jsonResponse(200, { id: "abc123", name: "Fix the thing", status: { status: "to do" } }),
    ]);

    const result = await toolNamed("clickup_create_task").handle({
      name: "Fix the thing",
      list_id: "555",
      description: "**bold** body",
      priority: "high",
      due_date: "2026-08-01T00:00:00.000Z",
      time_estimate: 2.5,
    });

    const body = bodyOf(calls[1]);
    expect(calls[1].url).toContain("/list/555/task");
    expect(calls[1].init.method).toBe("POST");
    expect(body.priority).toBe(2);
    expect(body.markdown_description).toBe("**bold** body");
    expect(body.due_date).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(body.time_estimate).toBe(9_000_000);
    expect(body.assignees).toEqual([42]);
    expect(result.text).toContain("https://app.clickup.com/t/abc123");
  });

  it("falls back to CLICKUP_DEFAULT_LIST_ID when no list is given", async () => {
    process.env.CLICKUP_DEFAULT_LIST_ID = "900100100100";
    const calls = stubFetch([
      jsonResponse(200, { user: { id: 42 } }),
      jsonResponse(200, { id: "xyz789", name: "Ticket" }),
    ]);

    await toolNamed("clickup_create_task").handle({ name: "Ticket" });
    expect(calls[1].url).toContain("/list/900100100100/task");
  });

  it("asks for a list instead of guessing when none is configured", async () => {
    stubFetch([jsonResponse(200, { user: { id: 42 } })]);
    const result = await toolNamed("clickup_create_task").handle({ name: "Ticket" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("CLICKUP_DEFAULT_LIST_ID");
  });
});

describe("clickup_update_task", () => {
  it("appends to the description rather than overwriting it", async () => {
    const calls = stubFetch([
      jsonResponse(200, { id: "abc123", markdown_description: "Original body" }),
      jsonResponse(200, { id: "abc123", name: "T", status: { status: "in progress" } }),
    ]);

    await toolNamed("clickup_update_task").handle({
      task_id: "abc123",
      append_description: "extra context",
    });

    const body = bodyOf(calls[1]);
    expect(calls[1].init.method).toBe("PUT");
    expect(String(body.markdown_description)).toContain("Original body");
    expect(String(body.markdown_description)).toContain("extra context");
  });

  it("sends assignees as an add/remove diff, which is what updates require", async () => {
    const calls = stubFetch([jsonResponse(200, { id: "abc123", name: "T" })]);
    await toolNamed("clickup_update_task").handle({ task_id: "abc123", assignees: ["7", "8"] });
    expect(bodyOf(calls[0]).assignees).toEqual({ add: [7, 8], rem: [] });
  });

  it("does not call ClickUp at all when there is nothing to change", async () => {
    const calls = stubFetch([]);
    const result = await toolNamed("clickup_update_task").handle({ task_id: "abc123" });
    expect(calls).toHaveLength(0);
    expect(result.text).toContain("Nothing to update");
  });
});

describe("clickup_search_tasks", () => {
  it("pushes filters server-side and defaults to excluding closed tasks", async () => {
    const calls = stubFetch([
      jsonResponse(200, { tasks: [{ id: "t1", name: "Alpha", status: { status: "to do" } }], last_page: true }),
    ]);

    await toolNamed("clickup_search_tasks").handle({ list_ids: ["555"], limit: 5 });

    expect(calls[0].url).toContain("list_ids%5B%5D=555");
    expect(calls[0].url).toContain("include_closed=false");
    expect(calls[0].url).toContain("order_by=updated");
  });

  it("spends exactly one request when there is no text query", async () => {
    const calls = stubFetch([jsonResponse(200, { tasks: [], last_page: true })]);
    await toolNamed("clickup_search_tasks").handle({});
    expect(calls).toHaveLength(1);
  });

  it("matches a text query against name, tags and id", async () => {
    stubFetch([
      jsonResponse(200, {
        tasks: [
          { id: "t1", name: "Fix login bug", status: { status: "to do" } },
          { id: "t2", name: "Unrelated", status: { status: "to do" } },
        ],
        last_page: true,
      }),
    ]);

    const result = await toolNamed("clickup_search_tasks").handle({ query: "login" });
    expect(result.text).toContain("Fix login bug");
    expect(result.text).not.toContain("Unrelated");
  });
});

describe("clickup_log_time", () => {
  it("books hours as milliseconds ending now by default", async () => {
    const calls = stubFetch([jsonResponse(200, { data: { id: "te1" } })]);

    await toolNamed("clickup_log_time").handle({ task_id: "abc123", hours: 0.25 });

    const body = bodyOf(calls[0]);
    expect(calls[0].url).toContain("/team/9000/time_entries");
    expect(body.tid).toBe("abc123");
    expect(body.duration).toBe(900_000);
    expect(Number(body.start)).toBeLessThanOrEqual(Date.now());
  });

  it("rejects a non-positive duration before calling ClickUp", async () => {
    const calls = stubFetch([]);
    const result = await toolNamed("clickup_log_time").handle({ task_id: "abc123", hours: 0 });
    expect(calls).toHaveLength(0);
    expect(result.success).toBe(false);
  });
});

describe("clickup_create_doc", () => {
  it("creates the doc then its first page, tagging a space parent as type 4", async () => {
    const calls = stubFetch([
      jsonResponse(200, { id: "doc1" }),
      jsonResponse(200, { id: "page1" }),
    ]);

    await toolNamed("clickup_create_doc").handle({
      name: "Notes",
      content: "# Hello",
      space_id: "90110011001",
    });

    expect(bodyOf(calls[0]).parent).toEqual({ id: "90110011001", type: 4 });
    expect(calls[1].url).toContain("/docs/doc1/pages");
    expect(bodyOf(calls[1]).content).toBe("# Hello");
  });

  it("tags a list parent as type 6", async () => {
    const calls = stubFetch([jsonResponse(200, { id: "doc2" }), jsonResponse(200, { id: "p" })]);
    await toolNamed("clickup_create_doc").handle({ name: "Notes", list_id: "555" });
    expect(bodyOf(calls[0]).parent).toEqual({ id: "555", type: 6 });
  });
});

describe("clickup_update_doc_page", () => {
  it("appends by default and replaces only when asked", async () => {
    let calls = stubFetch([jsonResponse(200, {})]);
    await toolNamed("clickup_update_doc_page").handle({
      doc_id: "d",
      page_id: "p",
      content: "more",
    });
    expect(bodyOf(calls[0]).content_edit_mode).toBe("append");

    vi.unstubAllGlobals();
    calls = stubFetch([jsonResponse(200, {})]);
    await toolNamed("clickup_update_doc_page").handle({
      doc_id: "d",
      page_id: "p",
      content: "fresh",
      append: false,
    });
    expect(bodyOf(calls[0]).content_edit_mode).toBe("replace");
  });
});

describe("tool surface", () => {
  it("exposes every tool under the clickup namespace with a JSON schema", () => {
    const tools = createClickUpTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.namespace).toBe("clickup");
      expect(tool.name.startsWith("clickup_")).toBe(true);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.jsonSchema).toMatchObject({ type: "object" });
    }
  });
});
