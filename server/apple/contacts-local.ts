import { execFile } from "node:child_process";
import { accessSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SQLITE_BIN = "/usr/bin/sqlite3";
const SQLITE_TIMEOUT_MS = 10_000;
const SQLITE_MAX_BUFFER = 5 * 1024 * 1024;
const CONTACT_MATCH_LIMIT = 50;

export const LOCAL_CONTACTS_FULL_DISK_ACCESS_MESSAGE =
  "Boop needs Full Disk Access to read Contacts for iMessage contact matching. Open System Settings -> Privacy & Security -> Full Disk Access, add Boop, then restart Boop from the Connection header.";

interface ContactCandidateRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  organization: string | null;
  name: string | null;
  normalizedName: string | null;
}

interface ContactHandleRow {
  kind: "email" | "phone" | "messaging";
  value: string | null;
}

export interface LocalContactResolution {
  query: string;
  contactsMatched: number;
  handles: string[];
}

function addressBookSourcesPath(): string {
  return join(homedir(), "Library", "Application Support", "AddressBook", "Sources");
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function sqlLiteral(input: string): string {
  return `'${input.replace(/'/g, "''")}'`;
}

function sqlInteger(input: number): string {
  if (!Number.isFinite(input)) throw new Error("Expected a finite number.");
  return String(Math.trunc(input));
}

function escapeLike(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

async function runSql<T>(dbPath: string, sql: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync(
      SQLITE_BIN,
      ["-readonly", "-json", dbPath, sql],
      { timeout: SQLITE_TIMEOUT_MS, maxBuffer: SQLITE_MAX_BUFFER },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    throw normalizeContactsError(err);
  }
}

function normalizeContactsError(err: unknown): Error {
  const signal = typeof (err as { signal?: unknown })?.signal === "string"
    ? (err as { signal: string }).signal
    : "";
  const killed = Boolean((err as { killed?: unknown })?.killed);
  const code = typeof (err as { code?: unknown })?.code === "string"
    ? (err as { code: string }).code
    : "";
  const stderr = typeof (err as { stderr?: unknown })?.stderr === "string"
    ? (err as { stderr: string }).stderr.trim()
    : "";
  const text = stderr || (err instanceof Error ? err.message : String(err));
  const lowerText = text.toLowerCase();
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    lowerText.includes("unable to open database file") ||
    lowerText.includes("authorization denied") ||
    lowerText.includes("operation not permitted") ||
    lowerText.includes("not authorized") ||
    lowerText.includes("permission denied")
  ) {
    return new Error(LOCAL_CONTACTS_FULL_DISK_ACCESS_MESSAGE);
  }
  if (killed || signal === "SIGTERM" || text.includes("timed out") || text.includes("SIGTERM")) {
    return new Error("Local Contacts read timed out while resolving iMessage contact handles.");
  }
  if (err instanceof SyntaxError || text.includes("Unexpected token")) {
    return new Error("Local Contacts returned unreadable data while resolving iMessage contact handles.");
  }
  return new Error("Local Contacts SQLite read failed while resolving iMessage contact handles.");
}

function findAddressBookDbs(): string[] {
  if (!isMac()) return [];
  const sourcesPath = addressBookSourcesPath();
  if (!pathExists(sourcesPath)) return [];

  const dbs: string[] = [];
  for (const entry of readDirectory(sourcesPath)) {
    if (!entry.isDirectory()) continue;
    const sourcePath = join(sourcesPath, entry.name);
    for (const sourceEntry of readDirectory(sourcePath)) {
      if (sourceEntry.isFile() && /^AddressBook-v\d+\.abcddb$/.test(sourceEntry.name)) {
        dbs.push(join(sourcePath, sourceEntry.name));
      }
    }
  }
  return dbs;
}

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") return false;
    throw normalizeContactsError(err);
  }
}

function readDirectory(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (err) {
    throw normalizeContactsError(err);
  }
}

function normalizeName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameParts(row: ContactCandidateRow): string[] {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(" ");
  return [
    row.firstName,
    row.lastName,
    row.nickname,
    row.organization,
    row.name,
    row.normalizedName,
    fullName,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function contactMatchScore(query: string, row: ContactCandidateRow): number {
  const normalizedQuery = normalizeName(query);
  if (!normalizedQuery || normalizedQuery.length < 2) return 0;

  let bestScore = 0;
  for (const part of nameParts(row)) {
    const normalized = normalizeName(part);
    if (!normalized) continue;
    if (normalized === normalizedQuery) bestScore = Math.max(bestScore, 3);
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token === normalizedQuery)) bestScore = Math.max(bestScore, 3);
    if (tokens.some((token) => token.startsWith(normalizedQuery))) bestScore = Math.max(bestScore, 2);
    if (normalized.startsWith(normalizedQuery)) bestScore = Math.max(bestScore, 1);
  }
  return bestScore;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function normalizePhoneDigits(input: string): string {
  return input.replace(/\D/g, "");
}

async function findContactCandidates(dbPath: string, query: string): Promise<ContactCandidateRow[]> {
  const like = sqlLiteral(`%${escapeLike(query)}%`);
  return runSql<ContactCandidateRow>(
    dbPath,
    `
      SELECT
        Z_PK AS id,
        ZFIRSTNAME AS firstName,
        ZLASTNAME AS lastName,
        ZNICKNAME AS nickname,
        ZORGANIZATION AS organization,
        ZNAME AS name,
        ZNAMENORMALIZED AS normalizedName
      FROM ZABCDRECORD
      WHERE
        COALESCE(ZFIRSTNAME, '') LIKE ${like} ESCAPE '\\'
        OR COALESCE(ZLASTNAME, '') LIKE ${like} ESCAPE '\\'
        OR COALESCE(ZNICKNAME, '') LIKE ${like} ESCAPE '\\'
        OR COALESCE(ZORGANIZATION, '') LIKE ${like} ESCAPE '\\'
        OR COALESCE(ZNAME, '') LIKE ${like} ESCAPE '\\'
        OR COALESCE(ZNAMENORMALIZED, '') LIKE ${like} ESCAPE '\\'
        OR TRIM(COALESCE(ZFIRSTNAME, '') || ' ' || COALESCE(ZLASTNAME, '')) LIKE ${like} ESCAPE '\\'
      LIMIT ${sqlInteger(CONTACT_MATCH_LIMIT)}
    `,
  );
}

async function readContactHandles(dbPath: string, contactIds: number[]): Promise<ContactHandleRow[]> {
  if (contactIds.length === 0) return [];
  const ids = contactIds.map(sqlInteger).join(", ");
  return runSql<ContactHandleRow>(
    dbPath,
    `
      SELECT 'phone' AS kind, ZFULLNUMBER AS value
      FROM ZABCDPHONENUMBER
      WHERE (ZOWNER IN (${ids}) OR Z22_OWNER IN (${ids}))
        AND COALESCE(ZFULLNUMBER, '') <> ''
      UNION ALL
      SELECT 'email' AS kind, COALESCE(ZADDRESSNORMALIZED, ZADDRESS) AS value
      FROM ZABCDEMAILADDRESS
      WHERE (ZOWNER IN (${ids}) OR Z22_OWNER IN (${ids}))
        AND COALESCE(ZADDRESSNORMALIZED, ZADDRESS, '') <> ''
      UNION ALL
      SELECT 'messaging' AS kind, ZADDRESS AS value
      FROM ZABCDMESSAGINGADDRESS
      WHERE (ZOWNER IN (${ids}) OR Z22_OWNER IN (${ids}))
        AND COALESCE(ZADDRESS, '') <> ''
    `,
  );
}

export async function resolveLocalContactHandles(query: string): Promise<LocalContactResolution> {
  const trimmed = query.trim();
  if (!isMac() || trimmed.length < 2 || !existsSync(SQLITE_BIN)) {
    return { query: trimmed, contactsMatched: 0, handles: [] };
  }

  const handles: string[] = [];
  let contactsMatched = 0;

  for (const dbPath of findAddressBookDbs()) {
    const candidates = await findContactCandidates(dbPath, trimmed);
    const scored = candidates
      .map((candidate) => ({ candidate, score: contactMatchScore(trimmed, candidate) }))
      .filter((entry) => entry.score > 0);
    const exactMatches = scored.filter((entry) => entry.score >= 3);
    const selected = exactMatches.length > 0 ? exactMatches : scored;
    const contactIds = unique(selected.map((entry) => entry.candidate.id));
    contactsMatched += contactIds.length;

    const rows = await readContactHandles(dbPath, contactIds);
    for (const row of rows) {
      const value = row.value?.trim();
      if (value) handles.push(value);
    }
  }

  return {
    query: trimmed,
    contactsMatched,
    handles: unique(handles),
  };
}
