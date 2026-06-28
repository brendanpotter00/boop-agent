import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../server/wiki/sync.js";
import { semanticPass } from "../server/wiki/search.js";

describe("chunkMarkdown", () => {
  it("returns a single chunk for a short page", () => {
    const chunks = chunkMarkdown("# Title\n\nA short body paragraph.");
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toContain("short body");
  });

  it("captures the nearest heading for each chunk", () => {
    const doc = [
      "# Page",
      "",
      "Intro text.",
      "",
      "## Section A",
      "",
      "Alpha content.",
      "",
      "## Section B",
      "",
      "Beta content.",
    ].join("\n");
    const chunks = chunkMarkdown(doc);
    // headings tracked; at least one chunk should reference Section A or B.
    const headings = chunks.map((c) => c.heading).filter(Boolean);
    expect(headings.length).toBeGreaterThan(0);
  });

  it("splits a long page into multiple sequential chunks", () => {
    const body = ("lorem ipsum dolor sit amet ".repeat(400)).trim(); // ~10KB
    const chunks = chunkMarkdown(`# Big\n\n${body}`);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  it("produces no chunks for empty/whitespace content", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  \n")).toEqual([]);
  });
});

describe("semanticPass degradation", () => {
  it("returns an empty map (no throw) when the wiki is unconfigured", async () => {
    const saved = process.env.WIKI_VAULT_PATH;
    delete process.env.WIKI_VAULT_PATH;
    try {
      const out = await semanticPass("anything");
      expect(out.size).toBe(0);
    } finally {
      if (saved !== undefined) process.env.WIKI_VAULT_PATH = saved;
    }
  });
});
