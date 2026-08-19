import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import { KnowledgeRepository, type MemoryEntry } from "./repository.ts";
import { insertStructuralRelation } from "./relations.ts";

const CLUSTER_PROMPT = `你是知识库去重聚类器。输入是一批同一能力域下的知识条目。请找出"语义相同或高度重叠、应该合并成一条"的条目组。

只输出 JSON：{"groups":[{"ids":["entry-id-1","entry-id-2"]}]}

规则：
- 每组是 2 个及以上"指同一件事"的条目（同义、重复，或高度重叠到合并后不损失独立价值）。
- 每条 id 最多出现在一个组；无法归入任何组的条目不输出。
- 宁保守：只有确实重复或高度同义的才归组；相似但各有独立价值、合并会丢失信息的不要归组。
- 只输出 JSON，不要解释。全部简体中文。`;

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

export class RefineConsolidator {
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly model: JsonModel = createConfiguredJsonModel(),
  ) {}

  async consolidate(): Promise<{ groups: number; merged: number }> {
    if (this.running) throw new Error("consolidation already running");
    this.running = true;
    try {
      const repository = new KnowledgeRepository(this.database);
      const entries = repository.graph(false).entries.filter(({ role, status }) =>
        (role === "interface" || role === "implementation") && status !== "rejected",
      );
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const byDomain = new Map<string, MemoryEntry[]>();
      for (const entry of entries) {
        const key = entry.domain ?? "\u0000未分类";
        const bucket = byDomain.get(key);
        if (bucket) bucket.push(entry);
        else byDomain.set(key, [entry]);
      }
      const CHUNK = 40;
      const tasks: Array<{ domain: string; batch: MemoryEntry[] }> = [];
      for (const [domain, domainEntries] of byDomain) {
        for (let offset = 0; offset < domainEntries.length; offset += CHUNK) {
          tasks.push({ domain, batch: domainEntries.slice(offset, offset + CHUNK) });
        }
      }
      let merged = 0;
      let groups = 0;
      const CONCURRENCY = 4;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= tasks.length) break;
          const { domain, batch } = tasks[index] as { domain: string; batch: MemoryEntry[] };
          const input = batch.map((entry) => JSON.stringify({ id: entry.id, title: entry.title, content: entry.content.slice(0, 300) })).join("\n");
          const value = await this.model.generate(CLUSTER_PROMPT, `能力域：${domain === "\u0000未分类" ? "未分类" : domain}\n\n${input}`);
          const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
          for (const raw of Array.isArray(root.groups) ? root.groups : []) {
            const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
            const ids = Array.isArray(item.ids)
              ? [...new Set(item.ids.filter((id): id is string => typeof id === "string" && byId.has(id)))]
              : [];
            if (ids.length < 2) continue;
            merged += this.mergeGroup(ids.map((id) => byId.get(id) as MemoryEntry));
            groups += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
      new KnowledgeRepository(this.database).rebuildFts();
      return { groups, merged };
    } finally {
      this.running = false;
    }
  }

  private indegree(id: string): number {
    return this.database.query<{ count: number }, [string]>(`
      SELECT count(*) AS count FROM links WHERE valid_to IS NULL AND target_entry_id = ? AND relation IN ('IMPLEMENTS','EXTENDS')
    `).get(id)?.count ?? 0;
  }

  private mergeGroup(group: MemoryEntry[]): number {
    const canonical = [...group].sort((left, right) =>
      (this.indegree(right.id) - this.indegree(left.id))
      || (right.confidence - left.confidence)
      || (left.title.length - right.title.length),
    )[0] as MemoryEntry;
    let merged = 0;
    for (const entry of group) {
      if (entry.id === canonical.id) continue;
      merged += this.merge(canonical.id, entry.id);
    }
    return merged;
  }

  private exists(id: string): boolean {
    return Boolean(this.database.query<{ value: number }, [string]>("SELECT 1 AS value FROM entries WHERE id=? AND valid_to IS NULL").get(id));
  }

  private roleOf(id: string): string | null {
    return this.database.query<{ role: string }, [string]>("SELECT role FROM entries WHERE id=?").get(id)?.role ?? null;
  }

  private repointRelation(childRole: string, primaryRole: string, original: string): string | null {
    if (original === "IMPLEMENTS") {
      if ((childRole === "implementation" || childRole === "abstract") && primaryRole === "interface") return "IMPLEMENTS";
      if (childRole === "implementation" && primaryRole === "implementation") return "REFERENCES";
      return null;
    }
    if (original === "EXTENDS") {
      if (childRole === "interface" && primaryRole === "interface") return "EXTENDS";
      if ((childRole === "implementation" || childRole === "abstract") && primaryRole === "abstract") return "EXTENDS";
      return null;
    }
    return null;
  }

  private merge(primary: string, secondary: string): number {
    if (primary === secondary || !this.exists(primary) || !this.exists(secondary)) return 0;
    const now = Date.now();
    const primaryRole = this.roleOf(primary);
    const secondaryRole = this.roleOf(secondary);
    this.database.transaction(() => {
      const children = this.database.query<{ source: string; relation: string }, [string]>(`
        SELECT source_entry_id AS source, relation FROM links WHERE valid_to IS NULL AND target_entry_id = ?
        AND relation IN ('IMPLEMENTS','EXTENDS')
      `).all(secondary);
      for (const child of children) {
        if (child.source === primary) {
          this.database.query("DELETE FROM links WHERE source_entry_id=? AND target_entry_id=? AND relation=?",).run(child.source, secondary, child.relation);
          continue;
        }
        const childRole = this.roleOf(child.source);
        if (!childRole) continue;
        const targetRelation = this.repointRelation(childRole, primaryRole as string, child.relation);
        this.database.query("DELETE FROM links WHERE source_entry_id=? AND target_entry_id=? AND relation=?",).run(child.source, secondary, child.relation);
        if (targetRelation) insertStructuralRelation(this.database, child.source, primary, targetRelation as "IMPLEMENTS" | "EXTENDS" | "REFERENCES", now);
      }
      const origins = this.database.query<{ source_id: string; session_id: string; source_node_ids: string }, [string]>(
        "SELECT source_id,session_id,source_node_ids FROM entry_origins WHERE entry_id=?",
      ).all(secondary);
      for (const origin of origins) {
        this.database.query("INSERT OR IGNORE INTO entry_origins(entry_id,source_id,session_id,source_node_ids,created_at) VALUES (?,?,?,?,?)",)
          .run(primary, origin.source_id, origin.session_id, origin.source_node_ids, now);
      }
      this.database.query("UPDATE entries SET valid_to=?,updated_at=? WHERE id=?").run(now, now, secondary);
      if (primaryRole === secondaryRole) insertStructuralRelation(this.database, primary, secondary, "SUPERSEDES", now);
    })();
    return 1;
  }
}
