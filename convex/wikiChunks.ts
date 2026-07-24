import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Convex functions for the derived wiki search index. The vault is the source
 * of truth; everything here is a rebuildable cache written one-way by
 * server/wiki/sync.ts. Mirrors the memoryRecords vector-search pattern but in
 * a separate table so memory consolidation/decay never touches it.
 */

const sectionV = v.union(v.literal("wiki"), v.literal("raw"));

// --- chunk writes -----------------------------------------------------------

export const upsertChunk = mutation({
  args: {
    path: v.string(),
    title: v.string(),
    heading: v.optional(v.string()),
    chunkIndex: v.number(),
    content: v.string(),
    contentHash: v.string(),
    section: sectionV,
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wikiChunks")
      .withIndex("by_path_and_chunk", (q) =>
        q.eq("path", args.path).eq("chunkIndex", args.chunkIndex),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        title: args.title,
        heading: args.heading,
        content: args.content,
        contentHash: args.contentHash,
        section: args.section,
        // Only overwrite the embedding when a new one is supplied; otherwise
        // keep whatever is there (lets sync upsert content first, embed later).
        embedding: args.embedding ?? existing.embedding,
        lifecycle: "active",
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("wikiChunks", {
      path: args.path,
      title: args.title,
      heading: args.heading,
      chunkIndex: args.chunkIndex,
      content: args.content,
      contentHash: args.contentHash,
      section: args.section,
      embedding: args.embedding,
      lifecycle: "active",
      updatedAt: now,
    });
  },
});

/** Existing chunk hashes for a page, so sync can skip unchanged chunks. */
export const listHashesByPath = query({
  args: { path: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("wikiChunks")
      .withIndex("by_path", (q) => q.eq("path", args.path))
      .take(2000);
    return rows.map((r) => ({
      chunkIndex: r.chunkIndex,
      contentHash: r.contentHash,
      hasEmbedding: !!(r.embedding && r.embedding.length > 0),
    }));
  },
});

/** Delete every chunk for a page (orphaned file, or before a full re-chunk). */
export const deleteByPath = mutation({
  args: { path: v.string() },
  handler: async (ctx, args) => {
    let deleted = 0;
    // Bounded batches — Convex mutations are transactions with limits.
    for (;;) {
      const batch = await ctx.db
        .query("wikiChunks")
        .withIndex("by_path", (q) => q.eq("path", args.path))
        .take(200);
      if (batch.length === 0) break;
      for (const row of batch) await ctx.db.delete(row._id);
      deleted += batch.length;
      if (batch.length < 200) break;
    }
    return deleted;
  },
});

/** Delete chunks at chunkIndex >= minIndex (used when a page shrinks). */
export const deleteChunksFrom = mutation({
  args: { path: v.string(), minIndex: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("wikiChunks")
      .withIndex("by_path", (q) => q.eq("path", args.path))
      .take(2000);
    let deleted = 0;
    for (const row of rows) {
      if (row.chunkIndex >= args.minIndex) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return deleted;
  },
});

// --- search -----------------------------------------------------------------

export const getByIds = query({
  args: { ids: v.array(v.id("wikiChunks")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const r = await ctx.db.get(id);
      if (r) out.push(r);
    }
    return out;
  },
});

export const vectorSearch = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
    section: v.optional(sectionV),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ _id: Id<"wikiChunks">; score: number; record: any }>> => {
    const want = args.limit ?? 30;
    // Vector filters only support equality/or on filterFields, so filter by
    // lifecycle here and post-filter section after hydrating (over-fetch to
    // compensate).
    const results = await ctx.vectorSearch("wikiChunks", "by_embedding", {
      vector: args.embedding,
      limit: args.section ? want * 4 : want,
      filter: (q) => q.eq("lifecycle", "active"),
    });
    const records = await ctx.runQuery(api.wikiChunks.getByIds, {
      ids: results.map((r) => r._id),
    });
    const byId = new Map(records.map((r: any) => [r._id, r]));
    return results
      .map((r) => ({ _id: r._id, score: r._score, record: byId.get(r._id) }))
      .filter((r) => r.record && (!args.section || r.record.section === args.section))
      .slice(0, want);
  },
});

/** Substring keyword fallback over chunk content (Convex-side lexical pass). */
export const search = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    section: v.optional(sectionV),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 30;
    const q = args.query.toLowerCase();
    const active = await ctx.db
      .query("wikiChunks")
      .withIndex("by_lifecycle", (idx) => idx.eq("lifecycle", "active"))
      .take(2000);
    return active
      .filter(
        (r) =>
          (!args.section || r.section === args.section) &&
          (r.content.toLowerCase().includes(q) ||
            r.title.toLowerCase().includes(q)),
      )
      .slice(0, limit);
  },
});

// --- re-embed loop (Phase 3 background backfill) ----------------------------

export const listUnembeddedPage = query({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("wikiChunks")
      .withIndex("by_lifecycle", (q) => q.eq("lifecycle", "active"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.pageSize ?? 50 });
    return {
      page: result.page
        .filter((r) => !r.embedding || r.embedding.length === 0)
        .map((r) => ({ id: r._id, content: r.content })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const setEmbedding = mutation({
  args: { id: v.id("wikiChunks"), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
    return args.id;
  },
});

// --- file manifest (incremental sync + remote read fallback) ----------------

export const getFile = query({
  args: { sourcePath: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("wikiFiles")
      .withIndex("by_source", (q) => q.eq("sourcePath", args.sourcePath))
      .unique();
  },
});

/** Page content served from Convex when the filesystem isn't reachable. */
export const getFileContent = query({
  args: { sourcePath: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("wikiFiles")
      .withIndex("by_source", (q) => q.eq("sourcePath", args.sourcePath))
      .unique();
    return row ? { title: row.title, content: row.content } : null;
  },
});

export const upsertFile = mutation({
  args: {
    sourcePath: v.string(),
    fileHash: v.string(),
    title: v.string(),
    content: v.string(),
    section: sectionV,
    chunkCount: v.number(),
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wikiFiles")
      .withIndex("by_source", (q) => q.eq("sourcePath", args.sourcePath))
      .unique();
    const now = Date.now();
    const patch = {
      fileHash: args.fileHash,
      title: args.title,
      content: args.content,
      section: args.section,
      chunkCount: args.chunkCount,
      lastRunId: args.runId,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("wikiFiles", { sourcePath: args.sourcePath, ...patch });
  },
});

/** Touch a still-present-but-unchanged file so it isn't seen as an orphan. */
export const markFileRun = mutation({
  args: { sourcePath: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wikiFiles")
      .withIndex("by_source", (q) => q.eq("sourcePath", args.sourcePath))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { lastRunId: args.runId });
    return existing?._id ?? null;
  },
});

/** Files not seen in the latest sync run = orphans (deleted from the vault). */
export const listOrphans = query({
  args: { runId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("wikiFiles").take(args.limit ?? 5000);
    return rows
      .filter((r) => r.lastRunId !== args.runId)
      .map((r) => ({ sourcePath: r.sourcePath }));
  },
});

export const deleteFile = mutation({
  args: { sourcePath: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wikiFiles")
      .withIndex("by_source", (q) => q.eq("sourcePath", args.sourcePath))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return existing?._id ?? null;
  },
});

/**
 * One page of the stats scan. Counting is unavoidably a full-table walk (Convex
 * reads whole documents — there is no projection), and these rows are fat:
 * `wikiFiles.content` holds an entire page and every chunk carries a 1024-float
 * embedding. Counting both tables in a single execution blew the 16MB
 * read-per-execution limit once the index was fully populated — the query
 * failed precisely when the vault was healthy. Convex's byte budget is per
 * execution, so the fix has to be more executions, not a smaller `take`.
 */
export const statsPage = query({
  args: {
    table: v.union(v.literal("chunks"), v.literal("files")),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Sized so a page stays well inside 16MB: chunk ≈ content + 1024 floats
    // (~8KB), file = one whole markdown page (tens of KB).
    const numItems = args.numItems ?? (args.table === "chunks" ? 400 : 100);
    if (args.table === "files") {
      const page = await ctx.db
        .query("wikiFiles")
        .paginate({ cursor: args.cursor ?? null, numItems });
      return {
        count: page.page.length,
        embedded: 0,
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    const page = await ctx.db
      .query("wikiChunks")
      .withIndex("by_lifecycle", (q) => q.eq("lifecycle", "active"))
      .paginate({ cursor: args.cursor ?? null, numItems });
    let embedded = 0;
    for (const c of page.page) if (c.embedding && c.embedding.length > 0) embedded++;
    return {
      count: page.page.length,
      embedded,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Index health: active chunks, how many are embedded, and files in the
 * manifest. Diagnostic only — nothing in the request path calls it.
 */
export const stats = action({
  args: {},
  handler: async (ctx): Promise<{ chunks: number; embedded: number; files: number }> => {
    const walk = async (table: "chunks" | "files") => {
      let cursor: string | null = null;
      let count = 0;
      let embedded = 0;
      // Bounded so a cursor that never reports done can't spin forever.
      for (let page = 0; page < 500; page++) {
        // Explicit annotation: this action references `api` from its own file,
        // so inference would otherwise be circular.
        const res: {
          count: number;
          embedded: number;
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(api.wikiChunks.statsPage, { table, cursor });
        count += res.count;
        embedded += res.embedded;
        if (res.isDone) break;
        cursor = res.continueCursor;
      }
      return { count, embedded };
    };
    const chunks = await walk("chunks");
    const files = await walk("files");
    return { chunks: chunks.count, embedded: chunks.embedded, files: files.count };
  },
});
