import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface RecallEventInput {
  id?: string | undefined;
  source?: string | undefined;
  sourcePartId?: string | null | undefined;
  sessionId: string;
  messageId?: string | null | undefined;
  directory: string;
  agent?: string | null | undefined;
  query: string;
  domain?: string | null | undefined;
  namespace?: string | null | undefined;
  mode: string;
  depth: number;
  includeInstances: boolean;
  requestedLimit: number;
  status: string;
  entries: Array<{ id: string; role: string }>;
  rootCount: number;
  latencyMs: number;
  recalledAt?: number | undefined;
  followupToolCount?: number | undefined;
  followupEditCount?: number | undefined;
  error?: string | null | undefined;
}

export class TelemetryRepository {
  constructor(private readonly database: Database) {}

  recordInjection(input: { sessionId: string; directory: string; agent?: string | null; objectCount: number; domainCount: number }): void {
    this.database.query(`
      INSERT OR IGNORE INTO memory_injections(id,session_id,directory,agent,object_count,domain_count,injected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`inj_${input.sessionId}`, input.sessionId, input.directory, input.agent ?? null, input.objectCount, input.domainCount, Date.now());
  }

  recordRecall(input: RecallEventInput): string {
    const id = input.id ?? randomUUID();
    const counts = (role: string) => input.entries.filter((entry) => entry.role === role).length;
    this.database.query(`
      INSERT INTO memory_recalls(
        id,source,source_part_id,session_id,message_id,directory,agent,query,domain,namespace,
        mode,depth,include_instances,requested_limit,status,hit_count,root_count,
        interface_count,implementation_count,resource_count,instance_count,returned_entry_ids,
        latency_ms,recalled_at,followup_tool_count,followup_edit_count,error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source,source_part_id) DO UPDATE SET
        followup_tool_count=excluded.followup_tool_count,
        followup_edit_count=excluded.followup_edit_count
    `).run(
      id, input.source ?? "runtime", input.sourcePartId ?? null, input.sessionId,
      input.messageId ?? null, input.directory, input.agent ?? null, input.query,
      input.domain ?? null, input.namespace ?? null, input.mode, input.depth,
      input.includeInstances ? 1 : 0, input.requestedLimit, input.status,
      input.entries.length, input.rootCount, counts("interface") + counts("abstract"),
      counts("implementation"), counts("resource"), counts("instance"),
      JSON.stringify(input.entries.map(({ id: entryId }) => entryId)), input.latencyMs,
      input.recalledAt ?? Date.now(), input.followupToolCount ?? 0,
      input.followupEditCount ?? 0, input.error ?? null,
    );
    return id;
  }

  feedback(recallId: string, verdict: string, note?: string): void {
    if (!["useful", "not_useful", "missed"].includes(verdict)) throw new Error("invalid feedback verdict");
    const now = Date.now();
    this.database.query(`
      INSERT INTO memory_feedback(recall_id,verdict,note,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(recall_id) DO UPDATE SET verdict=excluded.verdict,note=excluded.note,updated_at=excluded.updated_at
    `).run(recallId, verdict, note ?? null, now, now);
  }
}
