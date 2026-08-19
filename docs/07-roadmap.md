# 07 路线图与决策记录

> 2026-08-11 修订版，取代此前口头计划；03-implementation 的代码骨架仍有效，触发/防丢设计不变。

## 1. 四条硬约束

1. **耦合最小**：插件运行时直接只读 opencode REST/SQLite，不搬运 L0；历史初始化由独立 bootstrap 脚本完成 L1a 编译，全部收 adapter 层（v2 只改这里）；
2. **通用原语**：只认 `entries + links`（05 §7），kind/rel 涌现，特权谓词仅 supersedes/references/related；
3. **精度优先**：写时 skip 偏置；演化只动 tags/links 不改 content；整理动作全进操作日志可回滚；晋升门从 v0.1 就在；
4. **评测即 dogfooding**：指标 = 同域重复任务的探索型工具调用数下降，不是任何 benchmark。

## 2. 本机数据发现（地基事实，2026-08-11 实测）

- **opencode 1.18.16 已完成 SQLite 迁移**（修正 01-research §6 "v1 是 JSON 文件"的假设）：数据在 `~/.local/share/opencode/opencode.db`（WAL），表 `session` / `message` / `part`（`data` 列 JSON），旧 `storage/` 仅剩迁移残留。读时用 `mode=ro`。
- **三库 1010 个历史会话现成可用**：main 810 / dev 195 / local 5，session ID 无重叠。
- **复用频次表**（整理优先级依据 + ROI 实证）：VideoTips 175 会话 / NewMinuteDog 136 / SLS 查日志 104（2026-08-11 三库实测）。
- 工具 part 结构：`{type:"tool", tool, callID, state{input,output}, metadata}`；样本会话（ses_02446e44）52 user / 511 assistant / 554 工具调用，估算 30-40% 调用是可被记忆消除的重复探索；会话标题 "fork #1" 本身就是上下文丢失成本的实证。

## 3. 阶段计划

**Phase 0 地基验证（半天）**
`opencode serve` 核对 `/doc` 三端点（`GET /session/status`、`GET /session/:id/message`、`POST /session/:id/prompt {noReply}`）；opencode.db schema 快照冒烟测试。产出：adapter 接口定稿（事件映射 + REST + DB 直读三合一）。

**Phase 1 初始语料编译（已实现）＝ L1a，零 LLM**
- L0 不搬运：继续以 opencode 三个源库为事实源；
- 独立 `bun run bootstrap` 一次性编译派生索引：session manifest、user intent、规范化工具事件、文件/命令/URL/错误锚点、FTS；
- 成功工具输出、assistant 全文、reasoning 不复制；所有派生记录保留 `source_db + session/message/part id`，需要细节时回源；
- 确定性脱敏（密钥/header/连接串/常见凭据），原子临时库构建后替换输出。当前验收：1010 sessions / 61k+ tool events / 47k+ artifacts，完整性与外键检查通过。

**Phase 2 离线提取实验（3-5 天，不上线）＝ L1b + L2 调试**
- 按复用频次定域：VideoTips → NewMinuteDog → SLS；
- 挑 5-10 个代表会话调提取 prompt（LLM 生成 kind/tags/links，skip 偏置拉满；用户纠正类消息加权——Devin 信号）；
- 人工 review 产出**种子记忆库 ~30-50 条 = golden set**；每条带可验证锚点（commit/文件/报错原文）。
- 验收：人工评审通过率 ≥80%。

**Phase 3 读路径 + 评测闭环（1 周）**
- 检索：FTS5（triggers/症状词）+ 向量 + `references` 1 跳扩散；supersedes 链自动只取最新；
- 注入：**带 token 价签的索引式渐进披露**（学 claude-mem，不整段灌）+ 首消息 noReply 一次 ≤1k token；memory pull 工具；
- **注入内容带防回声标记**（提取器跳过，OpenClaw 教训）；
- 评测：真实 VideoTips/舔狗任务对比有无记忆的工具调用数；每周 review 注入命中率/过期率。

**Phase 4 在线睡眠整理器（第 2-3 周）＝ L2 常态化**
- `session.idle` fire-and-forget 触发（02 架构不变）；
- **门禁三明治**：确定性前门（频率/新近/多样性打分 + 出处污点）→ LLM 整理（**提议者无写权限**，输出提议 JSON）→ 确定性后门（验收 + 丢失上限）→ promoter 落库 + 操作日志（autoharness 权限分离）；
- 资格门四件套（Codex）：闲时、配额、外部内容污染排除、密钥脱敏；
- canary + 事件名映射（03 §5-6 照抄）。

**Phase 5 高阶层（持续）**
- L3：复现的成功路径 + 三条件晋升门（通过的检查 + 命名的失败模式 + 排除的死路）固化 runbook；执行验证 = 下次使用是否省调用；
- L4：定期词表归拢任务（embedding 聚类 + LLM 裁决合并）；
- 锚点 JIT 验证（Copilot 模式）：注入前跑锚点谓词，通过续命，失败标记待重验；
- Markdown 导出层（人 review 界面，SQLite 是事实源）。

每一步产出都是下一步的测试集，不存在"建完才知道有没有用"的赌博环节。

## 4. 评测定义

- **主指标**：同域重复任务的探索型工具调用数（对照：有/无记忆注入）；
- **辅指标**：注入命中率（被后续行动引用的比例）、过期率（JIT 验证失败比例）、坑卡拦截数（避免的已知死路重试）；
- 对照锚：1,080 runs 研究证明"随手写的记忆"无效——我们要给出"重复触发+对比提炼+执行验证的记忆"有效的正面证据。

## 5. 决策记录（第二轮 ADR，续 02 §8）

6. **SQLite 承载 L0-L2，Markdown 是导出物不是事实源** —— 业界分层惯例：机器索引数据用 SQLite（opencode-mem/episodic/claude-mem/qmd），文件适合"agent 直接编辑"场景而我们是 worker 批处理架构；关系完整性/事务重构/反向查询文件给不了。
7. **通用原语取代预设本体**（取代 04 的六类节点八种边）—— 从单会话过拟合的特解；Graphiti "prescribed & learned" 是同款切分的工业验证。
8. **不采用 A-MEM 代码，抄其三机制且演化不改 content** —— 零第三方复现 + 研究代码无维护；TRUSTMEM 证明 LLM 改写历史会腐化。
9. **不用嵌入式图库，图查询走 recursive CTE** —— Kuzu 已死（2025-10 归档，团队被 Apple 收购）、CozoDB 停滞（2024-12 后零 commit）、DuckPGQ 研究级；万级节点 CTE 毫秒级够用。
10. **L0 自建（30 行 ETL）而非消费 claude-mem** —— 避免引入 405 开 issue 的重依赖；保留读其 observations 表的兼容接口作为可选输入。
11. **写时极简，裁决留给睡眠期** —— Mem0 v3 的行业方向验证；写时只判"值不值得记"。
12. **注入用带价签的索引（渐进披露）而非内容 push** —— claude-mem 35k→1k token 的教训 + episodic-memory 的"per-prompt token tax"立场。

## 6. 跟踪清单（续 03 §8）

- claude-mem 的 opencode 插件演进（捕获层若够稳，L0 可切换为消费其 observations）；
- autoharness / self-learning-skills 的真实使用反馈（目前星多评论零，待验证）；
- Copilot Memory 的 citation 验证机制细节披露（JIT 验证的工程参考）；
- Letta sleep-time / RecMem / Auto-Dreamer 后续（睡眠整理的学术前沿）；
- opencode v2 插件 API 定稿（#34546）与 V1 面移除时间表（#35054）——不变。

## 7. 待拍板

- 代码位置（建议：本目录加 `package.json` + `src/`，docs 原地保留）；
- 提取模型（建议：现有 OpenAI 兼容网关的 haiku 级；Phase 2 离线实验对延迟不敏感，成本 <$1）。
