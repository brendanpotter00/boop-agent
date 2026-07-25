/**
 * Thin client over the ClickUp REST API.
 *
 * Boop talks to ClickUp directly with a personal API token rather than going
 * through ClickUp's hosted MCP product, which meters tool calls. The REST API
 * is limited instead by a per-token, per-minute request budget (100/min on the
 * Free/Unlimited tiers — see `getRateLimit()`), so the tools in `./tools.ts`
 * are written to spend as few requests per call as possible: filtering happens
 * server-side, and the workspace tree / list metadata are cached.
 */

const API_V2 = "https://api.clickup.com/api/v2";
const API_V3 = "https://api.clickup.com/api/v3";

const REQUEST_TIMEOUT_MS = 15_000;

export const NOT_CONFIGURED_MESSAGE =
  "ClickUp isn't configured. Add CLICKUP_API_KEY (a personal token from ClickUp → Settings → Apps → API Token) to .env.local and restart Boop.";

const TIMEOUT_MESSAGE = "ClickUp didn't respond in time.";

export function clickupApiKey(): string | undefined {
  return process.env.CLICKUP_API_KEY?.trim() || undefined;
}

export function isClickUpConfigured(): boolean {
  return !!clickupApiKey();
}

export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  /** Epoch milliseconds when the current window resets. */
  resetAt: number | null;
}

let rateLimit: RateLimitSnapshot = { limit: null, remaining: null, resetAt: null };

/**
 * Last-seen rate-limit headers. ClickUp reports a rolling per-minute budget
 * that is shared by every client using the same token.
 */
export function getRateLimit(): RateLimitSnapshot {
  return { ...rateLimit };
}

function recordRateLimit(headers: Headers): void {
  const limit = Number(headers.get("x-ratelimit-limit"));
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  rateLimit = {
    limit: Number.isFinite(limit) && headers.has("x-ratelimit-limit") ? limit : rateLimit.limit,
    remaining:
      Number.isFinite(remaining) && headers.has("x-ratelimit-remaining")
        ? remaining
        : rateLimit.remaining,
    // ClickUp sends the reset as epoch *seconds*.
    resetAt: Number.isFinite(reset) && headers.has("x-ratelimit-reset") ? reset * 1000 : rateLimit.resetAt,
  };
}

export type ClickUpQuery = Record<string, string | number | boolean | string[] | undefined>;

export interface ClickUpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: ClickUpQuery;
  body?: unknown;
  /** ClickUp splits its API: tasks/time live on v2, Docs on v3. */
  version?: "v2" | "v3";
}

function buildUrl(path: string, query: ClickUpQuery | undefined, version: "v2" | "v3"): string {
  const base = version === "v3" ? API_V3 : API_V2;
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // ClickUp expects repeated bracketed params, e.g. `space_ids[]=1&space_ids[]=2`.
      for (const item of value) url.searchParams.append(`${key}[]`, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Turns a ClickUp error payload into something worth showing an agent. */
function describeError(status: number, body: unknown): string {
  const record = (body ?? {}) as Record<string, unknown>;
  const err = typeof record.err === "string" ? record.err : undefined;
  const ecode = typeof record.ECODE === "string" ? record.ECODE : undefined;
  const detail = err ?? (typeof record.error === "string" ? record.error : undefined);

  if (status === 401) {
    return "ClickUp rejected the API token (401). Check CLICKUP_API_KEY in .env.local.";
  }
  if (status === 403) {
    return `ClickUp denied access (403)${detail ? `: ${detail}` : "."} The token's user may not have permission for this workspace item.`;
  }
  if (status === 404) {
    return `ClickUp couldn't find that item (404)${detail ? `: ${detail}` : "."}`;
  }
  const suffix = [detail, ecode].filter(Boolean).join(" ");
  return `ClickUp request failed (${status})${suffix ? `: ${suffix}` : "."}`;
}

function rateLimitedMessage(): string {
  const resetAt = rateLimit.resetAt;
  const seconds = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : null;
  const when = seconds ? ` Try again in about ${seconds}s.` : "";
  return `ClickUp rate limit reached (429) — the API allows ${rateLimit.limit ?? 100} requests per minute per token.${when}`;
}

export async function clickupRequest<T = unknown>(
  path: string,
  options: ClickUpRequestOptions = {},
): Promise<T> {
  const apiKey = clickupApiKey();
  if (!apiKey) throw new Error(NOT_CONFIGURED_MESSAGE);

  const { method = "GET", query, body, version = "v2" } = options;
  const url = buildUrl(path, query, version);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        // ClickUp personal tokens go in Authorization verbatim — no "Bearer".
        Authorization: apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(TIMEOUT_MESSAGE);
    throw new Error(`Couldn't reach ClickUp: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  recordRateLimit(response.headers);

  const payload = (await response.json().catch(() => null)) as unknown;

  if (response.status === 429) throw new Error(rateLimitedMessage());
  if (!response.ok) throw new Error(describeError(response.status, payload));

  return payload as T;
}

// ---------------------------------------------------------------------------
// Small TTL cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: Promise<unknown>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Caches a request by key for `ttlMs`. Concurrent callers share one in-flight
 * promise so a burst of tool calls costs a single ClickUp request; failures are
 * evicted immediately so errors are never cached.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>;

  const value = load();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  try {
    return await value;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

export function clearClickUpCache(): void {
  cache.clear();
  rateLimit = { limit: null, remaining: null, resetAt: null };
}

// ---------------------------------------------------------------------------
// Workspace / user resolution
// ---------------------------------------------------------------------------

const WORKSPACE_TTL_MS = 10 * 60 * 1000;
const USER_TTL_MS = 10 * 60 * 1000;

export interface ClickUpUser {
  id: number;
  username: string;
  email?: string;
}

interface TeamsResponse {
  teams?: Array<{ id: string; name: string }>;
}

/**
 * Resolves the workspace ("team") id. Prefers CLICKUP_TEAM_ID; otherwise asks
 * ClickUp and uses the sole workspace, refusing to guess when there are several.
 */
export async function getTeamId(): Promise<string> {
  const configured = process.env.CLICKUP_TEAM_ID?.trim();
  if (configured) return configured;

  return cached("team-id", WORKSPACE_TTL_MS, async () => {
    const data = await clickupRequest<TeamsResponse>("/team");
    const teams = data.teams ?? [];
    if (teams.length === 0) {
      throw new Error("This ClickUp token has no accessible workspaces.");
    }
    if (teams.length > 1) {
      const options = teams.map((t) => `${t.name} (${t.id})`).join(", ");
      throw new Error(
        `This token can see multiple ClickUp workspaces: ${options}. Set CLICKUP_TEAM_ID in .env.local to pick one.`,
      );
    }
    return teams[0].id;
  });
}

export async function getCurrentUser(): Promise<ClickUpUser> {
  return cached("current-user", USER_TTL_MS, async () => {
    const data = await clickupRequest<{ user?: ClickUpUser }>("/user");
    if (!data.user) throw new Error("ClickUp didn't return a user for this token.");
    return data.user;
  });
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

const PRIORITY_TO_NUMBER: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
const NUMBER_TO_PRIORITY: Record<number, string> = { 1: "urgent", 2: "high", 3: "normal", 4: "low" };

export function priorityToNumber(priority: string): number | undefined {
  return PRIORITY_TO_NUMBER[priority.toLowerCase()];
}

export function priorityToName(priority: unknown): string | null {
  if (priority === null || priority === undefined) return null;
  // ClickUp returns priority either as an object ({ priority: "urgent" }) or a number.
  if (typeof priority === "object") {
    const value = (priority as Record<string, unknown>).priority;
    return typeof value === "string" ? value : null;
  }
  const numeric = Number(priority);
  return Number.isFinite(numeric) ? (NUMBER_TO_PRIORITY[numeric] ?? null) : null;
}

/** ISO-8601 (or epoch-ms string) → epoch milliseconds. */
export function toEpochMs(value: string): number {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && /^\d+$/.test(value.trim())) return asNumber;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`Not a valid date: "${value}"`);
  return parsed;
}

/** Epoch milliseconds (as ClickUp returns them — often a string) → ISO string. */
export function fromEpochMs(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  return new Date(numeric).toISOString();
}

export function hoursToMs(hours: number): number {
  return Math.round(hours * 60 * 60 * 1000);
}

export function msToHours(ms: unknown): number | null {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  return Math.round((numeric / (60 * 60 * 1000)) * 100) / 100;
}

export function taskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${taskId}`;
}

export function listUrl(listId: string): string {
  return `https://app.clickup.com/v/l/${listId}`;
}
