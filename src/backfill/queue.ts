import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type { Database as BunDatabase } from "bun:sqlite";

interface CandidateRow {
  source_id: string;
  session_id: string;
  directory: string;
  title: string;
  parent_id: string | null;
  tool_call_count: number;
  tool_error_count: number;
  part_count: number;
  time_updated: number;
  artifact_text: string;
}

export interface BackfillFamily {
  id: string;
  directory: string;
  normalizedTitle: string;
  representativeSourceId: string;
  representativeSessionId: string;
  memberCount: number;
  priority: number;
  status: string;
  attempts: number;
  progressDone: number;
  progressTotal: number;
}

export interface BackfillStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
}

function normalizeTitle(title: string): string {
  return title
    .replace(/\s*\(fork\s*#\d+\)\s*$/i, "")
    .replace(/^New session - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/i, "New session")
    .trim();
}

function familyId(directory: string, title: string): string {
  return `fam_${createHash("sha256").update(`${directory}\u0000${title}`).digest("hex").slice(0, 24)}`;
}

function priority(row: CandidateRow): number {
  const text = row.artifact_text.toLowerCase();
  const platformSignals = ["aliyun", "sls", "dms", "nacos", "redis", "byteplus", "kubectl", "postgres", "mysql"]
    .reduce((score, term) => score + (text.includes(term) ? 40 : 0), 0);
  return row.tool_call_count + row.tool_error_count * 8 + Math.min(row.part_count / 10, 100) + platformSignals;
}

function isTechnical(row: CandidateRow): boolean {
  if (row.tool_call_count < 2) return false;
  const text = row.artifact_text.toLowerCase();
  return text.includes("[file]")
    || /\b(?:git|gradle|mvn|npm|bun|pnpm|yarn|pytest|cargo|kubectl|aliyun|docker|gh|dms|sls|nacos|redis|psql|mysql)\b/.test(text);
}

export function populateBackfillQueue(memory: BunDatabase, bootstrapPath: string): number {
  const bootstrap = new Database(bootstrapPath, { readonly: true, strict: true });
  try {
    const rows = bootstrap.query<CandidateRow, []>(`
      SELECT source_id,session_id,directory,title,parent_id,tool_call_count,
             tool_error_count,part_count,time_updated,artifact_text
      FROM session_documents WHERE user_message_count >= 1 AND tool_call_count >= 2
    `).all().filter(isTechnical);
    const groups = new Map<string, CandidateRow[]>();
    for (const row of rows) {
      const title = normalizeTitle(row.title);
      const id = familyId(row.directory, title);
      const family = groups.get(id) ?? [];
      family.push(row);
      groups.set(id, family);
    }
    const now = Date.now();
    const insertFamily = memory.query(`
      INSERT INTO backfill_families(
        id,directory,normalized_title,representative_source_id,representative_session_id,
        member_count,priority,status,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(id) DO UPDATE SET
        representative_source_id=excluded.representative_source_id,
        representative_session_id=excluded.representative_session_id,
        member_count=excluded.member_count,priority=excluded.priority
    `);
    const insertMember = memory.query(`
      INSERT OR IGNORE INTO backfill_members(family_id,source_id,session_id) VALUES (?, ?, ?)
    `);
    memory.transaction(() => {
      memory.query("UPDATE backfill_families SET status='pending' WHERE status='running'").run();
      for (const [id, members] of groups) {
        const sorted = [...members].sort((left, right) =>
          priority(right) - priority(left) || right.time_updated - left.time_updated
        );
        const representative = sorted[0] as CandidateRow;
        insertFamily.run(id, representative.directory, normalizeTitle(representative.title),
          representative.source_id, representative.session_id, members.length,
          Math.max(...members.map(priority)), now);
        for (const member of members) insertMember.run(id, member.source_id, member.session_id);
      }
    })();
    return groups.size;
  } finally {
    bootstrap.close();
  }
}

export class BackfillQueue {
  constructor(private readonly database: BunDatabase) {}

  stats(): BackfillStats {
    const rows = this.database.query<{ status: string; count: number }, []>(`
      SELECT status,count(*) AS count FROM backfill_families GROUP BY status
    `).all();
    const counts = Object.fromEntries(rows.map(({ status, count }) => [status, count]));
    return {
      total: rows.reduce((sum, row) => sum + row.count, 0),
      pending: counts.pending ?? 0,
      running: counts.running ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
    };
  }

  claimNext(strategy: "priority" | "quick" = "priority"): BackfillFamily | null {
    return this.database.transaction(() => {
      const family = this.database.query<BackfillFamily, []>(`
        SELECT id,directory,normalized_title AS normalizedTitle,
               representative_source_id AS representativeSourceId,
               representative_session_id AS representativeSessionId,
               member_count AS memberCount,priority,status,attempts,
               progress_done AS progressDone,progress_total AS progressTotal
        FROM backfill_families
        WHERE status IN ('pending','failed') AND attempts < 4
        ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,
                 ${strategy === "quick" ? "priority ASC" : "priority DESC"} LIMIT 1
      `).get() ?? null;
      if (!family) return null;
      const result = this.database.query(`
        UPDATE backfill_families SET status='running',error=NULL,started_at=?
        WHERE id=? AND status IN ('pending','failed')
      `).run(Date.now(), family.id);
      return result.changes === 1 ? family : null;
    })();
  }

  finish(id: string, status: "completed" | "skipped" | "failed", error?: string): void {
    this.database.query(`
      UPDATE backfill_families
      SET status=?,error=?,completed_at=?,attempts=attempts + CASE WHEN ?='failed' THEN 1 ELSE 0 END
      WHERE id=?
    `).run(status, error ?? null, Date.now(), status, id);
  }

  progress(id: string, done: number, total: number): void {
    this.database.query(`
      UPDATE backfill_families SET progress_done=?,progress_total=? WHERE id=?
    `).run(done, total, id);
  }

  active(): Array<{ title: string; done: number; total: number }> {
    return this.database.query<{ title: string; done: number; total: number }, []>(`
      SELECT normalized_title AS title,progress_done AS done,progress_total AS total
      FROM backfill_families WHERE status='running' ORDER BY started_at
    `).all();
  }

  members(id: string): Array<{ sourceId: string; sessionId: string }> {
    return this.database.query<{ sourceId: string; sessionId: string }, [string]>(`
      SELECT source_id AS sourceId,session_id AS sessionId FROM backfill_members WHERE family_id=?
    `).all(id);
  }

  resetFailed(): void {
    this.database.query("UPDATE backfill_families SET status='pending',error=NULL WHERE status='failed'").run();
  }
}
