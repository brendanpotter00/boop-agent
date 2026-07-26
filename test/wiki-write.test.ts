import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isDatalessError } from "../server/wiki/materialize.js";
import { safeResolveForWrite } from "../server/wiki/paths.js";
import { wikiAppend, wikiEdit, wikiWrite } from "../server/wiki/write.js";

// Throwaway fixture vault — never the real one. Mirrors wiki-search.test.ts.

const originalVault = process.env.WIKI_VAULT_PATH;
const originalInclude = process.env.WIKI_SYNC_INCLUDE;
let root = "";

async function write(rel: string, body: string) {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body, "utf8");
}

const read = (rel: string) => readFile(join(root, rel), "utf8");

const PAGE = `---\ntype: concept\n---\n\n# Language Detection\n\n## What it is\n\nA library.\n\n## Related PRs / tickets\n\n- PR #417\n`;

beforeAll(async () => {
  // realpath because vaultRoot() resolves symlinks, and on macOS the temp dir
  // is reached via /var -> /private/var.
  root = realpathSync(await mkdtemp(join(tmpdir(), "wiki-write-fixture-")));
  process.env.WIKI_VAULT_PATH = root;
  process.env.WIKI_SYNC_INCLUDE = "wiki,raw";
});

afterEach(async () => {
  await rm(join(root, "wiki"), { recursive: true, force: true });
  await rm(join(root, "raw"), { recursive: true, force: true });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (originalVault === undefined) delete process.env.WIKI_VAULT_PATH;
  else process.env.WIKI_VAULT_PATH = originalVault;
  if (originalInclude === undefined) delete process.env.WIKI_SYNC_INCLUDE;
  else process.env.WIKI_SYNC_INCLUDE = originalInclude;
});

describe("safeResolveForWrite", () => {
  it("allows both the raw/ and wiki/ layers", () => {
    expect(safeResolveForWrite("wiki/career/x.md")).toBe(join(root, "wiki/career/x.md"));
    expect(safeResolveForWrite("raw/career/cisco/y.md")).toBe(
      join(root, "raw/career/cisco/y.md"),
    );
  });

  it("refuses to escape the vault", () => {
    expect(() => safeResolveForWrite("../outside.md")).toThrow(/escapes the vault/);
    expect(() => safeResolveForWrite("/etc/passwd.md")).toThrow(/escapes the vault/);
  });

  it("refuses non-markdown", () => {
    expect(() => safeResolveForWrite("wiki/notes.txt")).toThrow(/only .md/);
  });

  // The vault's CLAUDE.md is the co-evolved schema layer — the agent may
  // propose changes to it but must not make them unilaterally.
  it("refuses the vault schema file", () => {
    expect(() => safeResolveForWrite("CLAUDE.md")).toThrow(/schema layer/);
  });
});

describe("wikiWrite", () => {
  it("creates a new page and its parent directories", async () => {
    const res = await wikiWrite({
      path: "raw/career/cisco/worklog/note.md",
      content: "# Note\n\nbody\n",
    });
    expect(res).toMatch(/^Created/);
    expect(await read("raw/career/cisco/worklog/note.md")).toContain("body");
  });

  // No version control, no undo: clobbering must be opt-in, not the default.
  it("refuses to clobber an existing page by default", async () => {
    await write("wiki/page.md", PAGE);
    const res = await wikiWrite({ path: "wiki/page.md", content: "replaced" });
    expect(res).toMatch(/already exists/);
    expect(await read("wiki/page.md")).toBe(PAGE);
  });

  it("overwrites only when explicitly told to", async () => {
    await write("wiki/page.md", PAGE);
    const res = await wikiWrite({ path: "wiki/page.md", content: "replaced", overwrite: true });
    expect(res).toMatch(/^Overwrote/);
    expect(await read("wiki/page.md")).toBe("replaced");
  });
});

describe("wikiAppend", () => {
  it("appends with exactly one blank line at the seam", async () => {
    await write("wiki/page.md", PAGE);
    await wikiAppend({ path: "wiki/page.md", content: "## New\n\ncontent" });
    const out = await read("wiki/page.md");
    expect(out).toContain("- PR #417\n\n## New");
    expect(out.endsWith("\n")).toBe(true);
    // Original content survives untouched.
    expect(out).toContain("# Language Detection");
  });

  it("reports a missing page rather than creating one", async () => {
    const res = await wikiAppend({ path: "wiki/nope.md", content: "x" });
    expect(res).toMatch(/Page not found/);
  });
});

describe("wikiEdit", () => {
  it("inserts a section mid-page", async () => {
    await write("wiki/page.md", PAGE);
    const res = await wikiEdit({
      path: "wiki/page.md",
      oldText: "## Related PRs / tickets",
      newText: "## Decision lifecycle\n\nWhy it was built.\n\n## Related PRs / tickets",
    });
    expect(res).toMatch(/^Edited/);
    const out = await read("wiki/page.md");
    expect(out.indexOf("## Decision lifecycle")).toBeLessThan(
      out.indexOf("## Related PRs / tickets"),
    );
    expect(out).toContain("- PR #417");
  });

  // A replace-all against markdown boilerplate would silently corrupt a page in
  // several places at once, and there is no way back.
  it("refuses an ambiguous match instead of guessing", async () => {
    await write("wiki/page.md", "## Status\n\na\n\n## Status\n\nb\n");
    const res = await wikiEdit({ path: "wiki/page.md", oldText: "## Status", newText: "## Done" });
    expect(res).toMatch(/appears 2 times/);
    expect(await read("wiki/page.md")).toBe("## Status\n\na\n\n## Status\n\nb\n");
  });

  it("reports a non-matching snippet without touching the file", async () => {
    await write("wiki/page.md", PAGE);
    const res = await wikiEdit({ path: "wiki/page.md", oldText: "nope", newText: "x" });
    expect(res).toMatch(/not found/);
    expect(await read("wiki/page.md")).toBe(PAGE);
  });
});

describe("isDatalessError", () => {
  // This is the whole bug: macOS returns EDEADLK when a process may not
  // materialize an iCloud-evicted file, and libuv has no darwin mapping for it,
  // so Node reports `Unknown system error -11` with code "UNKNOWN". Matching on
  // code alone would swallow every other unknown error, so errno is the
  // discriminator.
  it("recognises the EDEADLK shape Node actually produces", () => {
    expect(isDatalessError(Object.assign(new Error("Unknown system error -11"), {
      errno: -11,
      code: "UNKNOWN",
      syscall: "read",
    }))).toBe(true);
    expect(isDatalessError(Object.assign(new Error("deadlock"), { code: "EDEADLK" }))).toBe(true);
  });

  it("does not treat ordinary fs errors as eviction", () => {
    expect(isDatalessError(Object.assign(new Error("nope"), { errno: -2, code: "ENOENT" }))).toBe(
      false,
    );
    expect(isDatalessError(Object.assign(new Error("perm"), { errno: -13, code: "EACCES" }))).toBe(
      false,
    );
    expect(isDatalessError(undefined)).toBe(false);
  });
});
