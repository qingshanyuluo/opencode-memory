import { CryptoHasher } from "bun";
import type { Database } from "bun:sqlite";
import { createConfiguredJsonModel, type JsonModel } from "../behavior/model.ts";
import type { EpisodeBehavior } from "../dashboard/behavior-repository.ts";
import { MEMORY_ROLES, STRUCTURAL_RELATIONS, type KnowledgeProposal, type KnowledgeProposalEntry, type KnowledgeProposalLink } from "./types.ts";
import type { RecurringTerm } from "./recurrence.ts";
import { insertStructuralRelation } from "./relations.ts";

const ORGANIZER_PROMPT = `你负责从带证据的 coding-agent 行为图中整理“长期可复用的方法知识”，不是复述业务事实。

所有 title、content、kind、namespace、tags、relation 字段必须使用简体中文；代码标识符、配置 key 和产品专名保持原文。只输出合法 JSON：
{
  "entries": [{
    "localId": "k1",
    "title": "简短易读标题",
    "content": "长期知识：什么是真的、为什么、何时使用、重要边界",
    "role": "implementation 或 resource",
    "kind": "自由业务类别，例如排障规程、平台手册、工具坑",
    "namespace": "使用提供的项目命名空间，或更窄且稳定的中文主题",
    "contract": {"triggers": ["何时使用"], "inputs": ["需要什么"], "outputs": ["应得到什么"], "verification": ["如何验真"]},
    "delta": {"steps": ["具体项目步骤"], "overrides": {}, "boundaries": ["边界"]},
    "tags": ["可检索词"],
    "confidence": 0.0,
    "sourceSequences": [3, 4]
  }],
  "links": [{"source":"k1","target":"k2","relation":"REFERENCES"}]
}

规则：
- 产出 1-6 个 implementation（通常 2-6 个；单一主题会话允许只产出 1 个高质量实现）；可额外产出 0-5 个被多个实现引用的 resource。禁止只产 resource。
- 每条必须同时通过三个问题：30 天后是否仍大概率有效？换一个具体需求是否仍能复用？是否能显著减少下一次探索/试错？任一为否则跳过。
- 宁粗勿细：同一方法的多个连续步骤、同一条排障链路上的多个动作，应合并为一条完整规程，不要拆成 2-3 条碎片；目标是"一条知识就能指导一次完整复用"。
- 优先晋升：平台怎么查/怎么验证、稳定的代码库约定、反复使用的排障顺序、工具的可靠用法、被多次证伪的死路、可复用的验证方法。
- 将具体业务事实上升为方法。例如不要记“某用户掉出某实验”，应记“aichat-v2 中如何判断 BytePlus 用户是对照组、未分桶还是受众变更；需要查哪些日志/配置/状态”。
- 跳过：业务参数具体值、临时实验状态、用户 ID、PR/commit、当前分支、一次性实现细节、某个功能此刻的行为规则、进度播报和机械日志。
- 只有源图与复现统计支持时，才能把具体尝试提升为平台/项目手册。复现次数高不是充分条件，但说明值得提炼。
- 规程必须有成功结果证据；坑必须有具体失败动作或反证。
- 每条 entry 必须引用行为图中真实 sourceSequences，不得虚构编号。
- 明确适用边界和时效假设，绝不包含凭据或秘密。
- namespace 优先沿用提供的项目 namespace。
- 数据库连接/DMS/SLS/kubectl/Nacos/Redis/BytePlus 等跨项目平台手册或工具坑，namespace 使用 personal；只适用于某仓库的实现仍使用项目 namespace。
- 再次强调：除代码与专名外，输出必须是简体中文。`;

const CURATOR_PROMPT = `你是长期知识库的严格主编。输入包含候选知识、行为证据和跨会话复现统计。请删除短命、过细、互相重复的条目，并把能上升的方法合并重写。

只输出与候选相同 JSON 结构。约束：
- 最终保留 1-6 个 implementation，resource 仅作为共享依赖；宁缺毋滥但禁止用“...”占位。
- 用“恢复成本”复核：如果这条知识靠命令 --help、官方文档一句话、或一次简单搜索就能一步得到，说明没有长期记忆价值，应删除（即使它看起来像方法）。
- 目标 2-4 个 implementation 为常态；超过 4 个必须每条都有不可合并的独立复用价值。
- 必须能用于不同的具体需求，而不仅是原会话的同一功能。
- 必须大概率 30 天后仍有效，或明确说明需验证的边界。
- 优先晋升：跨需求可复用的排障规程、平台手册（数据库/日志/缓存/配置/部署）、稳定代码库约定、反复使用的工具用法、被多次证伪的死路。
- 删除或上升：具体用户、临时 PR/commit、某个业务功能的 timer/阈值/选人规则、当前实验开关、一次性产品口径。
- “某功能当前如何实现”通常不是长期知识；“遇到这类问题按什么证据顺序排查、哪些路径不要再试”才是。
- 可将多个窄条目合并为一个平台手册或排障规程。
- 每条仍必须引用输入中真实 sourceSequences；不得新增不存在的编号。
- role 仅允许 implementation/resource；方法知识是 implementation，外部平台/表/key/命令等依赖是 resource。
- 当前阶段结构关系只允许 REFERENCES。IMPLEMENTS/EXTENDS 由跨实现深度重构产生。
- 禁止把某个业务组件当前的状态机、参数、触发规则包装成长期知识。若无法上升为跨需求的方法，必须删除。
- 全部使用简体中文（代码标识符和专名除外）。`;

const MEDIUM_ROLES = new Set(["implementation", "resource"]);

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateProposal(value: unknown, behavior: EpisodeBehavior, defaultNamespace: string): KnowledgeProposal {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const validSequences = new Set(behavior.nodes.map(({ sequence }) => sequence + 1));
  const entries: KnowledgeProposalEntry[] = [];
  for (const raw of Array.isArray(object.entries) ? object.entries : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const title = string(entry.title);
    const content = string(entry.content);
    const localId = string(entry.localId) || `k${entries.length + 1}`;
    const role = string(entry.role);
    const kind = string(entry.kind) || "方法知识";
    const namespace = string(entry.namespace) || defaultNamespace;
    const contract = entry.contract && typeof entry.contract === "object" && !Array.isArray(entry.contract)
      ? entry.contract as Record<string, unknown> : {};
    const delta = entry.delta && typeof entry.delta === "object" && !Array.isArray(entry.delta)
      ? entry.delta as Record<string, unknown> : {};
    const tags = Array.isArray(entry.tags)
      ? [...new Set(entry.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))].slice(0, 12)
      : [];
    const sourceSequences = Array.isArray(entry.sourceSequences)
      ? [...new Set(entry.sourceSequences.filter((sequence): sequence is number => Number.isInteger(sequence) && validSequences.has(sequence)))]
      : [];
    if (title.length < 4 || content.length < 80 || title === "..." || content === "..." || !MEDIUM_ROLES.has(role) || sourceSequences.length === 0) continue;
    if (role === "implementation" && Object.keys(contract).length === 0 && Object.keys(delta).length === 0) continue;
    const confidence = typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.5;
    entries.push({ localId, title, content, role: role as KnowledgeProposalEntry["role"], kind, namespace, contract, delta, tags, confidence, sourceSequences });
  }

  const ids = new Set(entries.map(({ localId }) => localId));
  const links: KnowledgeProposalLink[] = [];
  for (const raw of Array.isArray(object.links) ? object.links : []) {
    if (!raw || typeof raw !== "object") continue;
    const link = raw as Record<string, unknown>;
    const source = string(link.source);
    const target = string(link.target);
    const relation = string(link.relation);
    if (source && target && source !== target && relation === "REFERENCES" && ids.has(source) && ids.has(target)) {
      links.push({ source, target, relation });
    }
  }
  if (entries.filter(({ role }) => role === "implementation").length < 1) {
    throw new Error(`organizer returned no valid implementations: ${JSON.stringify(value).slice(0, 2_000)}`);
  }
  return { entries, links };
}

function entryId(entry: KnowledgeProposalEntry): string {
  const hasher = new CryptoHasher("sha256");
  hasher.update(`${entry.namespace.toLowerCase()}\u0000${entry.role}\u0000${entry.kind.toLowerCase()}\u0000${entry.title.toLowerCase()}`);
  return `mem_${hasher.digest("hex").slice(0, 24)}`;
}

export async function proposeKnowledge(
  behavior: EpisodeBehavior,
  namespace: string,
  recurrence: RecurringTerm[] = [],
  model: JsonModel = createConfiguredJsonModel(),
): Promise<KnowledgeProposal> {
  const preferredTypes = new Set(["goal", "hypothesis", "evidence", "revision", "decision", "outcome", "open_question"]);
  const recurringTerms = recurrence.filter((item) => item.sameDirectorySessions >= 2).map(({ term }) => term.toLowerCase());
  const selected = behavior.nodes
    .filter((node) => preferredTypes.has(node.type) && (node.confidence >= 0.8 || node.type === "revision" || node.type === "decision"))
    .map((node) => {
      const content = node.content.toLowerCase();
      const recurrenceScore = recurringTerms.reduce((score, term) => score + (content.includes(term) ? 3 : 0), 0);
      const typeScore = node.type === "revision" ? 6
        : node.type === "decision" ? 5
          : node.type === "evidence" ? 4
            : node.type === "outcome" ? 3
              : 1;
      return { node, score: recurrenceScore + typeScore + node.confidence };
    })
    .sort((left, right) => right.score - left.score || left.node.sequence - right.node.sequence)
    .slice(0, 100)
    .map(({ node }) => node)
    .sort((left, right) => left.sequence - right.sequence);
  const graph = selected.map((node) =>
    `#${node.sequence + 1} [${node.type}/${node.status}/${Math.round(node.confidence * 100)}%] ${node.content}`
  ).join("\n");
  const recurrenceText = recurrence.map((item) =>
    `${item.term}: all_sessions=${item.sessions}, same_project=${item.sameDirectorySessions}`
  ).join("\n");
  const existingContext = `SESSION: ${behavior.capsule.title}\nNAMESPACE: ${namespace}\nOUTCOME: ${behavior.capsule.outcome}\n\nCROSS-SESSION RECURRENCE SIGNALS:\n${recurrenceText || "none"}\n\nBEHAVIOR GRAPH:\n${graph}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const draft = validateProposal(await model.generate(ORGANIZER_PROMPT, existingContext), behavior, namespace);
      return validateProposal(
        await model.generate(CURATOR_PROMPT, `${existingContext}\n\n候选知识：\n${JSON.stringify(draft, null, 2)}\n\n这是第 ${attempt} 次尝试，请严格满足对象数量和字段约束。`),
        behavior,
        namespace,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function saveKnowledge(
  database: Database,
  sourceId: string,
  sessionId: string,
  behavior: EpisodeBehavior,
  proposal: KnowledgeProposal,
): string[] {
  const now = Date.now();
  const ids = new Map<string, string>();
  database.transaction(() => {
    const oldIds = database.query<{ entry_id: string }, [string, string]>(`
      SELECT o.entry_id FROM entry_origins o JOIN entries e ON e.id = o.entry_id
      WHERE o.source_id = ? AND o.session_id = ? AND e.status = 'generated'
    `,
    ).all(sourceId, sessionId).map(({ entry_id }) => entry_id);
    database.query(`
      DELETE FROM entry_origins WHERE source_id = ? AND session_id = ?
      AND entry_id IN (SELECT id FROM entries WHERE status = 'generated')
    `).run(sourceId, sessionId);
    for (const id of oldIds) {
      const remaining = database.query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM entry_origins WHERE entry_id = ?",
      ).get(id)?.count ?? 0;
      const status = database.query<{ status: string }, [string]>("SELECT status FROM entries WHERE id = ?").get(id)?.status;
      if (remaining === 0 && status === "generated") database.query("DELETE FROM entries WHERE id = ?").run(id);
    }

    const insertEntry = database.query(`
      INSERT INTO entries(
        id, title, content, role, kind, namespace, contract, delta, tags, source_refs, status,
        confidence, valid_from, valid_to, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = CASE WHEN entries.status = 'generated' THEN excluded.title ELSE entries.title END,
        content = CASE WHEN entries.status = 'generated' THEN excluded.content ELSE entries.content END,
        role = CASE WHEN entries.status = 'generated' THEN excluded.role ELSE entries.role END,
        contract = CASE WHEN entries.status = 'generated' THEN excluded.contract ELSE entries.contract END,
        delta = CASE WHEN entries.status = 'generated' THEN excluded.delta ELSE entries.delta END,
        tags = CASE WHEN entries.status = 'generated' THEN excluded.tags ELSE entries.tags END,
        source_refs = excluded.source_refs,
        confidence = max(entries.confidence, excluded.confidence),
        updated_at = excluded.updated_at
    `);
    const insertOrigin = database.query(`
      INSERT OR REPLACE INTO entry_origins(entry_id, source_id, session_id, source_node_ids, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const entry of proposal.entries) {
      const id = entryId(entry);
      ids.set(entry.localId, id);
      const nodeIds = entry.sourceSequences.flatMap((sequence) => {
        const node = behavior.nodes.find((candidate) => candidate.sequence + 1 === sequence);
        return node ? [node.id] : [];
      });
      const refs = [{ sourceId, sessionId, nodeIds }];
      insertEntry.run(
        id, entry.title, entry.content, entry.role, entry.kind, entry.namespace,
        JSON.stringify(entry.contract), JSON.stringify(entry.delta),
        JSON.stringify(entry.tags), JSON.stringify(refs), entry.confidence,
        now, now, now,
      );
      insertOrigin.run(id, sourceId, sessionId, JSON.stringify(nodeIds), now);
    }

    for (const link of proposal.links) {
      const source = ids.get(link.source);
      const target = ids.get(link.target);
      if (source && target) insertStructuralRelation(database, source, target, link.relation, now);
    }

    database.query(`
      DELETE FROM links
      WHERE source_entry_id NOT IN (SELECT id FROM entries)
         OR target_entry_id NOT IN (SELECT id FROM entries)
    `).run();

    database.query("DELETE FROM entries_fts").run();
    database.query(`
      INSERT INTO entries_fts(entry_id, title, content, role, kind, namespace, domain, tags)
      SELECT id, title, content, role, coalesce(kind,''), coalesce(namespace,''), coalesce(domain,''), tags FROM entries
      WHERE status IN ('generated','active') AND valid_to IS NULL
    `).run();
  })();
  return [...ids.values()];
}
