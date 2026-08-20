import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import { KnowledgeRepository, type MemoryEntry } from "./repository.ts";
import { seriate } from "../similarity/bigram.ts";

const DOMAIN_PROMPT = `你是知识能力域划分器。把一批知识条目划分到若干"能力域"。

能力域 = agent 的认知能力（"能做什么"），是稳定、正交的顶层分类。它回答"这是一类什么能力"，而不是"针对什么对象"或"用了什么产品/工具"。

只输出 JSON：{"parents":[{"title":"能力域名","content":"能力域说明：这个能力解决什么问题、边界在哪","contract":{"triggers":[],"inputs":[],"outputs":[],"invariants":[],"verification":[]},"tags":[],"confidence":0.0,"childIds":["entry-id-1","entry-id-2"]}]}

划分原则（硬约束）：
- 能力域必须用"动词/能力"命名，例如：诊断、查询、配置、验证、部署、分析、契约设计、工程化、检索等。
- 禁止用"对象/领域"（名词，如"消息""数据""用户""代码""存储"）命名能力域。
- 禁止用具体产品名、项目名、组件名、任务名（如 opencode、TIM、BytePlus、Redis、DMS、SLS、msgcenter、某个具体改动）命名能力域。
- 相近能力合并，能力域总数控制在 8-12 个，宁粗勿细。
- 同一条目只属于一个能力域；不得加入输入中不存在的 childId。
- 无法归入任何能力的条目不输出。
- 全部简体中文。`;

const REDUCE_PROMPT = `你是能力域归并器。输入是不同批次各自发现的能力域候选，请合并语义相同/高度重叠的能力域，统一命名。

只输出 JSON：{"parents":[{"title":"统一能力域名","content":"统一说明","proposalIds":["proposal-id-1"]}]}

规则：
- 每个输入 proposalId 必须且只能出现一次。
- 语义相同或高度重叠的合并；不同能力保持独立。
- 能力域名必须是"能力/动词"（诊断、查询、配置、验证、部署、分析、契约、工程化、检索），禁止产品名、对象名、任务名。
- 全部简体中文。`;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

export function domainInterfaceId(title: string): string {
  return `mem_${hash(`domain\u0000${title.toLowerCase()}`).slice(0, 24)}`;
}

interface DomainProposal {
  id: string;
  title: string;
  content: string;
  childIds: string[];
}

export class DomainDiscoverer {
  constructor(
    private readonly database: Database,
    private readonly model: JsonModel = createConfiguredJsonModel(),
  ) {}

  async discover(): Promise<{ domains: number; assigned: number }> {
    const repository = new KnowledgeRepository(this.database);
    const implementations = repository.graph(false).entries
      .filter(({ role, status }) => role === "implementation" && status !== "rejected");
    if (implementations.length === 0) return { domains: 0, assigned: 0 };
    const byId = new Map(implementations.map((entry) => [entry.id, entry]));
    this.database.query("DELETE FROM entries WHERE role='interface' AND kind='能力域'").run();
    this.database.query("UPDATE entries SET domain=NULL WHERE role IN ('implementation','interface','abstract')").run();

    const ordered = seriate(implementations, (entry) => `${entry.title} ${entry.content.slice(0, 300)}`);
    const BATCH = 32;
    const CONCURRENCY = 4;
    const batches: MemoryEntry[][] = [];
    for (let offset = 0; offset < ordered.length; offset += BATCH) {
      batches.push(ordered.slice(offset, offset + BATCH));
    }
    const proposals: DomainProposal[] = [];
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= batches.length) break;
        const batch = batches[index] as MemoryEntry[];
        const input = batch.map((entry) => JSON.stringify({ id: entry.id, title: entry.title, content: entry.content.slice(0, 400) })).join("\n");
        const value = await this.model.generate(DOMAIN_PROMPT, input);
        const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const used = new Set<string>();
        for (const raw of Array.isArray(root.parents) ? root.parents : []) {
          const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          const title = text(item.title);
          const childIds = Array.isArray(item.childIds)
            ? [...new Set(item.childIds.filter((id): id is string => typeof id === "string" && byId.has(id) && !used.has(id)))]
            : [];
          if (!title || childIds.length < 2) continue;
          childIds.forEach((id) => used.add(id));
          proposals.push({ id: `d_${index}_${proposals.length}_${hash(title).slice(0, 8)}`, title, content: text(item.content), childIds });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));

    const domains = await this.reduceDomains(proposals);

    const now = Date.now();
    const insert = this.database.query(`
      INSERT INTO entries(id,title,content,role,kind,namespace,domain,contract,delta,tags,source_refs,status,confidence,valid_from,valid_to,created_at,updated_at)
      VALUES (?, ?, ?, 'interface', '能力域', 'global', ?, ?, '{}', ?, '[]', 'active', 1, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, domain=excluded.domain, updated_at=excluded.updated_at
    `);
    const updateDomain = this.database.query("UPDATE entries SET domain=?,updated_at=? WHERE id=?");
    let assigned = 0;
    this.database.transaction(() => {
      for (const domain of domains) {
        const id = domainInterfaceId(domain.title);
        insert.run(id, domain.title, domain.content, domain.title, JSON.stringify({}), JSON.stringify([]), now, now, now);
        for (const childId of domain.childIds) {
          updateDomain.run(domain.title, now, childId);
          assigned += 1;
        }
      }
    })();
    return { domains: domains.length, assigned };
  }

  private async reduceDomains(proposals: DomainProposal[]): Promise<DomainProposal[]> {
    if (proposals.length === 0) return [];
    let current = proposals;
    for (let round = 0; round < 4 && current.length > 12; round += 1) {
      const next = await this.reduceOnce(current);
      if (next.length >= current.length) break;
      current = next;
    }
    return current;
  }

  private async reduceOnce(proposals: DomainProposal[]): Promise<DomainProposal[]> {
    const CHUNK = 40;
    const chunks: DomainProposal[][] = [];
    for (let offset = 0; offset < proposals.length; offset += CHUNK) {
      chunks.push(proposals.slice(offset, offset + CHUNK));
    }
    const results = await Promise.all(chunks.map((chunk, index) => this.reduceChunk(chunk, index)));
    return results.flat();
  }

  private async reduceChunk(proposals: DomainProposal[], chunkIndex: number): Promise<DomainProposal[]> {
    const input = proposals.map((proposal) => JSON.stringify({ id: proposal.id, title: proposal.title, content: proposal.content })).join("\n");
    const value = await this.model.generate(REDUCE_PROMPT, input);
    const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const used = new Set<string>();
    const result: DomainProposal[] = [];
    for (const raw of Array.isArray(root.parents) ? root.parents : []) {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const proposalIds = Array.isArray(item.proposalIds)
        ? [...new Set(item.proposalIds.filter((id): id is string => typeof id === "string" && byId.has(id) && !used.has(id)))]
        : [];
      if (proposalIds.length === 0) continue;
      proposalIds.forEach((id) => used.add(id));
      const sources = proposalIds.map((id) => byId.get(id) as DomainProposal);
      result.push({
        id: `rd_${chunkIndex}_${result.length}`,
        title: text(item.title) || sources[0]?.title || "",
        content: text(item.content) || sources[0]?.content || "",
        childIds: [...new Set(sources.flatMap((source) => source.childIds))],
      });
    }
    for (const proposal of proposals) if (!used.has(proposal.id)) result.push({ ...proposal });
    return result;
  }
}
