import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { convex } from "../convex-client.js";
import { embed, embedBatch } from "../embeddings.js";
import { enumerateMarkdown, type VaultFile } from "./paths.js";

/**
 * One-way sync from the vault (source of truth) into the derived Convex index.
 * Cost is O(changed files): a per-file content hash skips unchanged files, a
 * per-chunk hash skips unchanged chunks, and files that vanished from the vault
 * are orphan-deleted so the index stays a faithful mirror.
 */

const MAX_CHARS = 3000; // ~800 tokens
const OVERLAP_CHARS = 400; // ~100 tokens carried between chunks

export interface Chunk {
  chunkIndex: number;
  content: string;
  heading?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function titleOf(text: string, rel: string): string {
  const m = /^#\s+(.+)$/m.exec(text);
  if (m) return m[1].trim();
  return basename(rel).replace(/\.md$/, "");
}

/**
 * Split a markdown page into overlapping, heading-aware chunks. Size-based with
 * a soft preference to start a fresh chunk at a heading; robust for transcripts
 * that have few/no headings.
 */
export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split("\n");
  const raw: { content: string; heading?: string }[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let curHeading: string | undefined;

  const flush = () => {
    const content = buf.join("\n").trim();
    if (content) raw.push({ content, heading: curHeading });
  };

  for (const line of lines) {
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h && bufLen > MAX_CHARS / 3) {
      // Start a new chunk at a heading boundary once we have some content.
      flush();
      const tail = buf.join("\n").slice(-OVERLAP_CHARS);
      buf = tail ? [tail] : [];
      bufLen = tail.length;
    }
    if (h) curHeading = h[1].trim();
    buf.push(line);
    bufLen += line.length + 1;
    if (bufLen >= MAX_CHARS) {
      flush();
      const tail = buf.join("\n").slice(-OVERLAP_CHARS);
      buf = tail ? [tail] : [];
      bufLen = tail.length;
    }
  }
  flush();
  return raw.map((r, i) => ({ chunkIndex: i, content: r.content, heading: r.heading }));
}

export interface SyncStats {
  filesScanned: number;
  filesChanged: number;
  chunksUpserted: number;
  chunksSkipped: number;
  orphansDeleted: number;
  embedFailures: number;
}

export async function syncVault(opts: { runId: string; embedInline?: boolean }): Promise<SyncStats> {
  const embedInline = opts.embedInline ?? true;
  const files = await enumerateMarkdown();
  const stats: SyncStats = {
    filesScanned: files.length,
    filesChanged: 0,
    chunksUpserted: 0,
    chunksSkipped: 0,
    orphansDeleted: 0,
    embedFailures: 0,
  };

  for (const f of files) {
    await syncFile(f, opts.runId, embedInline, stats);
  }

  // Orphan delete: any manifest file not touched this run is gone from the vault.
  const orphans = await convex.query(api.wikiChunks.listOrphans, { runId: opts.runId });
  for (const o of orphans) {
    await convex.mutation(api.wikiChunks.deleteByPath, { path: o.sourcePath });
    await convex.mutation(api.wikiChunks.deleteFile, { sourcePath: o.sourcePath });
    stats.orphansDeleted++;
  }
  return stats;
}

async function syncFile(
  f: VaultFile,
  runId: string,
  embedInline: boolean,
  stats: SyncStats,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(f.abs, "utf8");
  } catch {
    return;
  }
  const fileHash = sha256(text);
  const existingFile = await convex.query(api.wikiChunks.getFile, { sourcePath: f.rel });
  if (existingFile && existingFile.fileHash === fileHash) {
    // Unchanged — just mark it seen this run so it isn't orphaned.
    await convex.mutation(api.wikiChunks.markFileRun, { sourcePath: f.rel, runId });
    return;
  }

  stats.filesChanged++;
  const title = titleOf(text, f.rel);
  const chunks = chunkMarkdown(text);
  const existingHashes = await convex.query(api.wikiChunks.listHashesByPath, { path: f.rel });
  const byIndex = new Map(existingHashes.map((h) => [h.chunkIndex, h]));

  // Determine which chunks actually changed (content hash differs or missing).
  const changed: Chunk[] = [];
  for (const c of chunks) {
    const prev = byIndex.get(c.chunkIndex);
    const hash = sha256(c.content);
    if (prev && prev.contentHash === hash && prev.hasEmbedding) {
      stats.chunksSkipped++;
    } else {
      changed.push(c);
    }
  }

  // Embed changed chunks (batched). On a missing key this uses the local model.
  let vectors: (number[] | null)[] = [];
  if (embedInline && changed.length > 0) {
    vectors = await embedBatch(changed.map((c) => c.content));
  }

  for (let i = 0; i < changed.length; i++) {
    const c = changed[i];
    const embedding = embedInline ? vectors[i] ?? undefined : undefined;
    if (embedInline && !embedding) stats.embedFailures++;
    await convex.mutation(api.wikiChunks.upsertChunk, {
      path: f.rel,
      title,
      heading: c.heading,
      chunkIndex: c.chunkIndex,
      content: c.content,
      contentHash: sha256(c.content),
      section: f.section,
      embedding,
    });
    stats.chunksUpserted++;
  }

  // If the file shrank, drop trailing chunks that no longer exist.
  await convex.mutation(api.wikiChunks.deleteChunksFrom, { path: f.rel, minIndex: chunks.length });

  await convex.mutation(api.wikiChunks.upsertFile, {
    sourcePath: f.rel,
    fileHash,
    title,
    content: text,
    section: f.section,
    chunkCount: chunks.length,
    runId,
  });
}

/**
 * Background backfill: embed any chunks left without a vector (e.g. transient
 * embed failures during sync). Walks pages via cursor; restartable.
 */
export async function reembedPending(opts: { maxBatches?: number } = {}): Promise<number> {
  const maxBatches = opts.maxBatches ?? Infinity;
  let cursor: string | null = null;
  let embedded = 0;
  type UnembeddedPage = {
    page: Array<{ id: Id<"wikiChunks">; content: string }>;
    isDone: boolean;
    continueCursor: string;
  };
  for (let b = 0; b < maxBatches; b++) {
    const page: UnembeddedPage = await convex.query(api.wikiChunks.listUnembeddedPage, {
      cursor,
      pageSize: 50,
    });
    if (page.page.length > 0) {
      const vecs = await embedBatch(page.page.map((p) => p.content));
      for (let i = 0; i < page.page.length; i++) {
        const v = vecs[i];
        if (v) {
          await convex.mutation(api.wikiChunks.setEmbedding, { id: page.page[i].id, embedding: v });
          embedded++;
        }
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return embedded;
}
