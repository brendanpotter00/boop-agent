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

let started = false;
let pending: ReturnType<typeof setTimeout> | null = null;
let running = false;
let rerun = false;
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
  } catch (err) {
    console.warn("[wiki] sync failed:", err);
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      schedule("coalesced", 500);
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
  schedule("startup", 1500);
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
