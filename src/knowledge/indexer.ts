import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import { KnowledgeRepository } from "./repository.ts";
import { insertStructuralRelation } from "./relations.ts";
import { CANONICAL_DOMAINS, classifyDomain, domainInterfaceId } from "./domains.ts";
import { classifyDomainsByLLM, type ClassifiableEntry } from "./domain-classifier.ts";

export class KnowledgeDomainIndexer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly debounceMs = Number.parseInt(Bun.env.OPENCODE_MEMORY_DOMAIN_DEBOUNCE_MS ?? "300000", 10),
    private readonly model: JsonModel = createConfiguredJsonModel(),
  ) {}

  request(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.run().catch((error) => console.error("domain indexing failed", error));
    }, this.debounceMs);
  }

  async run(): Promise<{ interfaces: number; assigned: number; linked: number }> {
    if (this.running) return { interfaces: 0, assigned: 0, linked: 0 };
    this.running = true;
    try {
      const now = Date.now();
      const interfaces = this.ensureDomainInterfaces(now);
      const assigned = await this.assignDomains(now);
      const linked = this.linkDomains(now);
      new KnowledgeRepository(this.database).rebuildFts();
      return { interfaces, assigned, linked };
    } finally {
      this.running = false;
    }
  }

  private ensureDomainInterfaces(now: number): number {
    const insert = this.database.query(`
      INSERT INTO entries(
        id,title,content,role,kind,namespace,domain,contract,delta,tags,source_refs,status,
        confidence,valid_from,valid_to,created_at,updated_at
      ) VALUES (?, ?, ?, 'interface', '能力域', 'global', ?, ?, '{}', ?, '[]', 'active', 1, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=excluded.updated_at
    `);
    let created = 0;
    this.database.transaction(() => {
      for (const domain of CANONICAL_DOMAINS) {
        const contract = {
          triggers: domain.keywords.slice(0, 12),
          inputs: [],
          outputs: [],
          invariants: ["能力域契约：跨项目、跨工具稳定的检索入口"],
          verification: [],
        };
        const content = `${domain.description}\n\n关键检索词：${domain.keywords.join("、")}`;
        const result = insert.run(
          domainInterfaceId(domain.id), domain.title, content, domain.id,
          JSON.stringify(contract), JSON.stringify(domain.keywords), now, now, now,
        );
        created += result.changes;
      }
    })();
    return created;
  }

  private async assignDomains(now: number): Promise<number> {
    const rows = this.database.query<{ id: string; title: string; content: string; kind: string | null; tags: string }, []>(`
      SELECT id,title,content,kind,tags FROM entries WHERE valid_to IS NULL AND (domain IS NULL OR domain = '')
    `).all();
    const update = this.database.query(`UPDATE entries SET domain = ?, updated_at = ? WHERE id = ?`);
    let assigned = 0;
    const unclassified: ClassifiableEntry[] = [];
    this.database.transaction(() => {
      for (const row of rows) {
        const domain = classifyDomain([row.title, row.content, row.kind ?? "", row.tags]);
        if (domain) {
          update.run(domain, now, row.id);
          assigned += 1;
        } else {
          unclassified.push(row);
        }
      }
    });
    if (unclassified.length === 0) return assigned;
    const llmDomains = await classifyDomainsByLLM(unclassified, this.model, this.database);
    this.database.transaction(() => {
      for (const entry of unclassified) {
        const domain = llmDomains.get(entry.id) ?? null;
        if (domain) {
          update.run(domain, now, entry.id);
          assigned += 1;
        }
      }
    });
    return assigned;
  }

  private linkDomains(now: number): number {
    const rows = this.database.query<{ id: string; role: string; domain: string }, []>(`
      SELECT id, role, domain FROM entries
      WHERE valid_to IS NULL AND domain IS NOT NULL AND domain <> ''
        AND role IN ('implementation','interface','abstract')
    `).all();
    let linked = 0;
    this.database.transaction(() => {
      for (const row of rows) {
        const target = domainInterfaceId(row.domain);
        if (row.id === target) continue;
        if (row.role === "implementation" || row.role === "abstract") {
          insertStructuralRelation(this.database, row.id, target, "IMPLEMENTS", now);
        } else if (row.role === "interface") {
          insertStructuralRelation(this.database, row.id, target, "EXTENDS", now);
        }
        linked += 1;
      }
    })();
    return linked;
  }
}
