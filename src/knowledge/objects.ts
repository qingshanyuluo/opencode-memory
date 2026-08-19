import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { EpisodeBehavior } from "../dashboard/behavior-repository.ts";
import { insertStructuralRelation } from "./relations.ts";

function stableId(...parts: string[]): string {
  return `mem_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

export function saveSessionInstance(
  database: Database,
  sourceId: string,
  sessionId: string,
  namespace: string,
  behavior: EpisodeBehavior,
): string {
  const id = stableId("instance", sourceId, sessionId);
  const now = Date.now();
  const evidenceNodes = behavior.nodes
    .filter((node) => ["evidence", "revision", "decision", "outcome"].includes(node.type))
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 20);
  const sourceRefs = [{ sourceId, sessionId, nodeIds: evidenceNodes.map(({ id }) => id) }];
  const delta = {
    outcome: behavior.capsule.outcome,
    evidence: evidenceNodes.map(({ sequence, type, content }) => ({ sequence: sequence + 1, type, content })),
  };
  database.query(`
    INSERT INTO entries(
      id,title,content,role,kind,namespace,contract,delta,tags,source_refs,status,
      confidence,valid_from,valid_to,created_at,updated_at
    ) VALUES (?, ?, ?, 'instance', '会话案例', ?, '{}', ?, '[]', ?, 'active', ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, content=excluded.content, delta=excluded.delta,
      source_refs=excluded.source_refs, confidence=excluded.confidence, updated_at=excluded.updated_at
  `).run(
    id,
    behavior.capsule.title,
    behavior.capsule.summary.slice(0, 4_000),
    namespace,
    JSON.stringify(delta),
    JSON.stringify(sourceRefs),
    evidenceNodes.length ? Math.min(...evidenceNodes.map(({ confidence }) => confidence)) : 0.5,
    now, now, now,
  );
  database.query(`
    INSERT OR REPLACE INTO entry_origins(entry_id,source_id,session_id,source_node_ids,created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sourceId, sessionId, JSON.stringify(evidenceNodes.map(({ id: nodeId }) => nodeId)), now);
  return id;
}

export function linkInstanceToKnowledge(
  database: Database,
  instanceId: string,
  entryIds: string[],
): void {
  if (entryIds.length === 0) return;
  const rows = database.query<{ id: string; role: string; confidence: number; source_refs: string }, string[]>(`
    SELECT id,role,confidence,source_refs FROM entries
    WHERE id IN (${entryIds.map(() => "?").join(",")})
    ORDER BY CASE role WHEN 'implementation' THEN 0 ELSE 1 END, confidence DESC
  `).all(...entryIds);
  database.query(`
    DELETE FROM links WHERE source_entry_id = ? AND relation IN ('INSTANCE_OF','REFERENCES')
  `).run(instanceId);
  const instanceRefs = database.query<{ source_refs: string }, [string]>("SELECT source_refs FROM entries WHERE id = ?")
    .get(instanceId)?.source_refs ?? "[]";
  const instanceNodes = new Set(
    (JSON.parse(instanceRefs) as Array<{ nodeIds?: string[] }>).flatMap(({ nodeIds }) => nodeIds ?? []),
  );
  const implementation = rows
    .filter(({ role }) => role === "implementation")
    .map((row) => ({
      ...row,
      overlap: (JSON.parse(row.source_refs) as Array<{ nodeIds?: string[] }>)
        .flatMap(({ nodeIds }) => nodeIds ?? [])
        .filter((id) => instanceNodes.has(id)).length,
    }))
    .sort((left, right) => right.overlap - left.overlap || right.confidence - left.confidence)[0];
  const now = Date.now();
  if (implementation) {
    insertStructuralRelation(database, instanceId, implementation.id, "INSTANCE_OF", now);
  }
  for (const row of rows.filter(({ id }) => id !== implementation?.id)) {
    if (row.role === "resource" || row.role === "implementation") {
      insertStructuralRelation(database, instanceId, row.id, "REFERENCES", now);
    }
  }
}
