import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

vi.mock("../server/wiki/paths.js", () => ({
  enumerateMarkdown: vi.fn(async () =>
    ["a.md", "bad.md", "c.md"].map((rel) => ({ rel, abs: `/vault/${rel}`, section: "wiki" })),
  ),
}));

vi.mock("../server/wiki/materialize.js", () => ({
  readVaultFile: vi.fn(async (abs: string) => `# ${abs}\n\nbody`),
  isDatalessError: () => false,
}));

vi.mock("../server/embeddings.js", () => ({
  embed: vi.fn(),
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => null)),
}));

import { syncVault } from "../server/wiki/sync.js";

function calls(fn: typeof mocks.mutation, name: string): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>);
}

describe("syncVault per-file resilience", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.mutation.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.query.mockImplementation(async (ref) => {
      const name = getFunctionName(ref);
      if (name === "wikiChunks:getFile") return null;
      if (name === "wikiChunks:listHashesByPath") return [];
      if (name === "wikiChunks:listOrphans") return [];
      throw new Error(`unexpected query ${name}`);
    });
  });

  it("keeps syncing the rest of the vault when one file fails", async () => {
    mocks.mutation.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === "wikiChunks:upsertChunk" && args.path === "bad.md") {
        throw new Error("Invalid arguments provided");
      }
      return null;
    });

    const stats = await syncVault({ runId: "run-1" });

    expect(stats.fileFailures).toBe(1);
    expect(calls(mocks.mutation, "wikiChunks:upsertFile").map((a) => a.sourcePath)).toEqual([
      "a.md",
      "c.md",
    ]);
    // The failed file is marked seen, so the orphan pass keeps its old entry.
    expect(calls(mocks.mutation, "wikiChunks:markFileRun")).toEqual([
      { sourcePath: "bad.md", runId: "run-1" },
    ]);
    expect(mocks.query.mock.calls.some(([ref]) => getFunctionName(ref) === "wikiChunks:listOrphans")).toBe(true);
  });

  it("aborts before the orphan pass when the failed file cannot be marked seen", async () => {
    mocks.mutation.mockImplementation(async (ref, args) => {
      const name = getFunctionName(ref);
      if (name === "wikiChunks:upsertChunk" && args.path === "bad.md") throw new Error("boom");
      if (name === "wikiChunks:markFileRun") throw new Error("convex down");
      return null;
    });

    await expect(syncVault({ runId: "run-2" })).rejects.toThrow("boom");
    expect(mocks.query.mock.calls.some(([ref]) => getFunctionName(ref) === "wikiChunks:listOrphans")).toBe(false);
  });
});
