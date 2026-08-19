# 02 插件设计

> 依据：[01-research.md](01-research.md)。核心约束：**会话结束后异步执行，不挂前台；v2 切换时改动最小。**

## 1. 需求与约束

| 需求 | 设计响应 |
|---|---|
| 会话结束后异步提取记忆 | `session.idle` 事件 / 轮询 `GET /session/status` 触发，worker 进程外执行 |
| 不挂前台 | 触发层 fire-and-forget；重活（提取、判断、写库）全部在独立 worker |
| 检索 → 小模型判断 → 注入主任务 | 判断**前置到写时/异步预计算**；注入时只做检索+拼接（权衡见 §4） |
| v2 来了也能用 | 耦合收敛到 <100 行适配层；只用 REST/SSE 稳定面，不碰 transform hook |

## 2. 总体架构

```
┌─ opencode（v1.18.x / 将来 v2）────────────────────────┐
│                                                        │
│  [触发面，二选一或并存]                                 │
│   A. opencode serve --port 4096（SSE /event + REST）   │
│   B. 超薄插件 memory-bridge.ts（<50 行，可选）          │
│      event hook 收到 session.idle → POST 给 worker     │
│      （event hook 是 fire-and-forget，不阻塞前台）      │
└───────┬──────────────────────────────▲─────────────────┘
        │ 触发 / 拉转录                 │ 注入
        ▼                              │
┌────────────────────────────────────────────────────────┐
│  memory worker（独立进程，全部业务逻辑在这里）           │
│                                                        │
│  ┌─ adapter/（适配层，v2 只改这里）                     │
│  │   - 事件名映射：session.idle → session.status{idle} │
│  │     → session.next.step.ended（配置驱动）           │
│  │   - REST 封装：status / messages / prompt(noReply)  │
│  │   - canary 自检（防 #40808 式静默失效）             │
│  └─────────────────────────────────────────────────────┘
│                                                        │
│  写路径：拉增量消息 → 小模型结构化提取（含 skip）→ 向量库 │
│  读路径：检索 top-k →（可选小模型复核）→ REST 注入       │
└────────────────────────────────────────────────────────┘
```

设计要点：**核心资产（提取管线、判断逻辑、向量库）与 opencode 零耦合**，v2 切换、甚至迁去 pi（`before_agent_start`/`context` 事件）都只动适配层。

## 3. 写路径（会话结束 → 记忆入库）

```
触发（A 轮询 30s / B 插件转发 session.idle）
  → GET /session/:id/message?limit=200 拉转录
  → 与本地游标 diff，只取新消息（增量，防丢的第一步）
  → 小模型结构化提取（一次调用）：
      输入：新增对话片段
      输出：{memories: [{summary, type, tags}], } —— type="skip" 即丢弃
      模型：claude-haiku-4.5 / gpt-4o-mini 级（opencode-mem 同款选择）
  → embedding → 向量库（带 sessionID/projectID/时间戳元数据）
  → 更新游标；session.deleted / worker 收到退出信号时 flush（防丢的第二步）
```

- **为什么判断放这里**：写时判断零前台影响，业界主流（opencode-mem/supermemory 都这么做）。提取时就完成"值不值得记"的过滤，注入时不再需要 LLM。
- **失败降级**：小模型调用失败 → 指数退避重试 3 次 → 记 dead-letter，不阻塞后续会话。

## 4. 读路径（检索 → 判断 → 注入）：三个判断位置的权衡

| 方案 | 判断时机 | 每轮成本 | 结论 |
|---|---|---|---|
| ❌ 内联在 transform hook | 每个 agent-loop step 调小模型 | 300-800ms × step 数（10 步任务 +3-8s）+ 缓存失效 | 不可接受 |
| ⚠️ 每条用户消息一次 | `chat.message` 时调 haiku 复核 | 每用户消息 +300-800ms 一次 | 可接受，非必需 |
| ✅ **写时判断 + 注入零 LLM**（推荐起步） | 提取时已过滤；注入 = 向量 top-k + 相似度阈值 | ~几十 ms | opencode-mem 验证过的模式 |

**推荐读路径：**

```
新会话首条用户消息（或项目打开）时：
  → 向量检索 top-k（k≈3-5）+ 相似度阈值（参考 supermemory 0.6）
  → 拼成有界文本块（字符数硬上限，参考 pi-memory 16K cap 思路）
  → POST /session/:id/prompt  { noReply: true, parts: [{type:"text", text}] }
  → 之后本轮及后续每轮 LLM 都看得到（持久注入）
另注册 memory 自定义工具（search/add）供主模型主动深挖（pull 补充）
```

- **如果坚持要检索时复核**：放在"每条用户消息一次"这一档（fire-and-forget 事件里异步预计算 + 结果缓存，下条消息生效），不要放进每 step 的 transform。
- **注入为什么用 REST prompt 而不用 transform hook**：① v2 无 transform 对应物，用了必重写；② REST 注入是持久消息，天然躲过"压缩后 AGENTS.md 丢失"类问题；③ worker 进程外就能完成，连插件都不用装。等 v2 插件 API 定稿后，再评估是否升级为 ephemeral 每轮注入。

## 5. 缓存与成本策略

- **注入频率**：默认首条消息注入一次（opencode-mem 的 `injectOn:"first"`）；避免每轮变化的注入内容（prompt cache 失效税，DCP 实测 -5pt，pi-memory 为此做了字节级快照模式）。
- **注入位置**：`noReply` 持久注入即可；若将来改用 `system.transform`，splice 在 index 1（provider header 之后），保持前缀字节稳定。
- **成本估算**：写时提取每会话 ~1-3k token（haiku 级 ≈ 忽略不计）；embedding 本地模型免费；检索纯向量 ms 级。整体月成本 < $1 量级（个人使用）。

## 6. 防丢与降级

| 场景 | 对策 |
|---|---|
| opencode 进程退出时任务跑一半 | 增量游标：每处理完一批消息即落盘；下次从游标续 |
| 无 server 运行（TUI 默认可能不起 server） | 触发面 B（超薄插件转发）兜底；数据面 v1 可读 `~/.local/share/opencode/storage/` JSON，v2 读 `opencode.db` SQLite（注意 #41217 不导入旧数据） |
| 事件改名静默失效（#40808 前科） | canary：启动时验证能收到 `server.connected`、能拉到 session 列表；N 分钟无任何状态事件 → 告警 |
| 小模型服务挂 | 写路径重试+dead-letter；读路径退化为纯向量阈值注入 |

## 7. 配置项（建议）

```jsonc
{
  "opencodeUrl": "http://127.0.0.1:4096",
  "trigger": { "mode": "poll|sse|plugin", "pollIntervalSec": 30 },
  "extract": {
    "model": "claude-haiku-4-5",          // 写时判断的小模型
    "debounceSec": 10,                     // 参考 opencode-mem
    "maxCharsPerBatch": 12000
  },
  "retrieve": {
    "topK": 3,                             // opencode-mem 默认 3
    "similarityThreshold": 0.6,            // supermemory 同款
    "excludeCurrentSession": true,
    "recheckWithSmallModel": false         // §4 的可选复核开关
  },
  "inject": {
    "mode": "first-message",               // 缓存友好
    "maxChars": 4000,
    "eventNames": ["session.idle", "session.status", "session.next.step.ended"]  // v2 适配在这
  }
}
```

## 8. 决策记录（ADR 摘要）

1. **选 opencode 不选 pi** —— pi 事件 handler 被 await，与"不挂前台"冲突；opencode `event` hook 天然 fire-and-forget。
2. **worker 进程外，不做重插件** —— 插件无进程隔离（#39031 挂起可吞 prompt），且 v2 插件 API 未定（#34546）。
3. **注入走 REST `noReply`，不走 transform hook** —— v2 无对应物；REST 有 legacy 兼容层。
4. **小模型判断放写时** —— 热路径内联 LLM 的延迟 × step 数不可接受；业界无人这么做。
5. **首消息注入 + pull 工具混合** —— 平衡召回率、token 税、缓存命中。
