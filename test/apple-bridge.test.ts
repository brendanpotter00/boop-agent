import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_UNREACHABLE_MESSAGE,
  appleBridgeRequest,
  readBridgeInfo,
} from "../server/apple/client.js";
import { createAppleTools } from "../server/apple/tools.js";

const tempHome = mkdtempSync(join(tmpdir(), "boop-apple-bridge-test-"));
const originalHome = process.env.HOME;

const BRIDGE_INFO = {
  port: 4570,
  token: "a".repeat(64),
  pid: 12345,
  version: "0.1.0",
  startedAt: 1760000000000,
};

function writeBridgeInfo(): void {
  mkdirSync(join(tempHome, ".boop"), { recursive: true });
  writeFileSync(
    join(tempHome, ".boop", "apple-bridge.json"),
    JSON.stringify(BRIDGE_INFO),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apple bridge client and tools", () => {
  beforeEach(() => {
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(join(tempHome, ".boop"), { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("maps a missing bridge file to a user-readable error", async () => {
    await expect(readBridgeInfo()).resolves.toBeNull();
    await expect(appleBridgeRequest("/health")).rejects.toThrow(
      BRIDGE_UNREACHABLE_MESSAGE,
    );
  });

  it("surfaces the bridge's own message on permission errors", async () => {
    writeBridgeInfo();
    const message =
      'Calendar access is required. Open the Boop desktop app\'s "Apple Data" tab and grant Calendar access.';
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "calendar-access-required", message })),
    );

    await expect(appleBridgeRequest("/calendar/events")).rejects.toThrow(message);
  });

  it("formats iMessage history from the bridge response", async () => {
    writeBridgeInfo();
    const phoneSender = ["+", "1", "555", "555", "0100"].join("");
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        messages: [
          {
            id: 99,
            chatId: 1,
            chatName: "Test Group",
            sender: phoneSender,
            isFromMe: false,
            text: "See you at 6?",
            sentAt: "2026-06-12T01:00:00Z",
            hasAttachments: false,
          },
          {
            id: 98,
            chatId: 1,
            chatName: "Test Group",
            sender: "me",
            isFromMe: true,
            text: "",
            sentAt: "2026-06-12T00:59:00Z",
            hasAttachments: true,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createAppleTools().find((t) => t.name === "apple_read_messages");
    expect(tool).toBeDefined();
    const result = await tool!.handle({ chat_id: 1, limit: 50 });

    expect(result.success).toBe(true);
    expect(result.text).toBe(
      [
        "[2026-06-12T01:00:00Z] [phone number hidden]: See you at 6?",
        "[2026-06-12T00:59:00Z] me: (attachment)",
      ].join("\n"),
    );

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:4570/messages/list?chatId=1&limit=50");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${BRIDGE_INFO.token}`,
    });
  });

  it("reports empty results as readable text, not an error", async () => {
    writeBridgeInfo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { chats: [] })),
    );

    const tool = createAppleTools().find((t) => t.name === "apple_list_chats");
    expect(tool).toBeDefined();
    const result = await tool!.handle({});

    expect(result.success).toBe(true);
    expect(result.text).toBe("No chats found.");
  });
});
