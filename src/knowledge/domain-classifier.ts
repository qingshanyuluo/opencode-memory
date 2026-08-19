import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import { CANONICAL_DOMAINS } from "./domains.ts";

const DOMAIN_IDS = new Set(CANONICAL_DOMAINS.map((domain) => domain.id));

const DOMAIN_PROMPT = `你是知识领域分类器。给定一批长期知识条目，判断每条属于哪个能力域。

能力域（只能从这些 id 中选择）：
${CANONICAL_DOMAINS.map((domain) => `- ${domain.id}：${domain.description}`).join("\n")}

只输出 JSON：{"verdicts":[{"id":"<entry_id>","domain":"<能力域id 或 null>"}]}

规则：
- domain 必须从上述能力域 id 中选；确实无法归入任何域的填 null。
- 依据是"这条知识在讲什么/排查什么/验证什么"，不是只看关键词；即使没有命中任何关键词，也要按语义归类。
- 每条条目只属于一个域；对每条都给出 verdict，不要遗漏。
- 全部简体中文。`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

export interface ClassifiableEntry {
  id: string;
  title: string;
  content: string;
  kind: string | null;
  tags: string;
}

function entryText(entry: ClassifiableEntry): string {
  return JSON.stringify({ id: entry.id, title: entry.title, content: entry.content.slice(0, 400), kind: entry.kind ?? "", tags: entry.tags ?? "" });
}

function validateVerdicts(value: unknown, batch: ClassifiableEntry[]): Array<{ id: string; domain: string | null }> {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const byId = new Set(batch.map((entry) => entry.id));
  const seen = new Set<string>();
  const verdicts: Array<{ id: string; domain: string | null }> = [];
  for (const raw of Array.isArray(root.verdicts) ? root.verdicts : []) {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const id = text(item.id);
    const domain = text(item.domain);
    if (!id || !byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    verdicts.push({ id, domain: domain && DOMAIN_IDS.has(domain) ? domain : null });
  }
  return verdicts;
}

export async function classifyDomainsByLLM(
  entries: ClassifiableEntry[],
  model: JsonModel = createConfiguredJsonModel(),
  database?: Database,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const BATCH = 30;
  const CONCURRENCY = 4;
  const batches: ClassifiableEntry[][] = [];
  for (let offset = 0; offset < entries.length; offset += BATCH) {
    batches.push(entries.slice(offset, offset + BATCH));
  }

  const pending: Array<ClassifiableEntry[]> = [];
  for (const batch of batches) {
    if (!database) { pending.push(batch); continue; }
    const input = batch.map(entryText).join("\n");
    const cacheKey = hash(`${model.id}\u0000${input}`);
    const cached = database.query<{ payload: string }, [string]>("SELECT payload FROM hierarchy_cache WHERE stage='domain' AND input_hash=?").get(cacheKey);
    if (cached) {
      for (const verdict of validateVerdicts(JSON.parse(cached.payload), batch)) result.set(verdict.id, verdict.domain);
    } else {
      pending.push(batch);
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) break;
      const batch = pending[index] as ClassifiableEntry[];
      const input = batch.map(entryText).join("\n");
      const value = await model.generate(DOMAIN_PROMPT, input);
      const verdicts = validateVerdicts(value, batch);
      if (database) {
        const cacheKey = hash(`${model.id}\u0000${input}`);
        database.query("INSERT OR REPLACE INTO hierarchy_cache(stage,input_hash,payload,created_at) VALUES ('domain',?,?,?)")
          .run(cacheKey, JSON.stringify(verdicts), Date.now());
      }
      for (const verdict of verdicts) result.set(verdict.id, verdict.domain);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
  return result;
}
