import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OSASCRIPT_BIN = "/usr/bin/osascript";
const NOTES_TIMEOUT_MS = 15_000;
const NOTES_MAX_BUFFER = 5 * 1024 * 1024;
const NOTE_BODY_LIMIT = 40_000;

export const LOCAL_NOTES_UNSUPPORTED_MESSAGE =
  "Local Apple Notes reads are only available on macOS.";

export const LOCAL_NOTES_ACCESS_MESSAGE =
  "Boop needs macOS Automation permission to read Apple Notes. When prompted, allow the app running Boop to control Notes, or open System Settings -> Privacy & Security -> Automation and enable Notes for Codex/Terminal. Access is read-only.";

export type LocalNotesPermission = "granted" | "denied" | "notDetermined";

let cachedNotesPermission: LocalNotesPermission = "notDetermined";

interface RawNoteSummary {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  snippet: string;
}

interface RawNote {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  body: string;
}

export interface LocalNoteSummary {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  snippet: string;
}

export interface LocalNote {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  body: string;
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function capLimit(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input ?? NaN)) return fallback;
  return Math.max(1, Math.min(Math.trunc(input!), 50));
}

function normalizeNotesError(err: unknown): Error {
  const signal = typeof (err as { signal?: unknown })?.signal === "string"
    ? (err as { signal: string }).signal
    : "";
  const killed = Boolean((err as { killed?: unknown })?.killed);
  const stderr = typeof (err as { stderr?: unknown })?.stderr === "string"
    ? ((err as { stderr: string }).stderr.trim())
    : "";
  const text = stderr || (err instanceof Error ? err.message : String(err));
  if (
    text.includes("Not authorized to send Apple events") ||
    text.includes("not authorized to send Apple events") ||
    text.includes("Application isn") ||
    text.includes("-1743") ||
    text.includes("-1744") ||
    text.includes("User canceled") ||
    text.includes("Operation not permitted")
  ) {
    return new Error(LOCAL_NOTES_ACCESS_MESSAGE);
  }
  if (killed || signal === "SIGTERM" || text.includes("timed out") || text.includes("SIGTERM")) {
    return new Error("Apple Notes was too slow to return data before the read timeout. Try again with a smaller limit.");
  }
  if (text.includes("Apple Note was not found")) {
    return new Error("Apple Note was not found.");
  }
  if (text.includes("syntax error")) {
    return new Error("Local Apple Notes read failed: AppleScript syntax error.");
  }
  return new Error(`Local Apple Notes read failed: ${text}`);
}

function isPermissionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(LOCAL_NOTES_ACCESS_MESSAGE);
}

async function runNotesScript<T>(script: string, env: Record<string, string>): Promise<T> {
  if (!isMac()) throw new Error(LOCAL_NOTES_UNSUPPORTED_MESSAGE);
  if (!existsSync(OSASCRIPT_BIN)) {
    throw new Error("osascript is required to read Apple Notes, but /usr/bin/osascript was not found.");
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      OSASCRIPT_BIN,
      ["-e", script],
      {
        timeout: NOTES_TIMEOUT_MS,
        maxBuffer: NOTES_MAX_BUFFER,
        env: { ...process.env, ...env },
      },
    ));
  } catch (err) {
    throw normalizeNotesError(err);
  }

  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Apple Notes returned an empty response.");
  try {
    const parsed = JSON.parse(trimmed) as T;
    cachedNotesPermission = "granted";
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Apple Notes returned unreadable data: ${err.message}`);
    }
    throw err;
  }
}

export async function searchLocalNotes(query: string, limit?: number): Promise<LocalNoteSummary[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const rows = await runNotesScript<RawNoteSummary[]>(SEARCH_NOTES_SCRIPT, {
    BOOP_NOTES_QUERY: trimmed,
    BOOP_NOTES_LIMIT: String(capLimit(limit, 10)),
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    folder: row.folder,
    modifiedAt: row.modifiedAt,
    snippet: row.snippet,
  }));
}

export function getCachedLocalNotesAccess(): LocalNotesPermission {
  if (!isMac()) return "denied";
  return cachedNotesPermission;
}

export async function requestLocalNotesAccess(): Promise<LocalNotesPermission> {
  if (!isMac() || !existsSync(OSASCRIPT_BIN)) {
    cachedNotesPermission = "denied";
    return cachedNotesPermission;
  }
  try {
    await runNotesScript<{ ok: boolean }>(REQUEST_NOTES_ACCESS_SCRIPT, {});
    cachedNotesPermission = "granted";
  } catch (err) {
    cachedNotesPermission = isPermissionError(err)
      ? "denied"
      : cachedNotesPermission === "granted"
        ? "granted"
        : "notDetermined";
  }
  return cachedNotesPermission;
}

export async function readLocalNote(noteId: string): Promise<LocalNote> {
  const trimmed = noteId.trim();
  if (!trimmed) throw new Error("Apple Note id is required.");

  const note = await runNotesScript<RawNote>(READ_NOTE_SCRIPT, {
    BOOP_NOTES_ID: trimmed,
  });

  return {
    id: note.id,
    name: note.name,
    folder: note.folder,
    modifiedAt: note.modifiedAt,
    body: note.body.length > NOTE_BODY_LIMIT ? `${note.body.slice(0, NOTE_BODY_LIMIT)}\n[truncated]` : note.body,
  };
}

const APPLESCRIPT_HELPERS = String.raw`
on replaceText(findText, replaceText, sourceText)
  set AppleScript's text item delimiters to findText
  set textItems to every text item of sourceText
  set AppleScript's text item delimiters to replaceText
  set resultText to textItems as text
  set AppleScript's text item delimiters to ""
  return resultText
end replaceText

on jsonString(sourceValue)
  set sourceText to sourceValue as text
  set sourceText to my replaceText("\\", "\\\\", sourceText)
  set sourceText to my replaceText("\"", "\\\"", sourceText)
  set sourceText to my replaceText(return, "\\n", sourceText)
  set sourceText to my replaceText(linefeed, "\\n", sourceText)
  set sourceText to my replaceText(tab, "\\t", sourceText)
  return "\"" & sourceText & "\""
end jsonString

on jsonNullableString(sourceValue)
  if sourceValue is missing value then return "null"
  if sourceValue is "" then return "null"
  return my jsonString(sourceValue)
end jsonNullableString

on joinJson(jsonItems)
  set AppleScript's text item delimiters to ","
  set resultText to jsonItems as text
  set AppleScript's text item delimiters to ""
  return resultText
end joinJson

on noteFolderName(aNote)
  try
    tell application "Notes"
      return name of container of aNote as text
    end tell
  on error
    return "Notes"
  end try
end noteFolderName

on noteModifiedAt(aNote)
  try
    tell application "Notes"
      return modification date of aNote as text
    end tell
  on error
    return ""
  end try
end noteModifiedAt

on noteSnippet(bodyText)
  set cleanText to bodyText as text
  if (length of cleanText) > 240 then
    return (text 1 thru 240 of cleanText) & "..."
  end if
  return cleanText
end noteSnippet
`;

const REQUEST_NOTES_ACCESS_SCRIPT = String.raw`
tell application "Notes"
  set noteCount to count of notes
end tell
return "{\"ok\":true}"
`;

const SEARCH_NOTES_SCRIPT = `${APPLESCRIPT_HELPERS}
set queryText to system attribute "BOOP_NOTES_QUERY"
set maxItemsText to system attribute "BOOP_NOTES_LIMIT"
set maxItems to maxItemsText as integer
set outputRows to {}

tell application "Notes"
  set matchedNotes to every note whose name contains queryText or plaintext contains queryText
  set totalMatches to count of matchedNotes
  if totalMatches > maxItems then
    set totalMatches to maxItems
  end if
  repeat with i from 1 to totalMatches
    set aNote to item i of matchedNotes
    set noteBody to plaintext of aNote as text
    set rowJson to "{" & ¬
      "\\"id\\":" & my jsonString(id of aNote) & "," & ¬
      "\\"name\\":" & my jsonString(name of aNote) & "," & ¬
      "\\"folder\\":" & my jsonString(my noteFolderName(aNote)) & "," & ¬
      "\\"modifiedAt\\":" & my jsonNullableString(my noteModifiedAt(aNote)) & "," & ¬
      "\\"snippet\\":" & my jsonString(my noteSnippet(noteBody)) & ¬
      "}"
    set end of outputRows to rowJson
  end repeat
end tell

return "[" & my joinJson(outputRows) & "]"
`;

const READ_NOTE_SCRIPT = `${APPLESCRIPT_HELPERS}
set targetId to system attribute "BOOP_NOTES_ID"

tell application "Notes"
  set matchedNotes to every note whose id is targetId
  if (count of matchedNotes) is 0 then
    error "Apple Note was not found."
  end if
  set aNote to item 1 of matchedNotes
  set rowJson to "{" & ¬
    "\\"id\\":" & my jsonString(id of aNote) & "," & ¬
    "\\"name\\":" & my jsonString(name of aNote) & "," & ¬
    "\\"folder\\":" & my jsonString(my noteFolderName(aNote)) & "," & ¬
    "\\"modifiedAt\\":" & my jsonNullableString(my noteModifiedAt(aNote)) & "," & ¬
    "\\"body\\":" & my jsonString(plaintext of aNote) & ¬
    "}"
end tell

return rowJson
`;
