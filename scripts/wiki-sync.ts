#!/usr/bin/env tsx
// One-shot incremental sync of the personal wiki vault into the derived Convex
// index. Safe to re-run: unchanged files/chunks are skipped, vanished files are
// orphan-deleted. Run with `npm run wiki:sync`.
import "../server/env-setup.js";
import { reembedPending, syncVault } from "../server/wiki/sync.js";

async function main() {
  if (!process.env.WIKI_VAULT_PATH) {
    console.error("[wiki-sync] WIKI_VAULT_PATH not set — nothing to sync.");
    process.exit(1);
  }
  const runId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const include = process.env.WIKI_SYNC_INCLUDE ?? "wiki";
  console.log(`[wiki-sync] run ${runId}`);
  console.log(`[wiki-sync] vault=${process.env.WIKI_VAULT_PATH} include=${include}`);
  const start = Date.now();
  const stats = await syncVault({ runId, embedInline: true });
  console.log(`[wiki-sync] done in ${Date.now() - start}ms`, stats);
  if (stats.embedFailures > 0) {
    console.log(`[wiki-sync] backfilling ${stats.embedFailures} unembedded chunk(s)…`);
    const n = await reembedPending();
    console.log(`[wiki-sync] embedded ${n} pending chunk(s)`);
  }
}

main().catch((err) => {
  console.error("[wiki-sync] failed:", err);
  process.exit(1);
});
