import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import { KnowledgeRepository } from "./repository.ts";

const PRUNE_PROMPT = `你是记忆价值审裁员。唯一判断标准是【恢复成本】：如果 agent 完全忘掉这条记忆，靠错误信息、命令 help、官方文档、或一次简单搜索，能否在“一步之内”直接得到答案？

- 能“一步之内”恢复（编译器/报错直接告诉你、命令 --help 直接可查、官方文档一句话、基础语法常识）→ 剪除（keep=false）。
- 需要多步推理、实验归纳、跨数据源交叉、或抽象提炼才能得到的结论 → 保留（keep=true）。

特别注意，下面这些【必须保留，绝不要因为它们“通用/无项目名”就剪除】：
- 抽象方法论、架构原则、审查模式、设计模式（例如“两阶段生成-选择实现”“结构化代码审查排序”“gRPC 容量估算”）——它们是经验归纳，恢复成本高；
- 任何含项目/平台特定锚点的内容（日志库名、缓存 key、表名、地域、数据源标识、端点、端口、集群名等）。

剪除的正确例子：
- “Java 注释避免字面量 */ 提前闭合” → 剪除：编译器立即报错。
- “git revert -m 1 回退被误合并的 PR” → 剪除：git 标准命令，help 可查。
- “gh pr view 查看 PR 状态” → 剪除：官方命令文档直接可查。

保留的正确例子：
- “两阶段生成-选择实现模式” → 保留：抽象方法论，需实验归纳。
- “某个存储/中间件跨实例操作会报错、某日志系统按特定维度定位”这类踩坑 + 项目特定锚点 → 保留。

只输出 JSON：{"verdicts":[{"id":"<entry_id>","keep":true,"reason":"一句话理由"}]}
对输入的每一条都必须给出 verdict，不要遗漏。有疑问时保留。`;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface PruneCandidate {
  id: string;
  title: string;
  content: string;
  kind: string | null;
}

export class KnowledgePruner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly model: JsonModel = createConfiguredJsonModel(),
    private readonly debounceMs = Number.parseInt(Bun.env.OPENCODE_MEMORY_PRUNE_DEBOUNCE_MS ?? "1200000", 10),
  ) {}

  request(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run().catch((error) => console.error("knowledge pruning failed", error)), this.debounceMs);
  }

  selectCandidates(): PruneCandidate[] {
    const rows = this.database.query<PruneCandidate, []>(`
      SELECT e.id, e.title, e.content, e.kind
      FROM entries e
      WHERE e.valid_to IS NULL
        AND e.status IN ('generated','active')
        AND e.role NOT IN ('instance','interface','abstract','resource')
        AND length(e.content) < 220
        AND (SELECT count(*) FROM entry_origins o WHERE o.entry_id = e.id) <= 1
    `).all();
    return rows;
  }

  async run(): Promise<{ pruned: number; kept: number }> {
    if (this.running) return { pruned: 0, kept: 0 };
    this.running = true;
    try {
      const candidates = this.selectCandidates();
      let pruned = 0;
      let kept = 0;
      const BATCH = 40;
      for (let offset = 0; offset < candidates.length; offset += BATCH) {
        const batch = candidates.slice(offset, offset + BATCH);
        const lines = batch.map((entry) => `id=${entry.id} kind=${entry.kind ?? ""} title=${entry.title}\n${entry.content}`).join("\n---\n");
        const value = await this.model.generate(PRUNE_PROMPT, lines);
        const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
        for (const raw of Array.isArray(root.verdicts) ? root.verdicts : []) {
          const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          const id = text(item.id);
          const keep = item.keep === true;
          const reason = text(item.reason);
          if (!id) continue;
          if (keep) kept += 1;
          else pruned += this.prune(id, reason || "低价值：试错恢复成本与召回成本相当");
        }
      }
      new KnowledgeRepository(this.database).rebuildFts();
      return { pruned, kept };
    } finally {
      this.running = false;
    }
  }

  prune(id: string, reason: string): number {
    return this.database.query(`
      UPDATE entries SET status = 'rejected', review_note = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('generated','active') AND valid_to IS NULL
    `).run(reason, Date.now(), Date.now(), id).changes;
  }
}
