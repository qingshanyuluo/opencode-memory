import { CryptoHasher } from "bun";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { redactText, sanitizeValue } from "../bootstrap/redact.ts";
import type { TimelineChunk, TimelineEvent } from "./types.ts";

const SOURCE_PATHS: Record<string, string> = {
  main: resolve(homedir(), ".local/share/opencode/opencode.db"),
  dev: resolve(homedir(), ".local/share/opencode/opencode-dev.db"),
  local: resolve(homedir(), ".local/share/opencode/opencode-local.db"),
};

export function findSessionSource(sessionId: string): string | null {
  for (const [sourceId, path] of Object.entries(SOURCE_PATHS)) {
    const database = new Database(path, { readonly: true, strict: true });
    try {
      if (database.query<{ value: number }, [string]>("SELECT 1 AS value FROM session WHERE id = ?").get(sessionId)) {
        return sourceId;
      }
    } finally {
      database.close();
    }
  }
  return null;
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  part_data: string;
  message_data: string;
}

interface SessionRow {
  title: string;
  time_updated: number;
}

export interface SessionTimeline {
  title: string;
  sourceHash: string;
  events: TimelineEvent[];
  chunks: TimelineChunk[];
}

export interface SourceSessionMetadata {
  title: string;
  directory: string;
  timeUpdated: number;
  parentId: string | null;
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[TRUNCATED ${value.length - limit} chars]`;
}

function toolText(part: Record<string, unknown>): { text: string; tool: string; status: string } {
  const tool = text(part.tool) || "unknown";
  const state = part.state && typeof part.state === "object"
    ? part.state as Record<string, unknown>
    : {};
  const status = text(state.status) || "unknown";
  const sanitized = sanitizeValue(state.input);
  const fields = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
  let input = JSON.stringify(sanitized);
  if (tool === "bash") input = text(fields.command);
  else if (["read", "write", "edit"].includes(tool)) {
    input = JSON.stringify({ filePath: fields.filePath, offset: fields.offset, limit: fields.limit });
  } else if (tool === "apply_patch") input = "patch applied";
  else if (["grep", "glob"].includes(tool)) {
    input = JSON.stringify({ pattern: fields.pattern, path: fields.path, include: fields.include });
  } else if (tool === "webfetch") input = JSON.stringify({ url: fields.url });
  else if (tool === "task") input = JSON.stringify({ description: fields.description, prompt: truncate(text(fields.prompt), 800) });
  const result = status === "error" ? text(state.error) : text(state.output);
  return {
    tool,
    status,
    text: redactText(`tool=${tool} status=${status}\ninput=${truncate(input, 2_000)}\nresult=${truncate(result, status === "error" ? 2_000 : 900)}`),
  };
}

function renderEvent(event: TimelineEvent): string {
  const label = event.role === "tool" ? `TOOL ${event.tool}/${event.toolStatus}` : event.role.toUpperCase();
  return `<event part_id="${event.partId}" message_id="${event.messageId}" role="${label}">\n${event.text}\n</event>`;
}

export function renderTimelineEvents(events: TimelineEvent[]): string {
  return events.map(renderEvent).join("\n\n");
}

function compactTurn(events: TimelineEvent[]): TimelineEvent[] {
  const selected: TimelineEvent[] = [];
  let reasoningChars = 0;
  let assistantChars = 0;
  let routineTools = 0;
  const routine = new Set(["read", "grep", "glob"]);

  for (const event of events) {
    if (event.role === "user") {
      selected.push({ ...event, text: truncate(event.text, 5_000) });
    } else if (event.role === "reasoning" && reasoningChars < 6_000) {
      const value = truncate(event.text, Math.min(2_500, 6_000 - reasoningChars));
      reasoningChars += value.length;
      selected.push({ ...event, text: value });
    } else if (event.role === "assistant" && assistantChars < 12_000) {
      const value = truncate(event.text, Math.min(4_000, 12_000 - assistantChars));
      assistantChars += value.length;
      selected.push({ ...event, text: value });
    } else if (event.role === "tool") {
      const isError = event.toolStatus === "error";
      const isRoutine = routine.has(event.tool ?? "");
      if (isError || !isRoutine || routineTools < 6) {
        selected.push(event);
        if (isRoutine) routineTools += 1;
      }
    }
  }
  return selected;
}

function chunkEvents(events: TimelineEvent[], maxChars: number): TimelineChunk[] {
  const turns: TimelineEvent[][] = [];
  let turn: TimelineEvent[] = [];
  for (const event of events) {
    if (event.role === "user" && turn.length > 0) {
      turns.push(compactTurn(turn));
      turn = [];
    }
    turn.push(event);
  }
  if (turn.length > 0) turns.push(compactTurn(turn));

  const chunks: TimelineChunk[] = [];
  let current: TimelineEvent[] = [];
  let size = 0;

  for (const eventsInTurn of turns) {
    const rendered = eventsInTurn.map(renderEvent).join("\n\n");
    if (current.length > 0 && size + rendered.length > maxChars) {
      chunks.push({ index: chunks.length, events: current, text: renderTimelineEvents(current) });
      current = [];
      size = 0;
    }
    current.push(...eventsInTurn);
    size += rendered.length;
  }
  if (current.length > 0) {
    chunks.push({ index: chunks.length, events: current, text: renderTimelineEvents(current) });
  }
  return chunks;
}

export function readSessionTimeline(sourceId: string, sessionId: string, maxChunkChars = 50_000): SessionTimeline {
  const path = SOURCE_PATHS[sourceId];
  if (!path) throw new Error(`unknown source: ${sourceId}`);
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const session = database.query<SessionRow, [string]>(
      "SELECT title, time_updated FROM session WHERE id = ?",
    ).get(sessionId);
    if (!session) throw new Error(`session not found: ${sourceId}/${sessionId}`);

    const rows = database.query<PartRow, [string]>(`
      SELECT p.id, p.message_id, p.time_created, p.data AS part_data, m.data AS message_data
      FROM part p JOIN message m ON m.id = p.message_id
      WHERE p.session_id = ? ORDER BY p.time_created, p.id
    `).all(sessionId);

    const events: TimelineEvent[] = [];
    for (const row of rows) {
      const part = parseJson(row.part_data);
      const message = parseJson(row.message_data);
      const type = text(part.type);
      if (type === "text") {
        if (part.synthetic === true || (part.metadata && typeof part.metadata === "object" && (part.metadata as Record<string, unknown>).opencodeMemory)) continue;
        const content = redactText(text(part.text)).trim();
        const role = message.role === "user" ? "user" : "assistant";
        if (content) events.push({ partId: row.id, messageId: row.message_id, timestamp: row.time_created, role, text: content });
      } else if (type === "reasoning") {
        const content = redactText(text(part.text)).trim();
        if (content) events.push({ partId: row.id, messageId: row.message_id, timestamp: row.time_created, role: "reasoning", text: content });
      } else if (type === "tool") {
        const result = toolText(part);
        events.push({
          partId: row.id,
          messageId: row.message_id,
          timestamp: row.time_created,
          role: "tool",
          text: result.text,
          tool: result.tool,
          toolStatus: result.status,
        });
      }
    }

    const hasher = new CryptoHasher("sha256");
    hasher.update(`${sourceId}\u0000${sessionId}\u0000${session.time_updated}\u0000`);
    for (const event of events) hasher.update(`${event.partId}\u0000${event.text}\u0000`);
    return {
      title: session.title,
      sourceHash: hasher.digest("hex"),
      events,
      chunks: chunkEvents(events, maxChunkChars),
    };
  } finally {
    database.close();
  }
}

export function readSourceSessionMetadata(sourceId: string, sessionId: string): SourceSessionMetadata {
  const path = SOURCE_PATHS[sourceId];
  if (!path) throw new Error(`unknown source: ${sourceId}`);
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const row = database.query<{ title: string; directory: string; time_updated: number; parent_id: string | null }, [string]>(
      "SELECT title, directory, time_updated, parent_id FROM session WHERE id = ?",
    ).get(sessionId);
    if (!row) throw new Error(`session not found: ${sourceId}/${sessionId}`);
    return { title: row.title, directory: row.directory, timeUpdated: row.time_updated, parentId: row.parent_id };
  } finally {
    database.close();
  }
}
