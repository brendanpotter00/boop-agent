import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readVaultFile } from "./materialize.js";
import { safeResolveForWrite, wikiConfigured } from "./paths.js";

/**
 * Write operations against the Obsidian vault.
 *
 * The vault was read-only to boop by design ("the vault is the source of truth
 * and boop never mutates it"). That invariant is deliberately retired: the user
 * dictates notes over iMessage and wants them landed without opening a laptop.
 *
 * Every write goes through `safeResolveForWrite`, so containment (`..`,
 * absolute paths, symlink escapes, non-`.md`) and the schema-layer denylist are
 * enforced in one place rather than per tool.
 *
 * Reads here go through `readVaultFile` because an iCloud-evicted page must be
 * materialized *before* a read-modify-write — otherwise edit and append would
 * either fail or, far worse, silently write a modified copy of an empty string
 * over a real page.
 *
 * There is no undo. The vault is not version-controlled (user's explicit
 * choice), so `wikiAppend` is the safe default and `wikiWrite`'s overwrite path
 * is gated behind an explicit flag.
 */

const NOT_CONFIGURED = "wiki not configured — set WIKI_VAULT_PATH to your Obsidian vault root.";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create a new page, or overwrite an existing one when `overwrite` is set.
 *
 * Refusing to clobber by default is the whole point: an agent that mistakes
 * "add my notes" for "replace the page" would otherwise destroy a synthesis
 * page with no way back.
 */
export async function wikiWrite(opts: {
  path: string;
  content: string;
  overwrite?: boolean;
}): Promise<string> {
  if (!wikiConfigured()) return NOT_CONFIGURED;
  let abs: string;
  try {
    abs = safeResolveForWrite(opts.path);
  } catch (err) {
    return `Cannot write "${opts.path}": ${describe(err)}`;
  }

  let existed = false;
  try {
    await readVaultFile(abs);
    existed = true;
  } catch {
    existed = false;
  }
  if (existed && !opts.overwrite) {
    return `${opts.path} already exists. Use wiki_append to add to it, wiki_edit to change part of it, or pass overwrite:true to replace it wholesale.`;
  }

  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, opts.content, "utf8");
  } catch (err) {
    return `Failed to write ${opts.path}: ${describe(err)}`;
  }
  const bytes = Buffer.byteLength(opts.content, "utf8");
  return `${existed ? "Overwrote" : "Created"} ${opts.path} (${bytes} bytes).`;
}

/**
 * Append to the end of an existing page, normalising the seam to exactly one
 * blank line so sections don't run together or drift apart over many appends.
 */
export async function wikiAppend(opts: { path: string; content: string }): Promise<string> {
  if (!wikiConfigured()) return NOT_CONFIGURED;
  let abs: string;
  try {
    abs = safeResolveForWrite(opts.path);
  } catch (err) {
    return `Cannot write "${opts.path}": ${describe(err)}`;
  }

  let existing: string;
  try {
    existing = await readVaultFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return `Page not found: ${opts.path}. Use wiki_write to create it.`;
    }
    return `Could not read ${opts.path} to append to it: ${describe(err)}`;
  }

  const next = `${existing.replace(/\s*$/, "")}\n\n${opts.content.replace(/^\s*\n/, "")}\n`;
  try {
    await writeFile(abs, next, "utf8");
  } catch (err) {
    return `Failed to append to ${opts.path}: ${describe(err)}`;
  }
  return `Appended ${Buffer.byteLength(opts.content, "utf8")} bytes to ${opts.path}.`;
}

/**
 * Exact string replacement, requiring `oldText` to appear exactly once.
 *
 * The uniqueness requirement is a safety feature, not an ergonomic accident: a
 * replace-all against markdown boilerplate ("## Status", "---") would silently
 * corrupt a page in several places at once, and with no version control that is
 * unrecoverable. Ambiguity is reported so the caller can add context and retry.
 */
export async function wikiEdit(opts: {
  path: string;
  oldText: string;
  newText: string;
}): Promise<string> {
  if (!wikiConfigured()) return NOT_CONFIGURED;
  if (!opts.oldText) return "oldText must not be empty — use wiki_append to add new content.";
  let abs: string;
  try {
    abs = safeResolveForWrite(opts.path);
  } catch (err) {
    return `Cannot write "${opts.path}": ${describe(err)}`;
  }

  let existing: string;
  try {
    existing = await readVaultFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return `Page not found: ${opts.path}. Use wiki_write to create it.`;
    }
    return `Could not read ${opts.path} to edit it: ${describe(err)}`;
  }

  const first = existing.indexOf(opts.oldText);
  if (first === -1) {
    return `oldText not found in ${opts.path}. Read the page with wiki_read and match its exact text (including indentation).`;
  }
  if (existing.indexOf(opts.oldText, first + opts.oldText.length) !== -1) {
    const count = existing.split(opts.oldText).length - 1;
    return `oldText appears ${count} times in ${opts.path} — refusing to edit ambiguously. Include more surrounding context so it matches exactly once.`;
  }

  const next =
    existing.slice(0, first) + opts.newText + existing.slice(first + opts.oldText.length);
  try {
    await writeFile(abs, next, "utf8");
  } catch (err) {
    return `Failed to edit ${opts.path}: ${describe(err)}`;
  }
  const delta = Buffer.byteLength(next, "utf8") - Buffer.byteLength(existing, "utf8");
  return `Edited ${opts.path} (${delta >= 0 ? "+" : ""}${delta} bytes).`;
}
