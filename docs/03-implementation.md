# 03 实施指南

> 设计见 [02-design.md](02-design.md)。以下代码为**骨架/示意**，端点形状以你本地 `opencode serve` 的 OpenAPI（`http://127.0.0.1:4096/doc`）为准。

## 1. 项目结构

```
opencode-memory/
├── package.json            # TypeScript + Bun（与 opencode 同栈）
├── src/
│   ├── index.ts            # worker 入口：启动 canary → 主循环
│   ├── adapter/
│   │   ├── opencode.ts     # REST/SSE 客户端 + 事件名映射（v2 只改这里）
│   │   └── canary.ts       # 启动自检 + 静默失效告警
│   ├── pipeline/
│   │   ├── extract.ts      # 小模型结构化提取（写时判断）
│   │   ├── retrieve.ts     # 向量检索 top-k + 阈值
│   │   └── inject.ts       # REST noReply 注入
│   ├── store/
│   │   ├── db.ts           # 向量库 + 游标（libSQL 或 SQLite+vec）
│   │   └── schema.sql
│   └── config.ts
└── plugin/
    └── memory-bridge.ts    # 可选：opencode 超薄插件（事件转发，<50 行）
```

## 2. 依赖与模型选型

| 用途 | 推荐 | 依据 |
|---|---|---|
| 运行时 | Bun / Node 22+ | 与 opencode 同栈；worker 独立进程无硬性要求 |
| 提取/判断小模型 | claude-haiku-4.5 或 gpt-4o-mini（结构化输出） | opencode-mem 同款；也可走 OpenRouter/本地 |
| Embedding | 本地 `Xenova/nomic-embed-text-v1`（768d）或 `snowflake-arctic-embed-m-v1.5` | 前者 opencode-mem 在用，后者 episodic-memory 在用；零成本 |
| 向量库 | libSQL（Turso 本地文件，`vector_top_k`）或 SQLite+sqlite-vec | opencode-mem 用前者；MVP 甚至可 JSONL+暴力余弦 |
| （可选）检索时 rerank | 本地 qwen3-reranker-0.6b GGUF | qmd 在用，~10s——**只放 pull 工具路径** |

## 3. 核心代码骨架

### 3.1 适配层 `adapter/opencode.ts`（v2 唯一要改的文件）

```typescript
// 事件名映射表 —— v2 改名只动这里（#35054 / #40808 跟踪）
const IDLE_EVENTS = new Set([
  "session.idle",               // v1（dev 上已标 deprecated，但仍发布）
  "session.status",             // v1/v2：properties.type === "idle" 时算数
  "session.next.step.ended",    // v2 原生（durable 事件）
]);

export function isIdleEvent(ev: { type: string; properties?: any }): boolean {
  if (!IDLE_EVENTS.has(ev.type)) return false;
  if (ev.type === "session.status") return ev.properties?.type === "idle";
  return true;
}

const OC = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
// 若配了 OPENCODE_SERVER_PASSWORD，加 Authorization: Basic base64("opencode:"+pwd)

export async function listSessionStatus(): Promise<Record<string, { type: string }>> {
  const r = await fetch(`${OC}/session/status`);
  return r.json(); // { [sessionID]: {type: "idle"|"busy"|"retry"...} } —— 以 /doc 为准
}

export async function getMessages(sessionID: string, limit = 200) {
  const r = await fetch(`${OC}/session/${sessionID}/message?limit=${limit}`);
  return r.json() as Promise<{ info: any; parts: any[] }[]>;
}

// 注入：官方文档 "inject context without triggering AI response"
export async function injectContext(sessionID: string, text: string) {
  const r = await fetch(`${OC}/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      noReply: true,
      parts: [{ type: "text", text }],   // synthetic 标记是否支持以 /doc 为准
    }),
  });
  if (!r.ok) throw new Error(`inject failed: ${r.status}`);
}
```

### 3.2 写路径 `pipeline/extract.ts`

```typescript
// 小模型结构化提取：一次调用完成"提取 + 值不值得记"判断
const EXTRACT_PROMPT = `从技术对话中提取值得长期记忆的事实。
输出 JSON：{"memories":[{"summary":string,"type":"fact"|"preference"|"decision"|"skip","tags":[string]}]}
非技术性闲聊输出 type:"skip"。`;

export async function extractMemories(newMessagesText: string, model: string) {
  const r = await fetch(process.env.SMALL_LLM_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,                              // e.g. "claude-haiku-4.5" / "gpt-4o-mini"
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: newMessagesText },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const out = JSON.parse((await r.json()).choices[0].message.content);
  return out.memories.filter((m: any) => m.type !== "skip");
}
```

### 3.3 worker 主循环 `index.ts`（轮询模式）

```typescript
import { listSessionStatus, getMessages, isIdleEvent } from "./adapter/opencode.js";
import { extractMemories } from "./pipeline/extract.js";
import { upsertMemories, getCursor, setCursor } from "./store/db.js";

async function tick() {
  const status = await listSessionStatus();          // canary: 失败则告警
  for (const [sessionID, s] of Object.entries(status)) {
    if (s.type !== "idle") continue;
    const cursor = await getCursor(sessionID);       // 增量游标（防丢核心）
    const msgs = await getMessages(sessionID);
    const fresh = takeAfterCursor(msgs, cursor);     // 只取新消息
    if (fresh.length === 0) continue;
    try {
      const memories = await extractMemories(renderText(fresh), cfg.extract.model);
      await upsertMemories(memories, { sessionID, projectID: projectOf(msgs) });
      await setCursor(sessionID, lastId(msgs));      // 处理完才推进游标
    } catch (e) { /* 退避重试 + dead-letter，不抛 */ }
  }
}

setInterval(() => tick().catch(console.error), cfg.trigger.pollIntervalSec * 1000);
```

### 3.4 读路径 `pipeline/inject.ts`（首消息注入）

```typescript
export async function maybeInject(sessionID: string, userText: string) {
  if (await alreadyInjected(sessionID)) return;              // injectOn: "first"
  const hits = await searchSimilar(userText, {               // 向量检索
    topK: cfg.retrieve.topK,                                 // 默认 3
    threshold: cfg.retrieve.similarityThreshold,             // 默认 0.6
    excludeSession: sessionID,
  });
  if (hits.length === 0) return;
  const block = `<memory>\n${hits.map(h => `- ${h.summary}`).join("\n")}\n</memory>`;
  await injectContext(sessionID, block.slice(0, cfg.inject.maxChars));
  await markInjected(sessionID);
}
// 触发点：轮询发现"有新用户消息但未注入过"的会话；或由 bridge 插件转发 message.updated
```

### 3.5 可选超薄插件 `plugin/memory-bridge.ts`（替代轮询的实时触发）

```typescript
// 放到 ~/.config/opencode/plugins/memory-bridge.ts
// event hook 是 fire-and-forget（运行时不 await），fetch 失败静默降级给轮询兜底
export const MemoryBridge = async () => ({
  event: async ({ event }: any) => {
    if (["session.idle", "session.status"].includes(event.type)) {
      fetch("http://127.0.0.1:7700/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }).catch(() => {});   // 不 await 结果，绝不阻塞
    }
  },
});
```

### 3.6 数据模型 `store/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  type TEXT NOT NULL,               -- fact | preference | decision
  tags TEXT,                        -- JSON array
  session_id TEXT, project_id TEXT,
  created_at INTEGER NOT NULL,
  embedding F32_BLOB(768)           -- libSQL vector 列
);
CREATE INDEX IF NOT EXISTS idx_memories_vec ON memories (libsql_vector_idx(embedding));

CREATE TABLE IF NOT EXISTS cursors (  -- 防丢游标
  session_id TEXT PRIMARY KEY,
  last_message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## 4. 部署形态

1. **前提**：`opencode serve --port 4096` 常驻（launchd/systemd 管理）。注意 CVE-2026-22812 后 server 默认不再静默启动，需显式开启；建议设 `OPENCODE_SERVER_PASSWORD`。
2. **worker** 同机常驻即可；无 server 可用时退化为：bridge 插件触发 + 直接读存储（v1：`~/.local/share/opencode/storage/` 下 JSON；v2：`opencode.db` SQLite——注意 next 通道不导入旧数据，#41217）。
3. **版本策略**：锁定 opencode 版本用于日常；升级前跑一遍 §5 的回归。

## 5. 测试与 canary

- **启动自检**：`GET /session/status` 可达 + 能列出 session → 否则告警退出。
- **静默失效 canary**：连续 N 分钟（N≈2×轮询周期）没有任何 status 事件/会话变化 → 告警（#40808 的教训：改名后订阅"照常注册但永不触发"）。
- **回归脚本**：手动触发一次 `POST /session/:id/prompt {noReply:true}` → 确认消息出现在 `GET /session/:id/message` 且未触发 LLM 回复。
- **端到端**：开测试会话说几句话 → 等一个轮询周期 → 断言向量库有新记忆 + 新会话被注入。

## 6. 坑清单（逐条核对）

- [ ] transform hook（若将来用）必须**原地突变**，重赋值静默失效（PR #32758 未合入）
- [ ] transform hook 会在 subagent/标题生成时触发 → 按 agent 签名过滤（参考 DCP `INTERNAL_AGENT_SIGNATURES`）
- [ ] 命名 hook 全部 awaited 且无超时 → 重活只放 `event` hook / worker（#39031）
- [ ] `session.idle` 已 deprecated → 事件名走配置映射，同时监听 `session.status{type:"idle"}`
- [ ] 无 `session.end` → 用"增量游标 + deleted/shutdown flush"，别等终极结束信号
- [ ] 每轮变化注入会打破 prompt cache → 默认首消息注入一次
- [ ] 插件与 agent 同进程、全权限 → 插件壳保持 <50 行，逻辑全在 worker
- [ ] v2 next 通道存储已 SQLite 化且不导旧数据（#41217）→ 别依赖文件布局，优先 REST

## 7. 路线图

| 阶段 | 内容 | 验收 |
|---|---|---|
| MVP | 轮询触发 + 写时提取 + 向量库 + 手动查询 CLI | 会话结束 1 分钟内入库 |
| v0.2 | 首消息 noReply 注入 + memory 搜索工具 | 新会话首条消息带相关记忆 |
| v0.3 | bridge 插件实时触发 + canary + 回归脚本 | 注入延迟 <5s；升级回归通过 |
| v1.0 | 可选：检索时小模型复核（每条用户消息一次档）；pull 路径 rerank | 复核不增加可感知延迟 |
| v2 适配 | opencode v2 发布后：改事件名映射；评估 Effect 插件重写注入层 | 只动 adapter/ |

## 8. 跟踪清单

- [#35054](https://github.com/anomalyco/opencode/issues/35054) — V1 事件面移除时间表（触发适配）
- [#40808](https://github.com/anomalyco/opencode/issues/40808) — 事件改名静默失效/shim
- [#34546](https://github.com/anomalyco/opencode/issues/34546) — v2 插件 API 定稿（决定注入层是否升级）
- [#35540](https://github.com/anomalyco/opencode/issues/35540) / [#28695](https://github.com/anomalyco/opencode/issues/28695) — 正式生命周期 hook（落地可简化设计）
- [#31680](https://github.com/anomalyco/opencode/issues/31680) — `tool.execute.before` 突变失效（若用到工具拦截）
