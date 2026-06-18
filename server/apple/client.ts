import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_MESSAGES_FULL_DISK_ACCESS_MESSAGE,
  LOCAL_MESSAGES_UNSUPPORTED_MESSAGE,
  probeLocalMessagesAccess,
} from "./messages-local.js";

const REQUEST_TIMEOUT_MS = 10_000;

export const BRIDGE_UNREACHABLE_MESSAGE =
  "The Apple bridge isn't running. iMessage can still work from the local Mac server; Calendar, Reminders, and Notes require the optional bridge.";

const BRIDGE_TIMEOUT_MESSAGE =
  "The Apple bridge didn't respond in time. Calendar, Reminders, and Notes require the optional bridge to be running on this Mac.";

export interface AppleBridgeInfo {
  port: number;
  token: string;
  pid?: number;
  version?: string;
  startedAt?: number;
}

export type AppleBridgePermissions = Record<string, string>;

export interface AppleBridgeStatus {
  running: boolean;
  source: "desktop-bridge" | "local-server" | "unavailable";
  port: number | null;
  version: string | null;
  permissions: AppleBridgePermissions | null;
  error: string | null;
}

export type AppleBridgeParams = Record<string, string | number | boolean | undefined>;

function bridgeInfoPath(): string {
  return join(homedir(), ".boop", "apple-bridge.json");
}

export async function readBridgeInfo(): Promise<AppleBridgeInfo | null> {
  let raw: string;
  try {
    raw = await readFile(bridgeInfoPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string" || !parsed.token) {
      return null;
    }
    return {
      port: parsed.port,
      token: parsed.token,
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : undefined,
    };
  } catch {
    return null;
  }
}

export async function appleBridgeRequest<T = unknown>(
  path: string,
  params?: AppleBridgeParams,
): Promise<T> {
  const info = await readBridgeInfo();
  if (!info) throw new Error(BRIDGE_UNREACHABLE_MESSAGE);

  const url = new URL(path, `http://127.0.0.1:${info.port}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(BRIDGE_TIMEOUT_MESSAGE);
    }
    throw new Error(BRIDGE_UNREACHABLE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    if (!body) throw new Error("The Apple bridge returned an unreadable response.");
    return body as T;
  }

  const code = typeof body?.error === "string" ? body.error : `http-${response.status}`;
  const message =
    typeof body?.message === "string"
      ? body.message
      : `Apple bridge request failed with status ${response.status}.`;
  // 403s carry the bridge's own permission guidance — surface that text
  // verbatim to the agent/user.
  if (response.status === 403) throw new Error(message);
  throw new Error(`Apple bridge error ${code}: ${message}`);
}

interface AppleBridgeHealth {
  ok?: boolean;
  version?: string;
  permissions?: AppleBridgePermissions;
}

async function localServerStatus(): Promise<AppleBridgeStatus> {
  if (process.platform !== "darwin") {
    return {
      running: false,
      source: "unavailable",
      port: null,
      version: null,
      permissions: null,
      error: LOCAL_MESSAGES_UNSUPPORTED_MESSAGE,
    };
  }
  const messages = await probeLocalMessagesAccess();
  return {
    running: true,
    source: "local-server",
    port: null,
    version: process.version,
    permissions: {
      messages,
      calendars: "notDetermined",
      reminders: "notDetermined",
      notes: "notDetermined",
    },
    error: messages === "granted" ? null : LOCAL_MESSAGES_FULL_DISK_ACCESS_MESSAGE,
  };
}

export async function getAppleBridgeStatus(): Promise<AppleBridgeStatus> {
  const info = await readBridgeInfo();
  if (!info) {
    return localServerStatus();
  }
  try {
    const health = await appleBridgeRequest<AppleBridgeHealth>("/health");
    return {
      running: true,
      source: "desktop-bridge",
      port: info.port,
      version: health.version ?? info.version ?? null,
      permissions: health.permissions ?? null,
      error: null,
    };
  } catch (err) {
    const local = await localServerStatus();
    if (local.permissions?.messages === "granted") return local;
    return {
      running: false,
      source: "unavailable",
      port: info.port,
      version: info.version ?? null,
      permissions: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
