import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SQLITE_BIN = "/usr/bin/sqlite3";
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const APPLE_EPOCH_SECONDS = 978_307_200; // seconds between 1970-01-01 and 2001-01-01
const SQLITE_TIMEOUT_MS = 10_000;
const SQLITE_MAX_BUFFER = 10 * 1024 * 1024;

export const LOCAL_VOICEMEMOS_UNSUPPORTED_MESSAGE =
  "Local Voice Memos reads are only available on macOS.";

// Voice Memos store their CloudRecordings.db inside the shared group container.
// Reading it needs the same Full Disk Access grant as iMessage's chat.db.
export const LOCAL_VOICEMEMOS_FULL_DISK_ACCESS_MESSAGE =
  "Boop needs Full Disk Access for the terminal app running the server to read Voice Memos. Open System Settings → Privacy & Security → Full Disk Access, add your terminal or Codex app, then restart npm run dev.";

export type LocalVoiceMemosPermission = "granted" | "denied" | "notDetermined";

export interface LocalVoiceMemo {
  id: string;
  title: string;
  createdAt: string | null;
  durationSeconds: number;
  folder: string | null;
  audioPath: string | null;
  hasAudio: boolean;
}

export interface LocalVoiceMemoFilters {
  query?: string;
  sinceDays?: number;
  folder?: string;
  limit?: number;
}

interface RawVoiceMemoRow {
  id: string | null;
  title: string | null;
  date: number | null;
  duration: number | null;
  path: string | null;
  folder: string | null;
}

function recordingsDir(): string {
  return join(
    homedir(),
    "Library",
    "Group Containers",
    "group.com.apple.VoiceMemos.shared",
    "Recordings",
  );
}

function voiceMemosDbPath(): string {
  return join(recordingsDir(), "CloudRecordings.db");
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
    return new Error(LOCAL_VOICEMEMOS_FULL_DISK_ACCESS_MESSAGE);
  }
  return new Error(`Local Voice Memos SQLite read failed: ${text}`);
}

async function runSql<T>(sql: string): Promise<T[]> {
  if (!isMac()) throw new Error(LOCAL_VOICEMEMOS_UNSUPPORTED_MESSAGE);
  if (!existsSync(voiceMemosDbPath())) {
    throw new Error(LOCAL_VOICEMEMOS_FULL_DISK_ACCESS_MESSAGE);
  }
  if (!existsSync(SQLITE_BIN)) {
    throw new Error(
      "sqlite3 is required to read local Voice Memos, but /usr/bin/sqlite3 was not found.",
    );
  }

  try {
    const { stdout } = await execFileAsync(
      SQLITE_BIN,
      ["-readonly", "-json", voiceMemosDbPath(), sql],
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

export async function probeLocalVoiceMemosAccess(): Promise<LocalVoiceMemosPermission> {
  if (!isMac()) return "denied";
  try {
    await runSql<{ ok: number }>("SELECT count(*) AS ok FROM sqlite_master LIMIT 1");
    return "granted";
  } catch {
    return "denied";
  }
}

// Title lives in ZENCRYPTEDTITLE (plaintext in practice); ZCUSTOMLABEL is a
// fallback label. ZFOLDER references ZFOLDER.Z_PK whose name is ZENCRYPTEDNAME.
const SELECT_COLUMNS = `
      r.ZUNIQUEID AS id,
      COALESCE(NULLIF(r.ZENCRYPTEDTITLE, ''), r.ZCUSTOMLABEL) AS title,
      r.ZDATE AS date,
      r.ZDURATION AS duration,
      r.ZPATH AS path,
      f.ZENCRYPTEDNAME AS folder
    FROM ZCLOUDRECORDING r
    LEFT JOIN ZFOLDER f ON f.Z_PK = r.ZFOLDER`;

export async function listLocalVoiceMemos(
  filters: LocalVoiceMemoFilters = {},
): Promise<LocalVoiceMemo[]> {
  const cappedLimit = capLimit(filters.limit, 20);
  const where: string[] = [];

  if (filters.query?.trim()) {
    const pattern = sqlLiteral(`%${escapeLike(filters.query.trim())}%`);
    where.push(`title LIKE ${pattern} ESCAPE '\\'`);
  }
  if (filters.folder?.trim()) {
    const pattern = sqlLiteral(`%${escapeLike(filters.folder.trim())}%`);
    where.push(`f.ZENCRYPTEDNAME LIKE ${pattern} ESCAPE '\\'`);
  }
  if (filters.sinceDays !== undefined && filters.sinceDays > 0) {
    const cutoffUnix = Date.now() / 1000 - filters.sinceDays * 24 * 60 * 60;
    const cutoffAppleSeconds = cutoffUnix - APPLE_EPOCH_SECONDS;
    where.push(`r.ZDATE >= ${sqlInteger(cutoffAppleSeconds)}`);
  }

  const whereClause = where.length ? `\n    WHERE ${where.join("\n      AND ")}` : "";

  const rows = await runSql<RawVoiceMemoRow>(`
    SELECT ${SELECT_COLUMNS}${whereClause}
    ORDER BY (r.ZDATE IS NULL) ASC, r.ZDATE DESC
    LIMIT ${sqlInteger(cappedLimit)}
  `);

  return rows.map(mapRow);
}

export async function readLocalVoiceMemo(id: string): Promise<LocalVoiceMemo> {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("A Voice Memo id is required.");
  const rows = await runSql<RawVoiceMemoRow>(`
    SELECT ${SELECT_COLUMNS}
    WHERE r.ZUNIQUEID = ${sqlLiteral(trimmed)}
    LIMIT 1
  `);
  if (rows.length === 0) {
    throw new Error(`No Voice Memo found with id ${trimmed}.`);
  }
  return mapRow(rows[0]);
}

function mapRow(row: RawVoiceMemoRow): LocalVoiceMemo {
  const audioPath = resolveAudioPath(row.path);
  return {
    id: row.id ?? "",
    title: row.title?.trim() || "Untitled recording",
    createdAt: row.date != null ? dateFromAppleValue(row.date) : null,
    durationSeconds: Math.round(row.duration ?? 0),
    folder: row.folder?.trim() || null,
    audioPath,
    hasAudio: audioPath !== null,
  };
}

// ZPATH is the audio filename relative to the Recordings dir. It can be empty
// (iCloud-evicted / still uploading), so only return a path that exists on disk.
function resolveAudioPath(path: string | null): string | null {
  const name = path?.trim();
  if (!name) return null;
  const abs = join(recordingsDir(), name);
  return existsSync(abs) ? abs : null;
}

export function audioFileMtime(absPath: string): number {
  try {
    return Math.trunc(statSync(absPath).mtimeMs);
  } catch {
    return 0;
  }
}

function dateFromAppleValue(value: number): string {
  // ZDATE is seconds since the Core Data / Apple epoch (2001-01-01).
  const seconds = value > 1_000_000_000_000 ? value / 1_000_000_000 : value;
  return new Date(APPLE_EPOCH_MS + seconds * 1000).toISOString();
}
