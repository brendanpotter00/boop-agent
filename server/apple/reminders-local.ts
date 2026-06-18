import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OSASCRIPT_BIN = "/usr/bin/osascript";
const REMINDERS_TIMEOUT_MS = 45_000;
const REMINDERS_MAX_BUFFER = 5 * 1024 * 1024;

export const LOCAL_REMINDERS_UNSUPPORTED_MESSAGE =
  "Local Apple Reminders reads are only available on macOS.";

export const LOCAL_REMINDERS_ACCESS_MESSAGE =
  "Boop needs macOS Automation permission to read Apple Reminders. When prompted, allow the app running Boop to control Reminders, or open System Settings -> Privacy & Security -> Automation and enable Reminders for Codex/Terminal. Access is read-only.";

export type LocalRemindersPermission = "granted" | "denied" | "notDetermined";

let cachedRemindersPermission: LocalRemindersPermission = "notDetermined";

interface RawReminder {
  id: string;
  list: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  priority: number | null;
}

export interface LocalReminder {
  id: string;
  list: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  priority: number | null;
}

export interface LocalReminderFilters {
  list?: string;
  includeCompleted?: boolean;
  dueWithinDays?: number;
  limit?: number;
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function capLimit(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input ?? NaN)) return fallback;
  return Math.max(1, Math.min(Math.trunc(input!), 20));
}

function capDays(input: number | undefined): number | null {
  if (!Number.isFinite(input ?? NaN)) return null;
  return Math.max(0, Math.min(Math.trunc(input!), 3650));
}

function normalizeRemindersError(err: unknown): Error {
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
    return new Error(LOCAL_REMINDERS_ACCESS_MESSAGE);
  }
  if (killed || signal === "SIGTERM" || text.includes("timed out") || text.includes("SIGTERM")) {
    return new Error("Apple Reminders was too slow to return data before the read timeout. Try again with a smaller limit.");
  }
  if (text.includes("syntax error")) {
    return new Error(`Local Apple Reminders read failed: AppleScript syntax error: ${text}`);
  }
  return new Error(`Local Apple Reminders read failed: ${text}`);
}

function isPermissionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(LOCAL_REMINDERS_ACCESS_MESSAGE);
}

async function runRemindersScript<T>(script: string, env: Record<string, string>): Promise<T> {
  if (!isMac()) throw new Error(LOCAL_REMINDERS_UNSUPPORTED_MESSAGE);
  if (!existsSync(OSASCRIPT_BIN)) {
    throw new Error("osascript is required to read Apple Reminders, but /usr/bin/osascript was not found.");
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      OSASCRIPT_BIN,
      ["-e", script],
      {
        timeout: REMINDERS_TIMEOUT_MS,
        maxBuffer: REMINDERS_MAX_BUFFER,
        env: { ...process.env, ...env },
      },
    ));
  } catch (err) {
    throw normalizeRemindersError(err);
  }

  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Apple Reminders returned an empty response.");
  try {
    const parsed = JSON.parse(trimmed) as T;
    cachedRemindersPermission = "granted";
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Apple Reminders returned unreadable data: ${err.message}`);
    }
    throw err;
  }
}

export async function listLocalReminders(filters: LocalReminderFilters = {}): Promise<LocalReminder[]> {
  const dueWithinDays = capDays(filters.dueWithinDays);
  const rows = await runRemindersScript<RawReminder[]>(LIST_REMINDERS_SCRIPT, {
    BOOP_REMINDERS_LIST: filters.list?.trim() ?? "",
    BOOP_REMINDERS_INCLUDE_COMPLETED: filters.includeCompleted ? "true" : "false",
    BOOP_REMINDERS_DUE_WITHIN_DAYS: dueWithinDays === null ? "" : String(dueWithinDays),
    BOOP_REMINDERS_LIMIT: String(capLimit(filters.limit, 1)),
  });

  return rows.map((row) => ({
    id: row.id,
    list: row.list,
    title: row.title,
    notes: row.notes,
    dueAt: row.dueAt,
    completed: row.completed,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    priority: row.priority,
  }));
}

export function getCachedLocalRemindersAccess(): LocalRemindersPermission {
  if (!isMac()) return "denied";
  return cachedRemindersPermission;
}

export async function requestLocalRemindersAccess(): Promise<LocalRemindersPermission> {
  if (!isMac() || !existsSync(OSASCRIPT_BIN)) {
    cachedRemindersPermission = "denied";
    return cachedRemindersPermission;
  }
  try {
    await runRemindersScript<{ ok: boolean }>(REQUEST_REMINDERS_ACCESS_SCRIPT, {});
    cachedRemindersPermission = "granted";
  } catch (err) {
    if (!isPermissionError(err)) throw err;
    cachedRemindersPermission = "denied";
  }
  return cachedRemindersPermission;
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

on pad2(numberValue)
  set textValue to numberValue as integer as text
  if (count of characters of textValue) is 1 then return "0" & textValue
  return textValue
end pad2

on localIsoDate(dateValue)
  if dateValue is missing value then return ""
  return ((year of dateValue as integer) as text) & "-" & my pad2(month of dateValue as integer) & "-" & my pad2(day of dateValue as integer) & "T" & my pad2(hours of dateValue as integer) & ":" & my pad2(minutes of dateValue as integer) & ":" & my pad2(seconds of dateValue as integer)
end localIsoDate

on jsonNullableDate(dateValue)
  if dateValue is missing value then return "null"
  return my jsonString(my localIsoDate(dateValue))
end jsonNullableDate

on joinJson(jsonItems)
  set AppleScript's text item delimiters to ","
  set resultText to jsonItems as text
  set AppleScript's text item delimiters to ""
  return resultText
end joinJson

`;

const REQUEST_REMINDERS_ACCESS_SCRIPT = String.raw`
tell application "Reminders"
  set reminderCount to count of reminders
end tell
return "{\"ok\":true}"
`;

const LIST_REMINDERS_SCRIPT = `${APPLESCRIPT_HELPERS}
set listFilter to system attribute "BOOP_REMINDERS_LIST"
set includeCompletedText to system attribute "BOOP_REMINDERS_INCLUDE_COMPLETED"
set dueWithinDaysText to system attribute "BOOP_REMINDERS_DUE_WITHIN_DAYS"
set maxItemsText to system attribute "BOOP_REMINDERS_LIMIT"
set includeCompleted to includeCompletedText is "true"
set maxItems to maxItemsText as integer
set outputRows to {}
set doneReading to false
set hasDueFilter to dueWithinDaysText is not ""
set dueLimitDate to missing value
if hasDueFilter then
  set dueLimitDate to (current date) + ((dueWithinDaysText as integer) * days)
end if

tell application "Reminders"
  set sourceLists to lists
  repeat with aList in sourceLists
    if doneReading then exit repeat
    set listName to name of aList as text
    set listId to id of aList as text
    if listFilter is "" or listName contains listFilter or listId is listFilter then
      set listReminders to reminders of aList
      repeat with aReminder in listReminders
        if doneReading then exit repeat
        set reminderProps to properties of aReminder
        set reminderCompleted to completed of reminderProps
        if includeCompleted or reminderCompleted is false then
          set dueDateValue to missing value
          try
            set dueDateValue to due date of reminderProps
          end try
          if dueDateValue is missing value then
            try
              set dueDateValue to allday due date of reminderProps
            end try
          end if
          if (hasDueFilter is false) or (dueDateValue is not missing value and dueDateValue is less than or equal to dueLimitDate) then
            set completedJson to "false"
            if reminderCompleted then set completedJson to "true"
            set reminderNotes to body of reminderProps
            set completedDateValue to completion date of reminderProps
            set createdDateValue to creation date of reminderProps
            set modifiedDateValue to modification date of reminderProps
            set rowJson to "{" & ¬
              "\\"id\\":" & my jsonString(id of reminderProps) & "," & ¬
              "\\"list\\":" & my jsonString(listName) & "," & ¬
              "\\"title\\":" & my jsonString(name of reminderProps) & "," & ¬
              "\\"notes\\":" & my jsonNullableString(reminderNotes) & "," & ¬
              "\\"dueAt\\":" & my jsonNullableDate(dueDateValue) & "," & ¬
              "\\"completed\\":" & completedJson & "," & ¬
              "\\"completedAt\\":" & my jsonNullableDate(completedDateValue) & "," & ¬
              "\\"createdAt\\":" & my jsonNullableDate(createdDateValue) & "," & ¬
              "\\"modifiedAt\\":" & my jsonNullableDate(modifiedDateValue) & "," & ¬
              "\\"priority\\":" & ((priority of reminderProps) as text) & ¬
              "}"
            set end of outputRows to rowJson
            if (count of outputRows) is greater than or equal to maxItems then set doneReading to true
          end if
        end if
      end repeat
    end if
  end repeat
end tell

return "[" & my joinJson(outputRows) & "]"
`;
