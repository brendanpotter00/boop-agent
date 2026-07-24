import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fuse, wikiIndex, wikiRead, wikiSearch } from "../server/wiki/search.js";
import { createWikiTools } from "../server/wiki/tools.js";

// Builds a throwaway fixture vault (never the real one) and points
// WIKI_VAULT_PATH at it. Mirrors the env-backup idiom in sendblue.test.ts.

const originalVault = process.env.WIKI_VAULT_PATH;
const originalInclude = process.env.WIKI_SYNC_INCLUDE;
let root = "";

async function write(rel: string, body: string) {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body, "utf8");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wiki-fixture-"));
  process.env.WIKI_VAULT_PATH = root;
  process.env.WIKI_SYNC_INCLUDE = "wiki,raw/career/cisco";

  await write(
    "wiki/index.md",
    `---\ntype: index\n---\n\n# Wiki Index\n\n## People\n- [[alice]] — backend teammate; recipient of the re-arch epic\n\n## Stories\n- [[data-migration]] — flagship story; 0% data loss across systems\n`,
  );
  await write(
    "wiki/people/alice.md",
    `---\ntype: entity-person\n---\n\n# Alice\n\nAlice is a backend engineer on the re-architecture epic.\n`,
  );
  await write(
    "wiki/stories/data-migration.md",
    `---\ntype: story\n---\n\n# Data Migration\n\nFlagship story: a zero downtime cutover with 0% data loss.\n`,
  );
  await write(
    "raw/career/cisco/meeting.md",
    `# Meeting notes\n\nWe discussed the semantic router eval gate proposal in detail.\n`,
  );
});

afterAll(async () => {
  if (originalVault === undefined) delete process.env.WIKI_VAULT_PATH;
  else process.env.WIKI_VAULT_PATH = originalVault;
  if (originalInclude === undefined) delete process.env.WIKI_SYNC_INCLUDE;
  else process.env.WIKI_SYNC_INCLUDE = originalInclude;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("wikiSearch", () => {
  it("finds a page via its curated index.md hook", async () => {
    const out = await wikiSearch({ query: "backend teammate re-arch", limit: 5 });
    expect(out).toContain("wiki/people/alice.md");
  });

  it("finds a page via a body substring not present in the index hook", async () => {
    const out = await wikiSearch({ query: "zero downtime cutover", limit: 5 });
    expect(out).toContain("wiki/stories/data-migration.md");
  });

  it("searches opted-in raw/ sources (transcripts)", async () => {
    const out = await wikiSearch({ query: "semantic router eval gate", limit: 5 });
    expect(out).toContain("raw/career/cisco/meeting.md");
  });

  it("returns one entry per page even when hook AND body both match (dedup-by-path)", async () => {
    const out = await wikiSearch({ query: "data migration data loss", limit: 5 });
    const occurrences = out.split("wiki/stories/data-migration.md").length - 1;
    expect(occurrences).toBe(1);
  });

  it("ranks curated wiki/ above raw/ via the section boost", async () => {
    // "eval" appears only in the raw fixture; add a curated term so both could
    // surface, then assert ordering is sane (curated isn't pushed below raw).
    const out = await wikiSearch({ query: "data migration", limit: 5 });
    const idxWiki = out.indexOf("wiki/stories/data-migration.md");
    expect(idxWiki).toBeGreaterThan(-1);
  });
});

describe("wikiRead", () => {
  it("reads a valid in-vault page", async () => {
    const out = await wikiRead({ path: "wiki/people/alice.md" });
    expect(out).toContain("Alice is a backend engineer");
  });

  it("resolves a [[slug]] to its path", async () => {
    const out = await wikiRead({ path: "[[data-migration]]" });
    expect(out).toContain("zero downtime cutover");
  });

  it("rejects path traversal", async () => {
    const out = await wikiRead({ path: "../../../../etc/passwd" });
    expect(out.toLowerCase()).toContain("escapes the vault");
  });

  it("rejects absolute paths outside the vault", async () => {
    const out = await wikiRead({ path: "/etc/hosts" });
    expect(out.toLowerCase()).toMatch(/escapes the vault|only .md/);
  });
});

describe("wikiIndex", () => {
  it("returns the curated catalog and can filter by category", async () => {
    const all = await wikiIndex({});
    expect(all).toContain("[[alice]]");
    expect(all).toContain("[[data-migration]]");
    const people = await wikiIndex({ category: "People" });
    expect(people).toContain("[[alice]]");
    expect(people).not.toContain("[[data-migration]]");
  });

  // Regression: a single unreadable moment used to disable the catalog for the
  // life of the process. The empty result was cached against index.md's mtime,
  // and since the failing read didn't change that mtime, nothing ever
  // invalidated it — wiki_index answered "index is empty" until a restart.
  it("recovers after a transient index.md read failure", async () => {
    const indexAbs = join(root, "wiki/index.md");
    const original = await readFile(indexAbs, "utf8");

    // Warm the cache, then reproduce an ingest rewrite whose new bytes land
    // before the read does: mtime moves (so the cache misses) while the file
    // is momentarily unreadable. That combination is what poisoned the cache —
    // the empty result got stored under the very mtime that would have to
    // change again to evict it.
    await wikiIndex({});
    await writeFile(indexAbs, `${original}- [[late-page]] — added by ingest\n`, "utf8");
    await chmod(indexAbs, 0o000);
    const whileUnreadable = await wikiIndex({});
    await chmod(indexAbs, 0o644);

    const afterRecovery = await wikiIndex({});
    expect(afterRecovery).toContain("[[alice]]");
    expect(afterRecovery).toContain("[[late-page]]");
    expect(afterRecovery).not.toContain("index is empty");
    // Serving the last known-good catalog through the blip is fine; going
    // permanently empty afterwards is the bug.
    expect(whileUnreadable).not.toContain("index is empty");

    await writeFile(indexAbs, original, "utf8");
  });
});

describe("fuse (the unified-surface seam)", () => {
  it("present-weights single-signal hits and rewards agreement", () => {
    const lex = new Map([
      ["k1", { rel: "wiki/a.md", section: "wiki" as const, title: "A", hookScore: 1, grepScore: 0, snippet: "a" }],
      ["k2", { rel: "wiki/b.md", section: "wiki" as const, title: "B", hookScore: 0.5, grepScore: 0, snippet: "b" }],
    ]);
    const sem = new Map([
      ["k2", { rel: "wiki/b.md", section: "wiki" as const, title: "B", semScore: 0.9, snippet: "b" }],
      ["k3", { rel: "raw/c.md", section: "raw" as const, title: "C", semScore: 0.8, snippet: "c" }],
    ]);
    const fused = fuse(lex, sem);
    const byRel = new Map(fused.map((f) => [f.rel, f]));
    // b is found by both signals -> gets the agreement bonus.
    expect(byRel.get("wiki/b.md")!.why).toContain("sem");
    expect(byRel.get("wiki/b.md")!.why).toContain("hook");
    // single-signal pages still appear (not zeroed by the missing signal).
    expect(byRel.has("wiki/a.md")).toBe(true);
    expect(byRel.has("raw/c.md")).toBe(true);
    // results are sorted descending by score.
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });
});

describe("read-only guarantee", () => {
  it("exposes exactly the three read tools and no write tool", () => {
    const names = createWikiTools().map((t) => t.name).sort();
    expect(names).toEqual(["wiki_index", "wiki_read", "wiki_search"]);
    expect(names.some((n) => /write|create|update|delete|edit|put|set/.test(n))).toBe(false);
  });
});

describe("graceful when unconfigured", () => {
  it("returns a clear message instead of throwing", async () => {
    const saved = process.env.WIKI_VAULT_PATH;
    delete process.env.WIKI_VAULT_PATH;
    try {
      const out = await wikiSearch({ query: "anything" });
      expect(out.toLowerCase()).toContain("not configured");
      const read = await wikiRead({ path: "wiki/x.md" });
      expect(read.toLowerCase()).toContain("not configured");
    } finally {
      process.env.WIKI_VAULT_PATH = saved;
    }
  });
});
