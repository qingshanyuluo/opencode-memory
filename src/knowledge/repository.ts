import type { Database } from "bun:sqlite";
import { assertStructuralRelation } from "./relations.ts";
import type { StructuralRelation } from "./types.ts";

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  role: string;
  kind: string | null;
  namespace: string | null;
  domain: string | null;
  contract: Record<string, unknown>;
  delta: Record<string, unknown>;
  tags: string[];
  status: string;
  confidence: number;
  sourceRefs: unknown[];
  reviewNote: string | null;
  validFrom: number;
  validTo: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RawEntry extends Omit<MemoryEntry, "tags" | "sourceRefs" | "contract" | "delta"> {
  tagsJson: string;
  sourceRefsJson: string;
  contractJson: string;
  deltaJson: string;
}

export interface KnowledgeGraph {
  entries: MemoryEntry[];
  links: Array<{
    sourceEntryId: string;
    targetEntryId: string;
    relation: string;
  }>;
}

export interface LoadedMemory extends KnowledgeGraph {
  rootIds: string[];
}

function mapEntry(row: RawEntry): MemoryEntry {
  const { tagsJson, sourceRefsJson, contractJson, deltaJson, ...entry } = row;
  return {
    ...entry,
    tags: JSON.parse(tagsJson) as string[],
    sourceRefs: JSON.parse(sourceRefsJson) as unknown[],
    contract: JSON.parse(contractJson) as Record<string, unknown>,
    delta: JSON.parse(deltaJson) as Record<string, unknown>,
  };
}

const ENTRY_SELECT = `
  SELECT e.id, e.title, e.content, e.role, e.kind, e.namespace, e.domain,
         e.contract AS contractJson, e.delta AS deltaJson,
         e.tags AS tagsJson, e.source_refs AS sourceRefsJson,
         e.status, e.confidence, e.review_note AS reviewNote,
         e.valid_from AS validFrom, e.valid_to AS validTo,
         e.created_at AS createdAt, e.updated_at AS updatedAt
`;

export class KnowledgeRepository {
  constructor(private readonly database: Database) {}

  catalog(directory?: string): {
    total: number;
    domains: Array<{ domain: string; count: number }>;
    namespaces: Array<{ namespace: string; count: number }>;
    roles: Array<{ role: string; count: number }>;
    kinds: Array<{ kind: string; count: number }>;
    relevant: MemoryEntry[];
  } {
    const statuses = "status IN ('generated','active') AND valid_to IS NULL AND role <> 'instance'";
    const total = this.database.query<{ count: number }, []>(
      `SELECT count(*) AS count FROM entries WHERE ${statuses}`,
    ).get()?.count ?? 0;
    const namespaces = this.database.query<{ namespace: string; count: number }, []>(`
      SELECT coalesce(namespace,'uncategorized') AS namespace, count(*) AS count
      FROM entries WHERE ${statuses} GROUP BY namespace ORDER BY count DESC
    `).all();
    const domains = this.database.query<{ domain: string; count: number }, []>(`
      SELECT coalesce(domain,'unclassified') AS domain, count(*) AS count
      FROM entries WHERE ${statuses} GROUP BY domain ORDER BY count DESC
    `).all();
    const kinds = this.database.query<{ kind: string; count: number }, []>(`
      SELECT coalesce(kind,'knowledge') AS kind, count(*) AS count
      FROM entries WHERE ${statuses} GROUP BY kind ORDER BY count DESC
    `).all();
    const roles = this.database.query<{ role: string; count: number }, []>(`
      SELECT role, count(*) AS count FROM entries WHERE ${statuses} GROUP BY role ORDER BY count DESC
    `).all();
    const namespace = directory?.split("/").filter(Boolean).at(-1) ?? "";
    const relevantRows = namespace
      ? this.database.query<RawEntry, [string]>(`${ENTRY_SELECT}
          FROM entries e WHERE ${statuses} AND e.namespace = ? ORDER BY confidence DESC, updated_at DESC LIMIT 12`)
          .all(namespace)
      : this.database.query<RawEntry, []>(`${ENTRY_SELECT}
          FROM entries e WHERE ${statuses} ORDER BY confidence DESC, updated_at DESC LIMIT 12`).all();
    return { total, domains, namespaces, roles, kinds, relevant: relevantRows.map(mapEntry) };
  }

  search(query: string, options: { domain?: string | undefined; namespace?: string | undefined; kind?: string | undefined; role?: string | undefined; limit?: number | undefined; includeInstances?: boolean | undefined } = {}): MemoryEntry[] {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 30));
    const conditions = ["e.status IN ('generated','active')", "e.valid_to IS NULL"];
    const params: Array<string | number> = [];
    if (options.namespace) { conditions.push("e.namespace = ?"); params.push(options.namespace); }
    if (options.domain) { conditions.push("e.domain = ?"); params.push(options.domain); }
    if (options.kind) { conditions.push("e.kind = ?"); params.push(options.kind); }
    if (options.role) { conditions.push("e.role = ?"); params.push(options.role); }
    if (!options.includeInstances) conditions.push("e.role <> 'instance'");
    conditions.push("coalesce(e.kind,'') <> '能力域'");
    const where = conditions.join(" AND ");
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const likeConditions = terms.map(() => "lower(e.title || char(10) || e.content || char(10) || e.tags) LIKE ?");
    const likeParams = [...params, ...terms.map((term) => `%${term.toLowerCase()}%`)];
    let rows: RawEntry[] = [];
    if (terms.length) {
      const fts = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      rows = this.database.query<RawEntry, Array<string | number>>(`${ENTRY_SELECT}
        FROM entries_fts f JOIN entries e ON e.id = f.entry_id
        WHERE entries_fts MATCH ? AND ${where}
        ORDER BY bm25(entries_fts), e.confidence DESC LIMIT ?
      `).all(fts, ...params, limit);
      const ftsIds = new Set(rows.map(({ id }) => id));
      const likeRows = this.database.query<RawEntry, Array<string | number>>(`${ENTRY_SELECT}
        FROM entries e WHERE ${where} AND (${likeConditions.join(" OR ")})
      `).all(...likeParams);
      const seen = new Set<string>();
      rows = [...rows, ...likeRows].filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      }).map((row) => {
        const lowerTitle = row.title.toLowerCase();
        const lowerContent = row.content.toLowerCase();
        const lowerTags = row.tagsJson.toLowerCase();
        let termHits = 0;
        for (const term of terms) {
          const key = term.toLowerCase();
          if (lowerContent.includes(key)) termHits += 1;
        }
        const score = termHits * 2
          + terms.reduce((sum, term) => sum + (lowerTitle.includes(term.toLowerCase()) ? 2 : 0) + (lowerTags.includes(term.toLowerCase()) ? 1 : 0), 0);
        return { ...row, score };
      }).sort((left, right) => right.score - left.score || right.confidence - left.confidence);
      rows = rows.slice(0, limit);
      if (rows.length === 0 && options.domain) {
        rows = this.database.query<RawEntry, Array<string | number>>(`${ENTRY_SELECT}
          FROM entries e WHERE ${where} ORDER BY e.confidence DESC, e.updated_at DESC LIMIT ?
        `).all(...params, limit);
      }
    } else {
      rows = this.database.query<RawEntry, Array<string | number>>(`${ENTRY_SELECT}
        FROM entries e WHERE ${where} ORDER BY e.confidence DESC, e.updated_at DESC LIMIT ?
      `).all(...params, limit);
    }
    return rows.map(mapEntry);
  }

  load(query: string, options: {
    domain?: string | undefined;
    namespace?: string | undefined;
    mode?: "auto" | "interface" | "implementation" | "evidence" | undefined;
    depth?: number | undefined;
    includeInstances?: boolean | undefined;
    limit?: number | undefined;
  } = {}): LoadedMemory {
    const mode = options.mode ?? "auto";
    const role = mode === "interface" ? "interface"
      : mode === "implementation" ? "implementation"
        : mode === "evidence" ? "instance"
          : undefined;
    let roots = this.search(query, {
      domain: options.domain,
      namespace: options.namespace,
      role,
      includeInstances: mode === "evidence",
      limit: options.limit ?? 6,
    });
    if (roots.length === 0 && options.namespace) {
      roots = this.search(query, { domain: options.domain, role, includeInstances: mode === "evidence", limit: options.limit ?? 6 });
    }
    if (mode === "auto" || mode === "implementation") {
      const instanceRoots = this.search(query, {
        domain: options.domain, namespace: options.namespace, role: "instance", includeInstances: true, limit: options.limit ?? 6,
      });
      const rootIds = new Set(roots.map(({ id }) => id));
      const implementations = new Set<string>();
      for (const instance of instanceRoots) {
        const links = this.database.query<{ target: string }, [string]>(`
          SELECT target_entry_id AS target FROM links
          WHERE valid_to IS NULL AND source_entry_id = ? AND relation = 'INSTANCE_OF'
        `).all(instance.id);
        for (const { target } of links) if (!rootIds.has(target)) implementations.add(target);
      }
      if (implementations.size) {
        const placeholders = [...implementations].map(() => "?").join(",");
        const implRows = this.database.query<RawEntry, string[]>(`${ENTRY_SELECT}
          FROM entries e WHERE e.id IN (${placeholders}) AND e.status IN ('generated','active') AND e.valid_to IS NULL
        `).all(...implementations);
        roots = [...roots, ...implRows.map(mapEntry)];
      }
    }

    const all = new Map<string, MemoryEntry>(roots.map((entry) => [entry.id, entry]));
    const links = new Map<string, KnowledgeGraph["links"][number]>();
    let frontier = [...all.keys()];
    const depth = Math.max(0, Math.min(options.depth ?? 2, 4));
    for (let level = 0; level < depth && frontier.length; level += 1) {
      const placeholders = frontier.map(() => "?").join(",");
      const rows = this.database.query<KnowledgeGraph["links"][number], string[]>(`
        SELECT source_entry_id AS sourceEntryId, target_entry_id AS targetEntryId, relation
        FROM links WHERE valid_to IS NULL AND (
          source_entry_id IN (${placeholders}) OR target_entry_id IN (${placeholders})
        )
      `).all(...frontier, ...frontier).filter((link) => {
        if (link.relation === "INSTANCE_OF") return Boolean(options.includeInstances);
        return ["IMPLEMENTS", "EXTENDS", "REFERENCES", "SUPERSEDES", "CONTRADICTS"].includes(link.relation);
      });
      const nextIds = new Set<string>();
      for (const link of rows) {
        links.set(`${link.sourceEntryId}\u0000${link.targetEntryId}\u0000${link.relation}`, link);
        nextIds.add(link.sourceEntryId);
        nextIds.add(link.targetEntryId);
      }
      for (const id of all.keys()) nextIds.delete(id);
      if (nextIds.size === 0) break;
      const ids = [...nextIds];
      const related = this.database.query<RawEntry, string[]>(`${ENTRY_SELECT}
        FROM entries e WHERE e.id IN (${ids.map(() => "?").join(",")})
        AND e.status IN ('generated','active') AND e.valid_to IS NULL
        AND coalesce(e.kind,'') <> '能力域'
      `).all(...ids).map(mapEntry);
      for (const entry of related) {
        if (entry.role !== "instance" || options.includeInstances) all.set(entry.id, entry);
      }
      frontier = related.filter((entry) => all.has(entry.id)).map(({ id }) => id);
    }
    const loadedIds = new Set(all.keys());
    return {
      rootIds: roots.map(({ id }) => id),
      entries: [...all.values()],
      links: [...links.values()].filter((link) => loadedIds.has(link.sourceEntryId) && loadedIds.has(link.targetEntryId)),
    };
  }

  graph(includeInactive = true): KnowledgeGraph {
    const where = includeInactive ? "1=1" : "status IN ('generated','active') AND valid_to IS NULL";
    const entries = this.database.query<RawEntry, []>(`${ENTRY_SELECT}
      FROM entries e WHERE ${where} ORDER BY namespace, kind, title`).all().map(mapEntry);
    const links = this.database.query<KnowledgeGraph["links"][number], []>(`
      SELECT source_entry_id AS sourceEntryId, target_entry_id AS targetEntryId, relation
      FROM links WHERE valid_to IS NULL
    `).all();
    return { entries, links };
  }

  review(id: string, input: { status?: string | undefined; title?: string | undefined; content?: string | undefined; role?: string | undefined; contract?: Record<string, unknown> | undefined; delta?: Record<string, unknown> | undefined; reviewNote?: string | undefined }): MemoryEntry | null {
    const allowed = new Set(["generated", "active", "stale", "rejected"]);
    if (input.status && !allowed.has(input.status)) throw new Error("invalid memory status");
    const current = this.database.query<RawEntry, [string]>(`${ENTRY_SELECT} FROM entries e WHERE id = ?`).get(id);
    if (!current) return null;
    const title = input.title?.trim() || current.title;
    const content = input.content?.trim() || current.content;
    const status = input.status ?? current.status;
    const role = input.role ?? current.role;
    if (!['interface','abstract','implementation','instance','resource'].includes(role)) throw new Error("invalid memory role");
    const contract = input.contract ?? JSON.parse(current.contractJson) as Record<string, unknown>;
    const delta = input.delta ?? JSON.parse(current.deltaJson) as Record<string, unknown>;
    const reviewNote = input.reviewNote ?? current.reviewNote;
    const now = Date.now();
    this.database.transaction(() => {
      this.database.query(`
        UPDATE entries SET title=?, content=?, role=?, contract=?, delta=?, status=?, review_note=?, reviewed_at=?, updated_at=?
        WHERE id=?
      `).run(title, content, role, JSON.stringify(contract), JSON.stringify(delta), status, reviewNote, now, now, id);
      const links = this.database.query<{ source: string; target: string; relation: StructuralRelation }, [string, string]>(`
        SELECT source_entry_id AS source,target_entry_id AS target,relation
        FROM links WHERE valid_to IS NULL AND (source_entry_id = ? OR target_entry_id = ?)
      `).all(id, id);
      for (const link of links) assertStructuralRelation(this.database, link.source, link.target, link.relation);
      this.rebuildFts();
    })();
    return mapEntry(this.database.query<RawEntry, [string]>(`${ENTRY_SELECT} FROM entries e WHERE id = ?`).get(id) as RawEntry);
  }

  delete(id: string): boolean {
    const existing = this.database.query<{ value: number }, [string]>(
      "SELECT 1 AS value FROM entries WHERE id = ?",
    ).get(id);
    if (!existing) return false;
    this.database.transaction(() => {
      this.database.query("DELETE FROM links WHERE source_entry_id = ? OR target_entry_id = ?").run(id, id);
      this.database.query("DELETE FROM entry_origins WHERE entry_id = ?").run(id);
      this.database.query("DELETE FROM entries WHERE id = ?").run(id);
      this.rebuildFts();
    })();
    return true;
  }

  rebuildFts(): void {
    this.database.query("DELETE FROM entries_fts").run();
    this.database.query(`
      INSERT INTO entries_fts(entry_id, title, content, role, kind, namespace, domain, tags)
      SELECT id, title, content, role, coalesce(kind,''), coalesce(namespace,''), coalesce(domain,''), tags
      FROM entries WHERE status IN ('generated','active') AND valid_to IS NULL
    `).run();
  }
}
