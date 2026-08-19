import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import { KnowledgeRepository, type MemoryEntry } from "./repository.ts";
import { insertStructuralRelation } from "./relations.ts";
import { domainInterfaceId } from "./domains.ts";
import { similarPairs } from "../similarity/bigram.ts";

interface Atom {
  id: string;
  title: string;
  content: string;
  role: "implementation" | "interface";
  domain: string | null;
  contract: Record<string, unknown>;
  tags: string[];
  sourceIds: string[];
}

interface ParentProposal {
  id: string;
  title: string;
  content: string;
  contract: Record<string, unknown>;
  tags: string[];
  confidence: number;
  childIds: string[];
  domain: string | null;
}

const MAP_PROMPT = `你是知识整理的 Map 阶段。输入是一批同一能力域下的原子知识。请把它们归组成若干抽象父契约，每组建一个父契约。

只输出 JSON：{"parents":[{"title":"父契约名","content":"共同能力与边界","contract":{"triggers":[],"inputs":[],"outputs":[],"invariants":[],"verification":[]},"tags":[],"confidence":0.0,"childIds":["atom-id-1","atom-id-2"]}]}

硬约束：
- 每个 parent 至少 2 个 child；同一个 child 最多属于一个 parent。
- 优先把可归并的原子合成 4-10 个成员的大组，宁粗勿细；只有确实无法归入任何大组时才保留小组或不归组。
- 禁止产生大量 2-3 个成员的小 parent：2-3 个成员的 parent 应进一步合并到更大的组。
- 父契约必须比子节点更抽象，禁止只改写标题或复制子节点内容。
- 不得加入输入中不存在的 childId。
- 若无有效分组，输出 {"parents":[]}。`;

const REDUCE_PROMPT = `你是知识整理的全局 Reduce 阶段。输入是 Map 阶段产生的父概念。请合并重复/近重复父概念，统一命名与契约。

只输出 JSON：{"parents":[{"title":"规范父契约名","content":"统一说明","contract":{"triggers":[],"inputs":[],"outputs":[],"invariants":[],"verification":[]},"tags":[],"confidence":0.0,"proposalIds":["proposal-id-1"]}]}

硬约束：
- 每个输入 proposalId 必须且只能出现一次；不允许丢失。
- 语义相同或高度重叠的 proposal 合并；不同概念保持独立（允许 proposalIds 只有 1 个）。
- 规范父契约必须比其所有来源更稳定、更抽象。`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function atomPayload(atom: Atom): string {
  return JSON.stringify({ id: atom.id, title: atom.title, content: atom.content.slice(0, 800), contract: atom.contract, tags: atom.tags, domain: atom.domain });
}

export class AdaptiveHierarchyOrganizer {
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly model: JsonModel = createConfiguredJsonModel(),
  ) {}

  async run(): Promise<{ runId: string; levels: number; objects: number }> {
    if (this.running) throw new Error("hierarchy organizer is already running");
    this.running = true;
    const runId = randomUUID();
    try {
      this.database.query(`
        UPDATE hierarchy_runs SET status='interrupted',error='worker restarted',updated_at=?,completed_at=?
        WHERE status='running'
      `).run(Date.now(), Date.now());
      const repository = new KnowledgeRepository(this.database);
      const source = repository.graph(false).entries
        .filter(({ role, status }) => role === "implementation" && status !== "rejected")
        .map((entry) => this.toAtom(entry));
      const now = Date.now();
      this.database.query(`
        INSERT INTO hierarchy_runs(id,status,level,stage,source_count,created_at,updated_at)
        VALUES (?, 'running', 0, 'map', ?, ?, ?)
      `).run(runId, source.length, now, now);

      let levelAtoms = source;
      const levels: Array<{ parents: ParentProposal[]; links: Array<[string, string]> }> = [];
      for (let level = 0; level < 8 && levelAtoms.length >= 2; level += 1) {
        this.progress(runId, level, "map", 0, Math.ceil(levelAtoms.length / 32));
        const proposals = await this.mapLevel(runId, level, levelAtoms);
        if (proposals.length === 0) break;
        this.progress(runId, level, "reduce", 0, 1);
        const parents = await this.reduceLevel(proposals);
        if (parents.length === 0 || parents.length >= levelAtoms.length * 0.85) break;
        const childToParent = new Map<string, string>();
        for (const parent of parents) for (const childId of parent.childIds) if (!childToParent.has(childId)) childToParent.set(childId, parent.id);
        const links = [...childToParent.entries()].map(([childId, parentId]) => [childId, parentId] as [string, string]);
        levels.push({ parents, links });
        levelAtoms = parents.map((parent) => ({ id: parent.id, title: parent.title, content: parent.content, role: "interface", domain: parent.domain, contract: parent.contract, tags: parent.tags, sourceIds: parent.childIds }));
        this.progress(runId, level + 1, "map", 0, 0);
        if (parents.length === 1) break;
      }

      this.apply(levels);
      const completedAt = Date.now();
      const objects = levels.reduce((sum, level) => sum + level.parents.length, 0);
      this.database.query(`
        UPDATE hierarchy_runs SET status='completed',level=?,stage='done',result=?,updated_at=?,completed_at=? WHERE id=?
      `).run(levels.length, JSON.stringify({ levels: levels.length, objects }), completedAt, completedAt, runId);
      return { runId, levels: levels.length, objects };
    } catch (error) {
      this.database.query(`UPDATE hierarchy_runs SET status='failed',error=?,updated_at=?,completed_at=? WHERE id=?`)
        .run(error instanceof Error ? error.message.slice(0, 4_000) : String(error), Date.now(), Date.now(), runId);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private toAtom(entry: MemoryEntry): Atom {
    return { id: entry.id, title: entry.title, content: entry.content, role: "implementation", domain: entry.domain, contract: entry.contract, tags: entry.tags, sourceIds: [entry.id] };
  }

  private async mapLevel(runId: string, level: number, atoms: Atom[]): Promise<ParentProposal[]> {
    const byDomain = new Map<string, Atom[]>();
    for (const atom of atoms) {
      const key = atom.domain ?? "\u0000未分类";
      const bucket = byDomain.get(key);
      if (bucket) bucket.push(atom);
      else byDomain.set(key, [atom]);
    }
    const tasks: Array<{ batch: Atom[]; index: number }> = [];
    for (const domainAtoms of byDomain.values()) {
      const seriated = this.seriate(domainAtoms);
      const BATCH = 32;
      for (let offset = 0; offset < seriated.length; offset += BATCH) {
        tasks.push({ batch: seriated.slice(offset, offset + BATCH), index: tasks.length });
      }
    }
    const parents: ParentProposal[] = [];
    const CONCURRENCY = 4;
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= tasks.length) break;
        const { batch } = tasks[index] as { batch: Atom[]; index: number };
        const input = batch.map(atomPayload).join("\n");
        const value = await this.cachedGenerate(`map:${level}`, input, MAP_PROMPT);
        parents.push(...this.validateMap(value, batch, level, index));
        done += 1;
        this.progress(runId, level, "map", done, tasks.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
    return parents.sort((a, b) => a.id.localeCompare(b.id));
  }


  private seriate(atoms: Atom[]): Atom[] {
    if (atoms.length <= 2) return atoms;
    const pairs = similarPairs(atoms.map((atom) => ({ id: atom.id, text: `${atom.title} ${atom.content.slice(0, 300)}` })), 0.15);
    const sim = new Map<string, Map<string, number>>();
    for (const pair of pairs) {
      let fa = sim.get(pair.a);
      if (!fa) sim.set(pair.a, (fa = new Map()));
      fa.set(pair.b, pair.score);
      let fb = sim.get(pair.b);
      if (!fb) sim.set(pair.b, (fb = new Map()));
      fb.set(pair.a, pair.score);
    }
    const result: Atom[] = [];
    const used = new Set<string>();
    let remaining = atoms;
    while (remaining.length > 0) {
      let current = remaining[0] as Atom;
      result.push(current);
      used.add(current.id);
      remaining = remaining.filter((atom) => !used.has(atom.id));
      while (remaining.length > 0) {
        const neighbors = sim.get(current.id);
        let best: Atom | null = null;
        let bestScore = 0.15;
        for (const atom of remaining) {
          const score = neighbors?.get(atom.id) ?? 0;
          if (score > bestScore) {
            bestScore = score;
            best = atom;
          }
        }
        if (!best) break;
        result.push(best);
        used.add(best.id);
        remaining = remaining.filter((atom) => !used.has(atom.id));
        current = best;
      }
    }
    return result;
  }

  private validateMap(value: unknown, atoms: Atom[], level: number, batchIndex: number): ParentProposal[] {
    const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
    const used = new Set<string>();
    const parents: ParentProposal[] = [];
    for (const raw of Array.isArray(root.parents) ? root.parents : []) {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const childIds = Array.isArray(item.childIds)
        ? [...new Set(item.childIds.filter((id): id is string => typeof id === "string" && atomById.has(id) && !used.has(id)))]
        : [];
      const title = text(item.title);
      if (!title || childIds.length < 2) continue;
      childIds.forEach((id) => used.add(id));
      const childDomains = [...new Set(childIds.map((id) => atomById.get(id)?.domain).filter(Boolean))];
      parents.push({
        id: `p_${level}_${batchIndex}_${parents.length}_${hash(title).slice(0, 8)}`,
        title,
        content: text(item.content),
        contract: item.contract && typeof item.contract === "object" && !Array.isArray(item.contract) ? item.contract as Record<string, unknown> : {},
        tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12) : [],
        confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
        childIds,
        domain: childDomains.length === 1 ? childDomains[0] as string : null,
      });
    }
    return parents;
  }

  private async reduceLevel(proposals: ParentProposal[]): Promise<ParentProposal[]> {
    if (proposals.length === 0) return [];
    const byDomain = new Map<string, ParentProposal[]>();
    for (const proposal of proposals) {
      const key = proposal.domain ?? "\u0000未分类";
      const bucket = byDomain.get(key);
      if (bucket) bucket.push(proposal);
      else byDomain.set(key, [proposal]);
    }
    const CHUNK = 40;
    const chunks: ParentProposal[][] = [];
    for (const domainProposals of byDomain.values()) {
      for (let offset = 0; offset < domainProposals.length; offset += CHUNK) {
        chunks.push(domainProposals.slice(offset, offset + CHUNK));
      }
    }
    const results = await Promise.all(chunks.map((chunk, index) => this.reduceChunk(chunk, index)));
    return results.flat();
  }

  private async reduceChunk(proposals: ParentProposal[], chunkIndex: number): Promise<ParentProposal[]> {
    const input = proposals.map((proposal) => JSON.stringify({ id: proposal.id, title: proposal.title, content: proposal.content, contract: proposal.contract, tags: proposal.tags })).join("\n");
    const value = await this.cachedGenerate(`reduce:${chunkIndex}`, input, REDUCE_PROMPT);
    const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const used = new Set<string>();
    const parents: ParentProposal[] = [];
    for (const raw of Array.isArray(root.parents) ? root.parents : []) {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const proposalIds = Array.isArray(item.proposalIds)
        ? [...new Set(item.proposalIds.filter((id): id is string => typeof id === "string" && byId.has(id) && !used.has(id)))]
        : [];
      if (proposalIds.length === 0) continue;
      proposalIds.forEach((id) => used.add(id));
      const sources = proposalIds.map((id) => byId.get(id) as ParentProposal);
      const title = text(item.title) || sources[0]?.title || "";
      const childIds = [...new Set(sources.flatMap((source) => source.childIds))];
      const domains = [...new Set(sources.map(({ domain }) => domain).filter(Boolean))];
      parents.push({
        id: `mem_${hash(`hierarchy\u0000${title.toLowerCase()}`).slice(0, 24)}`,
        title,
        content: text(item.content) || sources[0]?.content || "",
        contract: item.contract && typeof item.contract === "object" && !Array.isArray(item.contract) ? item.contract as Record<string, unknown> : sources[0]?.contract ?? {},
        tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12) : sources[0]?.tags ?? [],
        confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : Math.max(...sources.map(({ confidence }) => confidence)),
        childIds,
        domain: domains.length === 1 ? domains[0] as string : null,
      });
    }
    for (const proposal of proposals) if (!used.has(proposal.id)) parents.push({ ...proposal, id: `mem_${hash(`hierarchy\u0000${proposal.title.toLowerCase()}`).slice(0, 24)}` });
    return parents;
  }

  private async cachedGenerate(stage: string, input: string, prompt: string): Promise<unknown> {
    const inputHash = hash(`${this.model.id}\u0000${prompt}\u0000${input}`);
    const cached = this.database.query<{ payload: string }, [string, string]>("SELECT payload FROM hierarchy_cache WHERE stage=? AND input_hash=?").get(stage, inputHash);
    if (cached) return JSON.parse(cached.payload);
    const value = await this.model.generate(prompt, input);
    this.database.query("INSERT OR REPLACE INTO hierarchy_cache(stage,input_hash,payload,created_at) VALUES (?,?,?,?)").run(stage, inputHash, JSON.stringify(value), Date.now());
    return value;
  }

  private apply(levels: Array<{ parents: ParentProposal[]; links: Array<[string, string]> }>): void {
    const now = Date.now();
    this.database.transaction(() => {
      this.database.query("DELETE FROM entries WHERE role IN ('interface','abstract') AND status='generated'").run();
      this.database.query("DELETE FROM links WHERE relation IN ('IMPLEMENTS','EXTENDS')").run();
      const insert = this.database.query(`
        INSERT INTO entries(id,title,content,role,kind,namespace,domain,contract,delta,tags,source_refs,status,confidence,valid_from,valid_to,created_at,updated_at)
        VALUES (?, ?, ?, 'interface', '知识契约', 'global', ?, ?, '{}', ?, '[]', 'generated', ?, ?, NULL, ?, ?)
      `);
      const roleById = new Map(this.database.query<{ id: string; role: string }, []>("SELECT id,role FROM entries").all().map((row) => [row.id, row.role]));
      for (const level of levels) {
        for (const parent of level.parents) {
          insert.run(parent.id, parent.title, parent.content, parent.domain, JSON.stringify(parent.contract), JSON.stringify(parent.tags), parent.confidence, now, now, now);
          roleById.set(parent.id, "interface");
        }
      }
      for (const level of levels) for (const [childId, parentId] of level.links) {
        const childRole = roleById.get(childId);
        if (!childRole) continue;
        insertStructuralRelation(this.database, childId, parentId, childRole === "implementation" ? "IMPLEMENTS" : "EXTENDS", now);
      }
      const hierarchyChildren = new Set(levels.flatMap((level) => level.links.map(([childId]) => childId)));
      const hierarchyParents = levels.flatMap((level) => level.parents);
      for (const parent of hierarchyParents) {
        if (!hierarchyChildren.has(parent.id) && parent.domain) {
          insertStructuralRelation(this.database, parent.id, domainInterfaceId(parent.domain), "EXTENDS", now);
        }
      }
      new KnowledgeRepository(this.database).rebuildFts();
    })();
  }

  private progress(runId: string, level: number, stage: string, done: number, total: number): void {
    this.database.query("UPDATE hierarchy_runs SET level=?,stage=?,progress_done=?,progress_total=?,updated_at=? WHERE id=?")
      .run(level, stage, done, total, Date.now(), runId);
  }
}
