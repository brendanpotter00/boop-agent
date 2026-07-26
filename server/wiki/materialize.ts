import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Reads vault files through iCloud Drive's "dataless" placeholder mechanism.
 *
 * When "Optimize Mac Storage" is on, iCloud evicts file *contents* and leaves a
 * placeholder: metadata and `st_size` stay correct, `st_blocks` drops to 0, and
 * the file is flagged `dataless`. The bytes only arrive when a process
 * *materializes* the file by touching it.
 *
 * A process whose io policy is `IOPOL_MATERIALIZE_DATALESS_FILES_OFF` is not
 * permitted to trigger that download, and the kernel fails the read with
 * `EDEADLK` — whose strerror text is the deeply misleading **"Resource deadlock
 * avoided"**. launchd applies that restrictive policy to background jobs unless
 * the plist opts in via `MaterializeDatalessFiles`, and the policy is inherited
 * by every child process — so both this server and the `claude` CLI it spawns
 * were affected identically.
 *
 * Worse, libuv has no darwin mapping for EDEADLK, so Node surfaces it as
 * `Unknown system error -11` with `code: "UNKNOWN"` instead of a named code.
 * Between that and the "deadlock" wording, this presented for weeks as a *file
 * lock* held by Obsidian or a sync agent. It never was one: `lsof` on the vault
 * was empty the whole time. The symptom is an eviction, not a lock.
 *
 * `brctl download` asks the iCloud daemon over XPC to fetch the file rather than
 * reading it directly, so it succeeds regardless of the caller's materialization
 * policy. That makes it a reliable self-heal even when the launchd policy is
 * wrong — belt and braces alongside the plist fix.
 */

/** macOS `EDEADLK`. Node reports errno negated and unmapped (`code: "UNKNOWN"`). */
const EDEADLK_ERRNO = -11;

/** How many times to re-read after asking iCloud to download. */
const MATERIALIZE_RETRIES = 4;
const MATERIALIZE_BACKOFF_MS = 400;

/**
 * True when an fs error is the dataless-materialization refusal rather than a
 * genuine IO problem. Matching on `code` alone is not enough — "UNKNOWN" is
 * libuv's catch-all — so the errno is the real discriminator.
 */
export function isDatalessError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (!e) return false;
  return e.errno === EDEADLK_ERRNO || e.code === "EDEADLK";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask iCloud to bring a file's contents back to local disk. Returns false when
 * `brctl` is missing or errors (non-macOS, not an iCloud path, daemon down) so
 * callers can surface the original read error rather than this one.
 */
export async function materialize(absPath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync("/usr/bin/brctl", ["download", absPath], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * `readFile` that transparently materializes an evicted iCloud file first.
 *
 * `brctl download` only *queues* the fetch — it exits 0 before the bytes have
 * necessarily landed — so the read is retried with a short backoff rather than
 * assumed to succeed immediately. Any non-dataless error propagates untouched
 * so real problems (ENOENT, EACCES) still look like themselves to callers.
 */
export async function readVaultFile(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, "utf8");
  } catch (err) {
    if (!isDatalessError(err)) throw err;
    if (!(await materialize(absPath))) throw err;
    for (let attempt = 0; attempt < MATERIALIZE_RETRIES; attempt++) {
      await sleep(MATERIALIZE_BACKOFF_MS * (attempt + 1));
      try {
        return await readFile(absPath, "utf8");
      } catch (retryErr) {
        if (!isDatalessError(retryErr)) throw retryErr;
      }
    }
    throw err;
  }
}
