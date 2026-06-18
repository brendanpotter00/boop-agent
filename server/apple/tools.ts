import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { redactContactHandle, redactPhoneNumbers } from "../privacy.js";
import { getAppleSettings } from "../runtime-config.js";
import { appleBridgeRequest, readBridgeInfo } from "./client.js";
import { listLocalChats, readLocalMessages } from "./messages-local.js";
import { readLocalNote, searchLocalNotes } from "./notes-local.js";

const NAMESPACE = "apple";

const LOCAL_NOTE =
  "Read-only data that lives on the user's Mac. iMessage reads run from the local Mac server with Full Disk Access; Apple Notes reads run from the local Mac server with Notes Automation permission; Calendar and Reminders use the optional Apple bridge.";

const MESSAGE_TEXT_LIMIT = 500;

interface BridgeChat {
  id: number;
  identifier: string;
  displayName: string;
  isGroup: boolean;
  lastMessageAt: string | null;
  participants: string[];
}

interface BridgeMessage {
  id: number;
  chatId: number;
  chatName: string;
  sender: string;
  isFromMe: boolean;
  text: string;
  sentAt: string;
  hasAttachments: boolean;
}

interface BridgeEvent {
  id: string;
  calendar: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  status: string | null;
}

interface BridgeReminder {
  id: string;
  list: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  priority: number | null;
}

interface BridgeNoteSummary {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  snippet: string;
}

interface BridgeNote {
  id: string;
  name: string;
  folder: string;
  body: string;
}

function ok(text: string) {
  return runtimeText(text);
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return runtimeText(`[apple error] ${message}`, false);
}

async function wrap(fn: () => Promise<string>) {
  try {
    return ok(await fn());
  } catch (err) {
    return toolError(err);
  }
}

function formatChat(chat: BridgeChat): string {
  const participants = chat.participants.map(redactContactHandle).join(", ");
  const name = redactContactHandle(chat.displayName?.trim() || participants || chat.identifier);
  const identifier = redactContactHandle(chat.identifier);
  return `#${chat.id} ${name} (${identifier}) — ${chat.participants.length} participants — last message ${chat.lastMessageAt ?? "unknown"}`;
}

function formatMessage(message: BridgeMessage): string {
  let text = redactPhoneNumbers(message.text?.trim() ?? "");
  if (text.length > MESSAGE_TEXT_LIMIT) text = `${text.slice(0, MESSAGE_TEXT_LIMIT)}…`;
  if (!text && message.hasAttachments) text = "(attachment)";
  return `[${message.sentAt}] ${redactContactHandle(message.sender)}: ${text}`;
}

function formatEvent(event: BridgeEvent): string {
  const when = event.allDay
    ? `${event.startsAt} → ${event.endsAt} (all day)`
    : `${event.startsAt} → ${event.endsAt}`;
  const location = event.location ? ` @ ${event.location}` : "";
  return `[${event.calendar}] ${event.title} — ${when}${location}`;
}

function formatReminder(reminder: BridgeReminder): string {
  const due = reminder.dueAt ? `due ${reminder.dueAt}` : "no due date";
  const done = reminder.completed ? " — completed" : "";
  return `[${reminder.list}] ${reminder.title} — ${due}${done}`;
}

function formatNoteSummary(note: BridgeNoteSummary): string {
  const modified = note.modifiedAt ? ` — modified ${note.modifiedAt}` : "";
  const name = redactPhoneNumbers(note.name);
  const folder = redactPhoneNumbers(note.folder);
  const snippet = redactPhoneNumbers(note.snippet);
  return `${name} (${note.id}) — folder ${folder}${modified}\n  ${snippet}`;
}

async function messagesEnabled(): Promise<boolean> {
  return (await getAppleSettings()).messagesEnabled;
}

async function notesEnabled(): Promise<boolean> {
  return (await getAppleSettings()).notesEnabled;
}

async function bridgeAvailable(): Promise<boolean> {
  return Boolean(await readBridgeInfo());
}

async function listChats(limit: number | undefined): Promise<BridgeChat[]> {
  if (process.platform === "darwin") {
    try {
      return await listLocalChats(limit);
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { chats } = await appleBridgeRequest<{ chats: BridgeChat[] }>("/messages/chats", {
    limit,
  });
  return chats;
}

async function listMessages(filters: {
  chat_id?: number;
  participant?: string;
  query?: string;
  since_hours?: number;
  limit?: number;
}): Promise<BridgeMessage[]> {
  if (process.platform === "darwin") {
    try {
      return await readLocalMessages({
        chatId: filters.chat_id,
        participant: filters.participant,
        query: filters.query,
        sinceHours: filters.since_hours,
        limit: filters.limit,
      });
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { messages } = await appleBridgeRequest<{ messages: BridgeMessage[] }>(
    "/messages/list",
    {
      chatId: filters.chat_id,
      participant: filters.participant,
      query: filters.query,
      sinceHours: filters.since_hours,
      limit: filters.limit,
    },
  );
  return messages;
}

async function listNotes(filters: { query: string; limit?: number }): Promise<BridgeNoteSummary[]> {
  if (process.platform === "darwin") {
    try {
      return await searchLocalNotes(filters.query, filters.limit);
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { notes } = await appleBridgeRequest<{ notes: BridgeNoteSummary[] }>(
    "/notes/search",
    { query: filters.query, limit: filters.limit },
  );
  return notes;
}

async function getNote(noteId: string): Promise<BridgeNote> {
  if (process.platform === "darwin") {
    try {
      return await readLocalNote(noteId);
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { note } = await appleBridgeRequest<{ note: BridgeNote }>("/notes/get", {
    id: noteId,
  });
  return note;
}

export function createAppleTools(namespace = NAMESPACE): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "apple_list_chats",
      `List the user's recent iMessage/SMS chats with their numeric chat ids. ${LOCAL_NOTE}`,
      {
        limit: z.number().optional().describe("Max chats to return (default 20)."),
      },
      async ({ limit }) =>
        wrap(async () => {
          if (!(await messagesEnabled())) {
            return "iMessage reads are disabled in Boop Connections. Turn on iMessage under Local Mac to use this tool.";
          }
          const chats = await listChats(limit);
          if (chats.length === 0) return "No chats found.";
          return chats.map(formatChat).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_read_messages",
      `Read the user's iMessage/SMS history, newest first, optionally filtered by chat, participant, text query, or recency. ${LOCAL_NOTE}`,
      {
        chat_id: z.number().optional().describe("Numeric chat id from apple_list_chats."),
        participant: z
          .string()
          .optional()
          .describe("Filter by a participant contact name, phone number, or email."),
        query: z.string().optional().describe("Filter to messages containing this text."),
        since_hours: z
          .number()
          .optional()
          .describe("Only messages from the last N hours."),
        limit: z.number().optional().describe("Max messages to return (default 50, max 200)."),
      },
      async ({ chat_id, participant, query, since_hours, limit }) =>
        wrap(async () => {
          if (!(await messagesEnabled())) {
            return "iMessage reads are disabled in Boop Connections. Turn on iMessage under Local Mac to use this tool.";
          }
          const messages = await listMessages({
            chat_id,
            participant,
            query,
            since_hours,
            limit,
          });
          if (messages.length === 0) return "No messages found.";
          return messages.map(formatMessage).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_calendar_events",
      `List the user's Apple Calendar events, defaulting to the next 7 days. ${LOCAL_NOTE}`,
      {
        from_date: z
          .string()
          .optional()
          .describe("Range start, ISO 8601 like 2026-06-12 or 2026-06-12T09:00:00Z. Defaults to now."),
        to_date: z
          .string()
          .optional()
          .describe("Range end, ISO 8601 like 2026-06-19 or 2026-06-19T17:00:00Z. Defaults to 7 days out."),
        calendar: z
          .string()
          .optional()
          .describe("Filter by calendar title (case-insensitive) or id."),
      },
      async ({ from_date, to_date, calendar }) =>
        wrap(async () => {
          const { events } = await appleBridgeRequest<{ events: BridgeEvent[] }>(
            "/calendar/events",
            { from: from_date, to: to_date, calendar },
          );
          if (events.length === 0) return "No calendar events found.";
          return events.map(formatEvent).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_list_reminders",
      `List the user's Apple Reminders, optionally filtered by list, completion state, or due window. ${LOCAL_NOTE}`,
      {
        list: z.string().optional().describe("Filter by reminder list title or id."),
        include_completed: z
          .boolean()
          .optional()
          .describe("Include completed reminders (default false)."),
        due_within_days: z
          .number()
          .optional()
          .describe("Only reminders due within the next N days."),
      },
      async ({ list, include_completed, due_within_days }) =>
        wrap(async () => {
          const { reminders } = await appleBridgeRequest<{ reminders: BridgeReminder[] }>(
            "/reminders/list",
            {
              list,
              includeCompleted: include_completed,
              dueWithinDays: due_within_days,
            },
          );
          if (reminders.length === 0) return "No reminders found.";
          return reminders.map(formatReminder).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_search_notes",
      `Search the user's Apple Notes by text and return matching notes with snippets. ${LOCAL_NOTE}`,
      {
        query: z.string().describe("Text to search note titles and bodies for."),
        limit: z.number().optional().describe("Max notes to return (default 10)."),
      },
      async ({ query, limit }) =>
        wrap(async () => {
          if (!(await notesEnabled())) {
            return "Apple Notes reads are disabled in Boop Connections. Turn on Apple Notes under Local Mac to use this tool.";
          }
          const notes = await listNotes({ query, limit });
          if (notes.length === 0) return "No notes found.";
          return notes.map(formatNoteSummary).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_read_note",
      `Read the full plaintext body of one Apple Note by id (from apple_search_notes). ${LOCAL_NOTE}`,
      {
        note_id: z.string().describe("Note id returned by apple_search_notes."),
      },
      async ({ note_id }) =>
        wrap(async () => {
          if (!(await notesEnabled())) {
            return "Apple Notes reads are disabled in Boop Connections. Turn on Apple Notes under Local Mac to use this tool.";
          }
          const note = await getNote(note_id);
          return `${redactPhoneNumbers(note.name)} (folder ${redactPhoneNumbers(note.folder)})\n\n${redactPhoneNumbers(note.body)}`;
        }),
    ),
  ];
}

export function createAppleMcp() {
  return createClaudeMcpServer(NAMESPACE, createAppleTools(NAMESPACE));
}
