# 01 调研结果

> 所有结论标注来源与信度。日期：2026-08-06/07。

## 1. 选型：opencode vs pi

需求拆成两点：① 会话结束后触发；② 异步执行、不阻塞前台。对照如下（均经源码/官方文档核实）：

| | opencode | pi（earendil-works/pi，原 pi-mono） |
|---|---|---|
| 会话结束事件 | `session.idle`（每轮跑完即触发） | `session_shutdown`（quit/`/new`/`/resume`/`/fork`，语义更精确） |
| **handler 是否阻塞前台** | **`event` hook = fire-and-forget**（源码 `void hook["event"]?.(...)`，Promise 直接丢弃） | **事件 handler 全部被 await**（官方示例在 `session_shutdown` 里 await git commit） |
| 不阻塞的正确姿势 | 直接写，天然不阻塞 | handler 里 spawn detached 子进程绕（可行但是"绕"） |
| 进程外方案 | `opencode serve` + SSE `/event` + REST ✅ | RPC/JSON mode + 读 JSONL ✅ |
| 上下文注入 | 4 条通道（见 §3） | `context` 事件 / `before_agent_start` 可改上下文（更深，但我们不需要） |
| 现成记忆插件 | opencode-mem 1.3k★、supermemory 1.5k★ 等 5+ 个 | pi-memory 108★ |

**结论：选 opencode。** pi 的扩展深度（可改 context/provider 请求）本需求用不到，而它的 awaited 语义与"不挂前台"直接冲突。opencode 的 `event` hook 语义恰好是为这个场景设计的。

来源：[opencode plugin/index.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)、[pi 扩展文档](https://pi.dev/docs/latest/extensions)、[pi auto-commit-on-exit.ts 示例](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)。

## 2. opencode 插件/事件 API 核实清单

来源：`packages/plugin/src/index.ts` + `packages/opencode/src/plugin/index.ts`（dev 分支源码）。

**两类 hook 的语义差异（关键）：**
- 通用 `event` hook：接收全部总线事件 `{id, type, properties}`，**fire-and-forget，运行时不 await** → 慢任务不阻塞 agent loop。代价：进程退出时不等你跑完 → 需增量捕获 + flush（见 02 设计）。
- 命名 trigger hook（`tool.execute.before/after`、`chat.message`、`chat.params`、`chat.headers`、`experimental.chat.*.transform`、`experimental.session.compacting` 等）：**顺序 await，无超时** → 挂住的 hook 会吞掉 prompt（issue #39031）。重活严禁放这里。

**与记忆插件相关的事件：**
`session.idle`（deprecated，见 §6）、`session.status`（{type:"idle"|"busy"|"retry"}）、`session.created`、`session.updated`、`session.deleted`、`session.compacted`、`session.error`、`message.updated`、`server.connected`、`permission.asked/replied`、`command.executed` 等（全目录见 [插件文档](https://opencode.ai/docs/plugins/)）。

**已知缺口：**
- 无 `session.end`/`session.finalizing`（[#35540](https://github.com/anomalyco/opencode/issues/35540)，open）；"会话结束"的正确定义 = `session.idle` 增量捕获 + `session.deleted`/`dispose()` 时 flush。
- 无 session-start/prompt-submit 上下文注入生命周期 hook（[#28695](https://github.com/anomalyco/opencode/issues/28695)，open；其 issue 正文确认 transform hook 是当前官方认可机制）。

## 3. 上下文注入通道（源码核实，按推荐度排序）

| # | 通道 | 机制 | 触发时机 | 持久性 | 来源 |
|---|---|---|---|---|---|
| 1 | **`POST /session/:id/prompt` + `noReply:true`** | REST/SDK，官方文档原话 "inject context without triggering AI response" | 任意时刻（worker 可调） | 持久（真实 user message，后续每轮可见） | [SDK 文档](https://opencode.ai/docs/sdk/)；`session/prompt.ts` |
| 2 | `chat.message` hook | 用户消息创建时追加 synthetic part（`output.parts.unshift()`，需 in-place） | 每条用户消息一次 | 持久 | opencode-mem 在用 |
| 3 | `experimental.chat.system.transform` | 往 system 数组 splice（PR #5542，2025-12 合入） | 每次 LLM 调用 |  ephemeral | opencode-agent-memory 在用 |
| 4 | `experimental.chat.messages.transform` | 增/删/改消息数组（深拷贝，PR #5207） | **每个 agent-loop step + 压缩时** | ephemeral | DCP 在用 |

**关键实现细节（都是坑）：**
- transform hook 必须**原地修改**（`push`/`splice`），重赋值 `output.messages = ...` **静默失效**（PR #32758 未合入）。
- transform 在 subagent 和标题生成时也触发 → 需按 agent 签名过滤（DCP 的 `INTERNAL_AGENT_SIGNATURES` 做法）。
- `session.prompt` 还有个未文档化的 `body.system` 参数：持久化在 user message 上，之后每轮合并进 system prompt（源码 `llm/request.ts` 核实，文档未写）。
- 静态面：`AGENTS.md` / `instructions` 配置 glob（[rules 文档](https://opencode.ai/docs/rules/)）——零代码但静态，且压缩后丢失。

## 4. 业界记忆插件实现模式（逐个核实 README+源码）

| 插件 | ★ | 捕获触发 | 判断步骤 | 注入机制 | 延迟模式 |
|---|---|---|---|---|---|
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | 1.3k | `session.idle`+10s 防抖 | **写时**：claude-haiku-4.5 / gpt-4o-mini 结构化输出（含 `type="skip"`） | **push**：`chat.message` 首消息注入 top-3 + `memory` 工具 pull | 注入零 LLM/轮 |
| [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory) | 1.5k | idle 每 N 轮增量 + deleted/shutdown flush | 检索仅向量阈值 0.6，**无 rerank**；每轮相关性决策交给**主模型**（"Reasoned Recall" 指令） | 首消息 push + 每轮指令 + `supermemory` 工具 pull | 首轮 3 个并行云调用 |
| [opencode-agent-memory](https://github.com/joshuadavidthomas/opencode-agent-memory) | 323 | agent 用工具自编辑（Letta blocks） | 无（永远在上下文，字符数封顶） | `system.transform` splice 在 index 1（保缓存） | 零/轮 |
| [opencode-episodic-memory](https://github.com/robertn702/opencode-episodic-memory) | 2 | idle 重索引（本地 embedding + FTS5） | 无 LLM（明确推迟） | **纯 pull** + skill 引导，公开反对 push（"per-prompt token tax"） | 搜索 <10ms |
| [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（非记忆，transform 实战） | 3.9k | — | 启发式为主；compress 由主模型决定 | `messages.transform` + `system.transform` | 实测缓存命中 ~85% vs 90% |
| [pi-memory](https://github.com/jayzeng/pi-memory) + [qmd](https://github.com/tobi/qmd)（pi 侧对照） | 108 / 28.6k | shutdown/compact/写时 | 检索时 rerank 只在 pull 工具（qwen3-reranker-0.6b，~10s） | push 用 KV 缓存稳定的**字节级快照**（检查点间不变） | push ~30ms BM25 |

**四条经验教训（直接指导设计）：**

1. **小模型判断放写时，不放检索时的注入热路径。** 全 GitHub 搜 `opencode memory rerank` 仅 1 个 3★ 仓库；唯一做 LLM rerank 的 qmd 也只放在 LLM 主动调用的 pull 路径（~10s 进不了热路径）。
2. **每轮注入变化内容 = prompt cache 失效税。** pi-memory 为此专门改成快照模式；DCP 实测掉 5 个点。push 注入应有界（top-k + 字符上限）且低频（首消息/检查点）。
3. **push + pull 混合是主流**：小集合 curated 记忆 push，大语料 episodic 靠 pull 工具 + skill 引导模型主动查。
4. **防丢靠"增量 + flush"**：fire-and-forget 意味着进程退出不等你，supermemory 的"每 N 轮捕获 + deleted/shutdown flush"是被验证的模式。

## 5. 维护健康度与商业基本面（2026-08-06/07 实测）

**会不会死：大概率不会。**
- anomalyco/opencode：194k★（7 月批评文事件后两周半反涨 3.3 万）、npm 月下载 844 万、12 天 10 个版本、~90 commits/周、~8 名人类提交者（公司化团队，非个人项目）。
- 商业：Zen 网关（按量）+ Go $10/月（任何 agent 可用）+ 企业版（按席位）。无公开融资/收入数据。
- 风险：安全信任史（CVE-2026-22812、stale-bot 关安全报告）；Anthropic 法律压力史；HN 热度较 3 月峰值回落。

**修不修 bug：三车道。**
- 团队自提核心 bug：数小时~11 天（7 个采样核实）。
- 舆情点名 bug：~4 天（wren 批评文后 3 项修复）。
- **插件 API bug：慢车道**——#31680（附完整补丁）58 天零维护者回复；#28695 78 天；#24953 100 天。提 issue 需带复现+模板（bot 分诊激进，32👍 的 #22067 被 not_planned 关掉）。

## 6. v2 兼容性核查（dev 分支源码级）

v2 正在 next 通道推进（Effect 架构、热重载、167 类事件模型），**官方无插件 API 稳定承诺**，且已有静默断裂前科（[#40808](https://github.com/anomalyco/opencode/issues/40808)：事件改名后 v1 订阅照常注册但永不触发）。

各集成面的 v2 存活率（least→most likely to break）：

| 面 | v2 状态 | 证据 |
|---|---|---|
| **REST + SSE（最稳）** | `GET /session`、`/session/:id/message`、`/session/status`、`POST /session/:id/prompt` 全部保留；源码有专门 legacy 兼容层（"Keep that SDK surface stable"）；v2 API 以 `/api/...` **并存**而非替换 | `groups/session.ts`、`public.ts`（dev） |
| `session.idle` 事件 | 已标 **deprecated**，在 #35054 移除清单；v2 替代：`session.status{type:"idle"}` / `session.next.step.ended`（durable、带版本号） | `packages/schema/src/session-status-event.ts` |
| transform hooks | **v2 插件 API（Effect `PluginContext`）中无对应物**；v2 有 `ctx.<domain>.transform`/`ctx.aisdk.*` 但未定稿（#34546）；v1 插件在 next 通道直接 SchemaError（#39345） | `packages/plugin/src/v2/effect/` |
| 直接读存储文件（最不稳） | dev 已改布局并自动迁移；**next 通道已转 SQLite（`opencode.db`，`session_v2` 表）且不导入旧数据** | #41217、`storage.ts` |

**推论**：建立在 REST/SSE 上的外部 worker 是 v2 生存率最高的形态；进程内 transform hook 注入是 v2 唯一"必重写"的部分——所以设计上把它推迟到 v2 API 定稿后（见 02 设计 §4）。

**需持续跟踪**：#35054（V1 面移除时间表）、#40808（改名 shim）、#34546（v2 插件 API 定稿）、#35540/#28695（正式生命周期 hook，若落地可简化设计）。

## 7. 信度说明

- **高置信**：插件 API 语义、注入通道、v2 事件模型（全部 dev 分支源码核实）；各插件实现（README+源码）；维护数据（GitHub/npm API 当日实测）。
- **中高置信**：商业判断（无公开融资/收入数据）；v2 插件 API 最终形态（官方自认未定稿）。
- **中置信**：小模型内联延迟的具体数值（量级估算，取决于模型与网络）。
