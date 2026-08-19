import type { Database } from "bun:sqlite";
import type { StructuralRelation } from "./types.ts";

const VALID_PAIRS: Record<StructuralRelation, Array<[string, string]>> = {
  IMPLEMENTS: [["implementation", "interface"], ["abstract", "interface"]],
  EXTENDS: [["implementation", "abstract"], ["abstract", "abstract"], ["interface", "interface"]],
  INSTANCE_OF: [["instance", "implementation"]],
  REFERENCES: [
    ["interface", "resource"], ["abstract", "resource"], ["implementation", "resource"],
    ["instance", "resource"], ["implementation", "implementation"], ["instance", "implementation"],
  ],
  SUPERSEDES: [
    ["interface", "interface"], ["abstract", "abstract"], ["implementation", "implementation"],
    ["instance", "instance"], ["resource", "resource"],
  ],
  CONTRADICTS: [
    ["interface", "interface"], ["abstract", "abstract"], ["implementation", "implementation"],
    ["instance", "instance"], ["resource", "resource"],
  ],
};

export function isValidStructuralPair(sourceRole: string, targetRole: string, relation: StructuralRelation): boolean {
  const allowed = VALID_PAIRS[relation];
  if (!allowed) return false;
  return allowed.some(([source, target]) => source === sourceRole && target === targetRole);
}

function role(database: Database, id: string): string | null {
  return database.query<{ role: string }, [string]>("SELECT role FROM entries WHERE id = ?").get(id)?.role ?? null;
}

function extendsWouldCycle(database: Database, source: string, target: string): boolean {
  if (source === target) return true;
  return Boolean(database.query<{ value: number }, [string, string]>(`
    WITH RECURSIVE ancestors(id) AS (
      SELECT target_entry_id FROM links WHERE source_entry_id = ? AND relation = 'EXTENDS' AND valid_to IS NULL
      UNION
      SELECT l.target_entry_id FROM links l JOIN ancestors a ON l.source_entry_id = a.id
      WHERE l.relation = 'EXTENDS' AND l.valid_to IS NULL
    ) SELECT 1 AS value FROM ancestors WHERE id = ? LIMIT 1
  `).get(target, source));
}

export function assertStructuralRelation(
  database: Database,
  sourceId: string,
  targetId: string,
  relation: StructuralRelation,
): void {
  const sourceRole = role(database, sourceId);
  const targetRole = role(database, targetId);
  if (!sourceRole || !targetRole) throw new Error(`relation references missing object: ${sourceId} -> ${targetId}`);
  if (!isValidStructuralPair(sourceRole, targetRole, relation)) {
    throw new Error(`invalid ${relation}: ${sourceRole} -> ${targetRole}`);
  }
  if (relation === "EXTENDS" && extendsWouldCycle(database, sourceId, targetId)) {
    throw new Error(`EXTENDS would create a cycle: ${sourceId} -> ${targetId}`);
  }
}

export function insertStructuralRelation(
  database: Database,
  sourceId: string,
  targetId: string,
  relation: StructuralRelation,
  now = Date.now(),
): void {
  assertStructuralRelation(database, sourceId, targetId, relation);
  database.query(`
    INSERT OR IGNORE INTO links(source_entry_id,target_entry_id,relation,valid_from,valid_to,created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(sourceId, targetId, relation, now, now);
}
