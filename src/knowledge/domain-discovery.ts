import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import { KnowledgeRepository, type MemoryEntry } from "./repository.ts";
import { seriate } from "../similarity/bigram.ts";

const DOMAIN_PROMPT = `你是知识能力域发现器。输入一批知识条目，请把它们聚成若干"能力域"（粗粒度的、跨项目可复用的能力主题，例如：日志诊断、数据查询、配置管理、部署发布、消息链路排障、代码库分析、验证评测、服务契约等）。

只输出 JSON：{"parents":[{"title":"能力域名","content":"能力域说明：解决什么问题、边界","contract":{"triggers":[],"inputs":[],"outputs":[],"invariants":[],"verification":[]},"tags":[],"confidence":0.0,"childIds":["entry-id-1","entry-id-2"]}]}

规则：
- 能力域是粗粒度主题，每域通常 5-40 个成员；宁粗勿细，尽量聚成 3-12 个能力域。
- 同一条目只属于一个能力域。
- 能力域名要抽象、稳定、跨项目可复用；禁止具体实现名、项目名、表名、文件路径。
- 不得加入输入中不存在的 childId。
- 无法归入任何能力域的条目不输出。
- 全部简体中文。`;

const REDUCE_PROMPT = `你是能力域归并器。输入是不同批次各自发现的能力域候选，请合并语义相同/高度重叠的能力域，统一命名。

只输出 JSON：{"parents":[{"title":"统一能力域名","content":"统一说明","proposalIds":["proposal-id-1"]}]}

规则：
- 每个输入 proposalId 必须且只能出现一次。
- 语义相同或高度重叠的合并；不同能力域保持独立。
- 能力域名要抽象、稳定、跨项目可复用。
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
    const updateDomain = this.database.query("UPDATE entries SET domain=?,updated_at=? WHERE id=?");
    let assigned = 0;
    this.database.transaction(() => {
      for (const domain of domains) {
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
        id: domainInterfaceId(text(item.title) || sources[0]?.title || ""),
        title: text(item.title) || sources[0]?.title || "",
        content: text(item.content) || sources[0]?.content || "",
        childIds: [...new Set(sources.flatMap((source) => source.childIds))],
      });
    }
    for (const proposal of proposals) if (!used.has(proposal.id)) result.push({ ...proposal, id: domainInterfaceId(proposal.title) });
    return result;
  }
}
