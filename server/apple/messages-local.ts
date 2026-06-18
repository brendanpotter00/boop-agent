import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizePhoneDigits, resolveLocalContactHandles } from "./contacts-local.js";

const execFileAsync = promisify(execFile);
const SQLITE_BIN = "/usr/bin/sqlite3";
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const SQLITE_TIMEOUT_MS = 10_000;
const SQLITE_MAX_BUFFER = 10 * 1024 * 1024;

export const LOCAL_MESSAGES_UNSUPPORTED_MESSAGE =
  "Local iMessage reads are only available on macOS.";

export const LOCAL_MESSAGES_FULL_DISK_ACCESS_MESSAGE =
  "Boop needs Full Disk Access for the terminal app running the server to read Messages. Open System Settings → Privacy & Security → Full Disk Access, add your terminal or Codex app, then restart npm run dev.";

export type LocalMessagesPermission = "granted" | "denied" | "notDetermined";

export interface LocalChat {
  id: number;
  identifier: string;
  displayName: string;
  isGroup: boolean;
  lastMessageAt: string | null;
  participants: string[];
}

export interface LocalMessage {
  id: number;
  chatId: number;
  chatName: string;
  sender: string;
  isFromMe: boolean;
  text: string;
  sentAt: string;
  hasAttachments: boolean;
}

export interface LocalMessageFilters {
  chatId?: number;
  participant?: string;
  query?: string;
  sinceHours?: number;
  limit?: number;
}

interface RawChatRow {
  id: number;
  identifier: string;
  displayName: string;
  isGroup: number;
  lastDate: number | null;
  participantsJson: string | null;
}

interface RawMessageRow {
  id: number;
  chatId: number;
  displayName: string;
  chatGuid: string;
  handle: string;
  isFromMe: number;
  text: string | null;
  attributedBodyHex: string | null;
  date: number | null;
  hasAttachments: number;
}

function chatDbPath(): string {
  return join(homedir(), "Library", "Messages", "chat.db");
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function capLimit(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input ?? NaN)) return fallback;
  return Math.max(1, Math.min(Math.trunc(input!), 200));
}

function sqlInteger(input: number): string {
  if (!Number.isFinite(input)) throw new Error("Expected a finite number.");
  return String(Math.trunc(input));
}

function sqlLiteral(input: string): string {
  return `'${input.replace(/'/g, "''")}'`;
}

function escapeLike(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function normalizeSqliteError(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err);
  if (
    text.includes("unable to open database file") ||
    text.includes("authorization denied") ||
    text.includes("Operation not permitted") ||
    text.includes("permission denied")
  ) {
    return new Error(LOCAL_MESSAGES_FULL_DISK_ACCESS_MESSAGE);
  }
  return new Error(`Local Messages SQLite read failed: ${text}`);
}

async function runSql<T>(sql: string): Promise<T[]> {
  if (!isMac()) throw new Error(LOCAL_MESSAGES_UNSUPPORTED_MESSAGE);
  if (!existsSync(chatDbPath())) throw new Error(LOCAL_MESSAGES_FULL_DISK_ACCESS_MESSAGE);
  if (!existsSync(SQLITE_BIN)) {
    throw new Error("sqlite3 is required to read local Messages, but /usr/bin/sqlite3 was not found.");
  }

  try {
    const { stdout } = await execFileAsync(
      SQLITE_BIN,
      ["-readonly", "-json", chatDbPath(), sql],
      { timeout: SQLITE_TIMEOUT_MS, maxBuffer: SQLITE_MAX_BUFFER },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    throw normalizeSqliteError(err);
  }
}

export async function probeLocalMessagesAccess(): Promise<LocalMessagesPermission> {
  if (!isMac()) return "denied";
  try {
    await runSql<{ ok: number }>("SELECT count(*) AS ok FROM sqlite_master LIMIT 1");
    return "granted";
  } catch {
    return "denied";
  }
}

export async function listLocalChats(limit?: number): Promise<LocalChat[]> {
  const cappedLimit = capLimit(limit, 20);
  const rows = await runSql<RawChatRow>(`
    SELECT
      c.ROWID AS id,
      c.guid AS identifier,
      COALESCE(c.display_name, '') AS displayName,
      CASE WHEN COALESCE(c.style, 0) = 43 THEN 1 ELSE 0 END AS isGroup,
      MAX(m.date) AS lastDate,
      COALESCE((
        SELECT json_group_array(handle)
        FROM (
          SELECT h.id AS handle
          FROM chat_handle_join chj
          JOIN handle h ON h.ROWID = chj.handle_id
          WHERE chj.chat_id = c.ROWID
          ORDER BY h.ROWID
        )
      ), '[]') AS participantsJson
    FROM chat c
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    LEFT JOIN message m ON m.ROWID = cmj.message_id
    GROUP BY c.ROWID
    ORDER BY (lastDate IS NULL) ASC, lastDate DESC
    LIMIT ${sqlInteger(cappedLimit)}
  `);

  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    displayName: row.displayName,
    isGroup: row.isGroup === 1,
    lastMessageAt: row.lastDate ? dateFromAppleValue(row.lastDate) : null,
    participants: parseParticipants(row.participantsJson),
  }));
}

export async function readLocalMessages(filters: LocalMessageFilters = {}): Promise<LocalMessage[]> {
  const cappedLimit = capLimit(filters.limit, 50);
  const where = ["COALESCE(m.associated_message_type, 0) = 0"];

  if (filters.chatId !== undefined) {
    where.push(`cmj.chat_id = ${sqlInteger(filters.chatId)}`);
  }
  if (filters.participant?.trim()) {
    where.push(await participantWhereClause(filters.participant.trim()));
  }
  if (filters.query?.trim()) {
    const pattern = sqlLiteral(`%${escapeLike(filters.query.trim())}%`);
    where.push(`m.text LIKE ${pattern} ESCAPE '\\'`);
  }
  if (filters.sinceHours !== undefined && filters.sinceHours > 0) {
    const cutoff = Date.now() - filters.sinceHours * 60 * 60 * 1000;
    where.push(`m.date >= ${sqlInteger(appleNanoseconds(cutoff))}`);
  }

  const rows = await runSql<RawMessageRow>(`
    SELECT
      m.ROWID AS id,
      cmj.chat_id AS chatId,
      COALESCE(c.display_name, '') AS displayName,
      c.guid AS chatGuid,
      COALESCE(h.id, '') AS handle,
      COALESCE(m.is_from_me, 0) AS isFromMe,
      m.text AS text,
      hex(m.attributedBody) AS attributedBodyHex,
      m.date AS date,
      COALESCE(m.cache_has_attachments, 0) AS hasAttachments
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE ${where.join("\n      AND ")}
    ORDER BY m.date DESC
    LIMIT ${sqlInteger(cappedLimit)}
  `);

  return rows.map((row) => {
    const hasAttachments = row.hasAttachments !== 0;
    return {
      id: row.id,
      chatId: row.chatId,
      chatName: row.displayName || row.chatGuid,
      sender: row.isFromMe !== 0 ? "me" : row.handle || "unknown",
      isFromMe: row.isFromMe !== 0,
      text: resolveMessageText(row.text, row.attributedBodyHex, hasAttachments),
      sentAt: row.date ? dateFromAppleValue(row.date) : "",
      hasAttachments,
    };
  });
}

async function participantWhereClause(participant: string): Promise<string> {
  const pattern = sqlLiteral(`%${escapeLike(participant)}%`);
  const resolvedHandles = shouldResolveLocalContactHandles(participant)
    ? (await resolveLocalContactHandles(participant)).handles
    : [];
  const handles = uniqueStrings(resolvedHandles.map((handle) => handle.trim()).filter(Boolean)).slice(0, 50);
  const phoneTerms = uniqueStrings(
    handles
      .map(normalizePhoneDigits)
      .filter((digits) => digits.length >= 7)
      .map((digits) => (digits.length > 10 ? digits.slice(-10) : digits)),
  ).slice(0, 25);

  const senderCondition = participantHandleCondition("h", pattern, handles, phoneTerms);
  const chatParticipantCondition = participantHandleCondition("ph", pattern, handles, phoneTerms);

  return `(
      ${senderCondition}
      OR c.display_name LIKE ${pattern} ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM chat_handle_join pchj
        JOIN handle ph ON ph.ROWID = pchj.handle_id
        WHERE pchj.chat_id = c.ROWID
          AND ${chatParticipantCondition}
      )
    )`;
}

function shouldResolveLocalContactHandles(participant: string): boolean {
  return !participant.includes("@") && normalizePhoneDigits(participant).length < 7;
}

function participantHandleCondition(
  alias: string,
  pattern: string,
  handles: string[],
  phoneTerms: string[],
): string {
  const conditions = [`${alias}.id LIKE ${pattern} ESCAPE '\\'`];
  for (const handle of handles) {
    conditions.push(`LOWER(${alias}.id) = LOWER(${sqlLiteral(handle)})`);
  }

  if (phoneTerms.length > 0) {
    const normalizedHandle = normalizedPhoneSql(`${alias}.id`);
    for (const digits of phoneTerms) {
      const literal = sqlLiteral(digits);
      conditions.push(`${normalizedHandle} = ${literal}`);
      conditions.push(`${normalizedHandle} LIKE ${sqlLiteral(`%${digits}`)}`);
    }
  }

  return `(${conditions.join(" OR ")})`;
}

function normalizedPhoneSql(expression: string): string {
  return ["+", " ", "-", "(", ")", ".", "\u00a0"].reduce(
    (acc, character) => `REPLACE(${acc}, ${sqlLiteral(character)}, '')`,
    expression,
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseParticipants(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function dateFromAppleValue(value: number): string {
  const seconds = value > 1_000_000_000_000 ? value / 1_000_000_000 : value;
  return new Date(APPLE_EPOCH_MS + seconds * 1000).toISOString();
}

function appleNanoseconds(epochMs: number): number {
  return Math.trunc((epochMs - APPLE_EPOCH_MS) * 1_000_000);
}

function resolveMessageText(
  text: string | null,
  attributedBodyHex: string | null,
  hasAttachments: boolean,
): string {
  const direct = text?.trim();
  if (direct) return direct;
  const decoded = decodeAttributedBody(attributedBodyHex);
  if (decoded) return decoded;
  if (hasAttachments) return "(attachment)";
  return "";
}

function decodeAttributedBody(hex: string | null): string | null {
  if (!hex) return null;
  const bytes = hexToBytes(hex);
  if (!bytes.length) return null;
  return scanForNSString(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!clean || clean.length % 2 !== 0) return new Uint8Array();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const value = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) return new Uint8Array();
    bytes[i] = value;
  }
  return bytes;
}

function scanForNSString(bytes: Uint8Array): string | null {
  const marker = new TextEncoder().encode("NSString");
  if (bytes.length <= marker.length) return null;

  let afterMarker = -1;
  outer: for (let start = 0; start <= bytes.length - marker.length; start += 1) {
    for (let offset = 0; offset < marker.length; offset += 1) {
      if (bytes[start + offset] !== marker[offset]) continue outer;
    }
    afterMarker = start + marker.length;
    break;
  }
  if (afterMarker < 0) return null;

  let index = afterMarker;
  const preambleLimit = Math.min(bytes.length, afterMarker + 8);
  while (index < preambleLimit && bytes[index] !== 0x2b) index += 1;
  if (index >= preambleLimit || bytes[index] !== 0x2b) return null;
  index += 1;
  if (index >= bytes.length) return null;

  let length = 0;
  const lengthTag = bytes[index];
  if (lengthTag === 0x81) {
    if (index + 2 >= bytes.length) return null;
    length = bytes[index + 1] | (bytes[index + 2] << 8);
    index += 3;
  } else if (lengthTag === 0x82) {
    if (index + 4 >= bytes.length) return null;
    length =
      bytes[index + 1] |
      (bytes[index + 2] << 8) |
      (bytes[index + 3] << 16) |
      (bytes[index + 4] << 24);
    index += 5;
  } else if (lengthTag < 0x80) {
    length = lengthTag;
    index += 1;
  } else {
    return null;
  }

  if (length <= 0 || index + length > bytes.length) return null;
  return new TextDecoder().decode(bytes.slice(index, index + length));
}
