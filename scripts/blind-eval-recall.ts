import { loadConfig } from "../src/config.ts";
import { openMemoryDatabase } from "../src/store/database.ts";
import { KnowledgeRepository } from "../src/knowledge/repository.ts";
import { createConfiguredJsonModel } from "../src/behavior/model.ts";

const BLIND_PROMPT = `你是知识召回质量盲评员。给定一条 agent 的真实查询，以及该查询召回的若干条记忆条目，请逐条判断它对"减少试错成本"的价值。

判断标准（恢复成本视角）：
- high_value（能减少试错）：含项目/平台特定锚点（表名、logstore、Redis key、region、端口、集群名、dataId、endpoint）、踩坑归纳、多步排障规程、稳定代码库约定、被证伪的死路、抽象方法论。agent 忘了它，需要多步实验或跨数据源交叉才能重新得出。
- 反例（不能减少试错）：靠命令 --help、官方文档一句话、编译器报错、一次简单搜索就能一步恢复的通用常识或标准命令。

另外判断 relevant（相关性）：这条召回是否与查询意图相关（部分相关也算相关）。

只输出 JSON：{"verdicts":[{"id":"<entry_id>","relevant":true,"high_value":true,"reason":"一句话"}]}
对每条召回都必须给出 verdict，不要遗漏。全部简体中文。`;

function text(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

const config = loadConfig();
const db = openMemoryDatabase(config.memoryDbPath);
db.exec("PRAGMA busy_timeout = 15000");
const repo = new KnowledgeRepository(db);
const model = createConfiguredJsonModel();

const queries = db.query<{ query: string; count: number }, []>(`
  SELECT query, count(*) AS count FROM memory_recalls
  WHERE query NOT LIKE '%盲评%' AND query NOT LIKE '%召回 验证%' AND query NOT LIKE '%命中率%'
  GROUP BY query ORDER BY max(recalled_at) DESC LIMIT 20
`).all();

const order: Record<string, number> = { interface: 0, abstract: 1, implementation: 2, resource: 3, instance: 4 };

const tsv: string[] = ["query\trecalled\trelevant\thigh_value\tentry_id\trole\ttitle"];
let recallWithRelevant = 0;
let recallWithHighValue = 0;
let totalRelevant = 0;
let totalHighValue = 0;
let totalEntries = 0;

const CONCURRENCY = 4;
let cursor = 0;
const results: Array<{ query: string; entries: number; relevant: number; highValue: number; rows: string[] }> = [];
const worker = async () => {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= queries.length) break;
    const { query } = queries[index] as { query: string; count: number };
    const loaded = repo.load(query, { mode: "auto", depth: 2, limit: 6 });
    const entries = loaded.entries
      .filter((e) => e.role !== "instance")
      .sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9))
      .slice(0, 8);
    if (entries.length === 0) {
      results[index] = { query, entries: 0, relevant: 0, highValue: 0, rows: [`${query}\t0\t0\t0\t\t\t(无召回)`] };
      continue;
    }
    const input = entries.map((e) => JSON.stringify({ id: e.id, title: e.title, content: e.content.slice(0, 200), role: e.role, kind: e.kind, tags: e.tags.slice(0, 6) })).join("\n");
    const value = await model.generate(BLIND_PROMPT, `查询：${query}\n\n召回条目：\n${input}`);
    const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const byId = new Map(entries.map((e) => [e.id, e]));
    let relevant = 0;
    let highValue = 0;
    const verdicts = Array.isArray(root.verdicts) ? root.verdicts : [];
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const raw of verdicts) {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const id = text(item.id);
      if (!id || !byId.has(id) || seen.has(id)) continue;
      seen.add(id);
      const rel = item.relevant === true;
      const hv = item.high_value === true;
      if (rel) relevant += 1;
      if (hv) highValue += 1;
      const entry = byId.get(id)!;
      rows.push(`${query}\t${entries.length}\t${rel ? 1 : 0}\t${hv ? 1 : 0}\t${id}\t${entry.role}\t${entry.title}`);
    }
    results[index] = { query, entries: entries.length, relevant, highValue, rows };
  }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queries.length) }, () => worker()));

for (const r of results) {
  if (!r) continue;
  totalEntries += r.entries;
  totalRelevant += r.relevant;
  totalHighValue += r.highValue;
  if (r.relevant > 0) recallWithRelevant += 1;
  if (r.highValue > 0) recallWithHighValue += 1;
  tsv.push(...r.rows);
}

const summary = {
  queries: queries.length,
  avgEntriesPerRecall: Number((totalEntries / queries.length).toFixed(1)),
  relevantRecallRate: Number((recallWithRelevant / queries.length).toFixed(2)),
  highValueRecallRate: Number((recallWithHighValue / queries.length).toFixed(2)),
  relevantEntryRate: Number((totalRelevant / Math.max(1, totalEntries)).toFixed(2)),
  highValueEntryRate: Number((totalHighValue / Math.max(1, totalEntries)).toFixed(2)),
};
console.log(JSON.stringify(summary, null, 2));
const out = `${import.meta.dir}/../.blind-eval-recall.tsv`;
await Bun.write(out, tsv.join("\n") + "\n");
console.log(`TSV -> ${out}`);
db.close();
