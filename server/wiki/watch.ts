import { watch } from "node:fs";
import { vaultRoot, wikiConfigured } from "./paths.js";
import { reembedPending, syncVault, type SyncStats } from "./sync.js";

/**
 * Keeps the derived Convex index in sync with the vault. Two triggers:
 *  - fs.watch (co-located fast path) — reacts to vault edits, debounced.
 *  - a periodic timer (portable safety net; also the path for a future
 *    remote/headless deploy where fs.watch isn't viable).
 * All work is incremental (hash-skips unchanged) and serialized so syncs never
 * overlap. Gated on WIKI_VAULT_PATH; a no-op when the wiki is disabled.
 */

const DEBOUNCE_MS = 2000;
const PERIODIC_MS = 30 * 60 * 1000;
/**
 * Boot is the worst moment to walk the whole vault: the embedding model
 * (~440MB), the Convex connection and every integration all initialise at
 * once, and reads lose that race — a measured 120 of 303 files failed on a
 * 1.5s delay, then read fine once the process settled. Nothing is lost now
 * that unreadable files are preserved rather than orphaned, but the work is
 * wasted, so let the process settle first.
 */
const STARTUP_DELAY_MS = 30_000;
/** Re-run after read failures, so a bad pass heals in seconds not 30 minutes. */
const READ_RETRY_DELAY_MS = 30_000;
const READ_RETRY_MAX = 3;

let started = false;
let pending: ReturnType<typeof setTimeout> | null = null;
let running = false;
let rerun = false;
let readRetries = 0;
/** In-flight sync, so a manual trigger joins it instead of racing it. */
let inFlight: Promise<SyncStats> | null = null;

function runId(): string {
  return `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The ONLY place `syncVault` is invoked. Two overlapping runs are actively
 * destructive: each ends by deleting every manifest row not stamped with its
 * own runId, so run A's orphan pass evicts everything run B just synced (and
 * vice versa), draining the index that wiki_read falls back to. Callers share
 * one in-flight run instead.
 */
function runSync(): Promise<SyncStats> {
  if (inFlight) return inFlight;
  inFlight = syncVault({ runId: runId(), embedInline: true }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync(reason: string): Promise<void> {
  if (running) {
    rerun = true; // a change arrived mid-sync; coalesce one more run after.
    return;
  }
  running = true;
  let retryReads = false;
  try {
    const stats = await runSync();
    if (
      stats.filesChanged ||
      stats.orphansDeleted ||
      stats.embedFailures ||
      stats.readFailures
    ) {
      console.log(`[wiki] sync (${reason})`, stats);
    }
    if (stats.embedFailures > 0) await reembedPending({ maxBatches: 50 });
    // A page iCloud refused to materialize will fail identically on every
    // retry, so the 30s retry loop just burns cycles forever while the index
    // silently rots — which is exactly what happened here (304/304 files
    // failing, 0 chunks upserted, for weeks). Say what is wrong and how to fix
    // it instead of quietly spinning.
    if (stats.datalessFailures > 0) {
      console.warn(
        `[wiki] ${stats.datalessFailures} page(s) are iCloud-evicted and could not be materialized. ` +
          `The index is INCOMPLETE. Fix: run \`find "$WIKI_VAULT_PATH" -name '*.md' -type f -exec brctl download {} \\;\`, ` +
          `turn off iCloud "Optimize Mac Storage", and ensure the launchd plist sets <key>MaterializeDatalessFiles</key><true/>.`,
      );
    }
    // Files we couldn't read are still in the vault and were deliberately left
    // in the manifest, so they're simply missing their latest content. Come
    // back for them shortly instead of waiting for the periodic sweep.
    if (stats.readFailures > 0 && readRetries < READ_RETRY_MAX) {
      readRetries++;
      retryReads = true;
    } else {
      readRetries = 0;
    }
  } catch (err) {
    console.warn("[wiki] sync failed:", err);
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      schedule("coalesced", 500);
    } else if (retryReads) {
      schedule("read-retry", READ_RETRY_DELAY_MS);
    }
  }
}

function schedule(reason: string, delay = DEBOUNCE_MS): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void doSync(reason);
  }, delay);
}

/** Start the wiki auto-sync (watch + periodic). Safe to call unconditionally. */
export function startWikiSync(): void {
  if (started || !wikiConfigured()) return;
  started = true;
  let root: string;
  try {
    root = vaultRoot();
  } catch {
    return;
  }
  // Initial reconcile on boot (covers edits made while the server was down,
  // and the first-ever backfill).
  schedule("startup", STARTUP_DELAY_MS);
  try {
    watch(root, { recursive: true }, (_event, filename) => {
      if (filename && String(filename).endsWith(".md")) schedule("fs-change");
    });
    console.log(`[wiki] watching ${root} for changes`);
  } catch (err) {
    console.warn("[wiki] fs.watch unavailable; relying on periodic sync:", err);
  }
  const timer = setInterval(() => schedule("periodic"), PERIODIC_MS);
  timer.unref?.();
}

/** Manual trigger for the HTTP route. Joins any in-flight sync. */
export async function runWikiSyncNow(): Promise<SyncStats> {
  return runSync();
}
