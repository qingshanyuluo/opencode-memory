import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { TelemetryRepository } from "./repository.ts";

const SOURCES = [
  ["main", resolve(homedir(), ".local/share/opencode/opencode.db")],
  ["dev", resolve(homedir(), ".local/share/opencode/opencode-dev.db")],
  ["local", resolve(homedir(), ".local/share/opencode/opencode-local.db")],
] as const;

interface RecallRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
  directory: string;
  message_data: string;
}

function parse(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export function importOpencodeTelemetry(memoryDatabase: Database): number {
  const telemetry = new TelemetryRepository(memoryDatabase);
  let imported = 0;
  for (const [sourceId, path] of SOURCES) {
    if (!existsSync(path)) continue;
    const source = new Database(path, { readonly: true, strict: true });
    try {
      const rows = source.query<RecallRow, []>(`
        SELECT p.id,p.message_id,p.session_id,p.time_created,p.data,
               s.directory,m.data AS message_data
        FROM part p JOIN message m ON m.id=p.message_id JOIN session s ON s.id=p.session_id
        WHERE json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='memory_pull'
        ORDER BY p.time_created
      `).all();
      const followup = source.query<{ tools: number; edits: number }, [string, number, number]>(`
        SELECT count(*) AS tools,
               sum(CASE WHEN json_extract(data,'$.tool') IN ('edit','write','apply_patch') THEN 1 ELSE 0 END) AS edits
        FROM part WHERE session_id=? AND time_created>? AND time_created<=?
          AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')<>'memory_pull'
      `);
      for (const row of rows) {
        const part = parse(row.data);
        const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
        const input = state.input && typeof state.input === "object" ? state.input as Record<string, unknown> : {};
        const message = parse(row.message_data);
        const output = string(state.output);
        const runtimeRecallId = output.match(/recall_id:\s*([a-f0-9-]{36})/i)?.[1];
        const entryIds = [...output.matchAll(/memory_id:\s*(mem_[a-z0-9]+)/g)].map((match) => match[1] as string);
        const roles = [...output.matchAll(/role=([a-z]+)/g)].map((match) => match[1] as string);
        const entries = entryIds.map((id, index) => ({ id, role: roles[index] ?? "unknown" }));
        const time = state.time && typeof state.time === "object" ? state.time as Record<string, unknown> : {};
        const start = typeof time.start === "number" ? time.start : row.time_created;
        const end = typeof time.end === "number" ? time.end : start;
        const after = followup.get(row.session_id, row.time_created, row.time_created + 15 * 60_000);
        if (runtimeRecallId && memoryDatabase.query<{ value: number }, [string]>(
          "SELECT 1 AS value FROM memory_recalls WHERE id = ?",
        ).get(runtimeRecallId)) {
          memoryDatabase.query(`
            UPDATE memory_recalls SET source='runtime+opencode-db',source_part_id=?,
                   followup_tool_count=?,followup_edit_count=? WHERE id=?
          `).run(`${sourceId}:${row.id}`, after?.tools ?? 0, after?.edits ?? 0, runtimeRecallId);
          imported += 1;
          continue;
        }
        telemetry.recordRecall({
          id: `db_${sourceId}_${row.id}`,
          source: "opencode-db",
          sourcePartId: `${sourceId}:${row.id}`,
          sessionId: row.session_id,
          messageId: row.message_id,
          directory: row.directory,
          agent: string(message.agent) || null,
          query: string(input.query),
          domain: string(input.domain) || null,
          namespace: string(input.namespace) || null,
          mode: string(input.mode) || "auto",
          depth: typeof input.depth === "number" ? input.depth : 2,
          includeInstances: input.include_instances === true,
          requestedLimit: typeof input.limit === "number" ? input.limit : 8,
          status: string(state.status) || "unknown",
          entries,
          rootCount: (output.match(/\bROOT\b/g) ?? []).length,
          latencyMs: Math.max(0, end - start),
          recalledAt: row.time_created,
          followupToolCount: after?.tools ?? 0,
          followupEditCount: after?.edits ?? 0,
          error: string(state.error) || null,
        });
        imported += 1;
      }
    } finally {
      source.close();
    }
  }
  return imported;
}
