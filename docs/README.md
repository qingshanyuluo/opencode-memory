# opencode-memory 调研与设计

> 第一轮调研：2026-08-06/07（选型对比 → 插件 API 核实 → 业界实现 → 维护健康度 → v2 兼容性），见 01-03。
> **第二轮：2026-08-11**（理念与知识模型 → 通用记忆架构 → 学术机制谱系 → 竞品全景与风评 → 修订路线图），见 05-07。
> 目标：为 opencode 写一个记忆插件——**会话结束后异步提取记忆（不挂前台）；把 agent 的一次性探索资本化为可复利资产**。

## 一页纸结论（第一轮，2026-08-06/07）

1. **基于 opencode 写，成立。** 关键能力全部具备且经源码核实：fire-and-forget 事件 hook（`session.idle`）、多种上下文注入通道、`opencode serve` 的 SSE+REST 完全进程外方案。pi 是备选但不符合"不阻塞前台"的要求（其事件 handler 被 await）。
2. **架构选"超薄触发层 + 独立 worker"。** 提取/判断/向量库全部放在 opencode 进程之外；与 opencode 的耦合收敛到一个 <100 行的适配层（事件转发 + REST 注入）。
3. **小模型判断放在写时（session.idle 后异步提取），不要放在每轮注入的热路径上。** 这是业界共识：transform hook 是 awaited 且每个 agent-loop step 都触发，内联 LLM 判断会把延迟乘进工具循环；且每轮变化的注入内容会打破 prompt cache。
4. **注入优先走 `POST /session/:id/prompt` + `noReply: true`（REST 稳定面），而不是 `experimental.chat.*.transform` hook。** 前者在 v2 有明确保留和 legacy 兼容层；后者在 v2 插件 API 里**没有对应物**，用了将来必重写。
5. **v2 风险可控，但官方零兼容承诺。** `session.idle` 已标记 deprecated（替代：`session.status{type:"idle"}` / `session.next.step.ended`）；事件改名已有静默失效前科（#40808）。按本文档的架构，v2 切换只需改适配层几十行。
6. **opencode 项目本身大概率不会死**：公司化运营（Anomaly）、三条收入线、~90 commits/周、npm 月下载 844 万。但要接受"插件 API bug 在慢车道"（有补丁的 #31680 放了 58 天没人理）。

## 一页纸结论（第二轮，2026-08-11）

1. **核心理念定稿：把 agent 的一次性探索资本化为可复利资产。** ROI = 复用次数 × 单次探索成本 − 维护成本 − 注入税。本机三库 1010 会话中 VideoTips 被 175 个会话触及、NewMinuteDog 136、SLS 104——复用两位数起，ROI 天然为正（benchmark 复用≈1，所以证明不了记忆价值，也不需要它证明）。
2. **知识模型 = 精炼阶梯 L0-L4**（情节→事件→洞见→规程→词表），驱动力只有三种：重复（归纳需要样本量）、对比（洞见来自成败差分）、回放（巩固发生在离线自问自答）。架构原型是 CLS 海马体-新皮层-睡眠，有量化工程验证（Letta sleep-time 5x、RecMem 87%、HippoRAG 10-30x）。
3. **存储原语通用化**：只有 `entries + links` 两原语 + 三个特权谓词（supersedes/references/related），kind/rel 自由涌现（谱系：Zettelkasten → OpenIE → A-MEM → Graphiti "prescribed & learned"）。预设本体是从单会话过拟合的特解，已废弃。
4. **L0/L1a 零 LLM**（搬运+确定性解析，coding 转录半结构化是红利）；L1b 叙事可延后可重算；**真正的 LLM 依赖从 L2 开始，那也是差异化的起点**。
5. **竞品格局**：完整阶梯无人实现。L0-L1 红海（claude-mem 90k★，绝不策展是其护城河也是让出的空间）；L2-L4 全空白。市场规律：**自动化程度与信任度成反比**（Cursor 撤 Memories、Claude Code auto memory 被关、1080 runs 零改进研究）——所以晋升门/执行验证/valid_to 从 v0.1 就要有。
6. **对 claude-mem 作者"不做整理"哲学的回应：不反驳，加缓存**——他把归纳留给每次读取的运行时，我们把归纳做成睡眠期批处理并缓存结果；原料永留，结论永远可被更强的模型重算。

## 文件导航

| 文件 | 内容 |
|---|---|
| [01-research.md](01-research.md) | 第一轮调研：选型依据、插件 API 核实、业界实现模式、维护健康度、v2 面核查 |
| [02-design.md](02-design.md) | 插件架构：触发/写/读路径、防丢策略、决策记录 1-5（仍有效；§7 知识组织被 05 §7 取代） |
| [03-implementation.md](03-implementation.md) | 实施指南：代码骨架、测试与 canary、坑清单（仍有效；路线图被 07 取代） |
| [04-knowledge-graph.md](04-knowledge-graph.md) | 知识图谱本体论草案（**已被 05 §7 通用原语取代**，留档：过拟合特解的教训） |
| [05-philosophy.md](05-philosophy.md) | **理念与知识模型**：核心理念、精炼阶梯 L0-L4、三驱动力、CLS 蓝图、通用存储原语、质量边界 |
| [06-landscape.md](06-landscape.md) | **竞品与生态**：code agent 记分卡、七家可抄清单、claude-mem 深拆、社区风评规律、定位 |
| [07-roadmap.md](07-roadmap.md) | **路线图**：硬约束、本机数据发现、Phase 0-5、评测定义、ADR 6-12、跟踪清单 |
| [08-bootstrap.md](08-bootstrap.md) | **初始语料编译**：三库输入、L1a 转换边界、脱敏、派生表与使用方式 |
| [09-dashboard.md](09-dashboard.md) | **本地管理台**：启动机制、页面能力、API 与安全边界 |
| [10-behavior-graph.md](10-behavior-graph.md) | **L1b 行为图**：目标/假设/证据/修正/决策模型、分块提取、断点续跑与首个样本 |
| [11-memory-loop.md](11-memory-loop.md) | **自动闭环**：idle 整理、知识晋升、人审图谱、首条目录注入与 memory_pull |
| [12-promotion-policy.md](12-promotion-policy.md) | **晋升政策**：三问门槛、方法论优先、复现信号、双阶段策展与自动处理边界 |
| [13-object-memory.md](13-object-memory.md) | **知识对象模型**：interface/abstract/implementation/instance/resource、结构关系、三档整理与类加载式 pull |
| [14-history-backfill.md](14-history-backfill.md) | **历史回填**：会话族去重、个人平台知识范围、持久队列、限速并发与管理台进度 |
| [15-domain-layer.md](15-domain-layer.md) | **能力域索引层**：domain/namespace 双维、9 大能力域、多分类与最底层接口 |
| [16-adaptive-hierarchy.md](16-adaptive-hierarchy.md) | **自适应层级**：递归 Map-Reduce、编译器约束、压缩终止与断点缓存 |
| [17-opencode-integration.md](17-opencode-integration.md) | **opencode 集成**：系统提示词一级索引、稳定 session 缓存与 memory_pull 类加载 |
| [18-observability.md](18-observability.md) | **召回观测**：Hit Rate/Coverage/Latency/后续行为代理、历史回填与人工 ground truth |

## 最小可行路径（TL;DR，第二轮修订）

```
0. adapter 验证：serve /doc 三端点 + opencode.db（1.18.16 已 SQLite 化）直读冒烟
1. L0 继续留在 opencode 原库；一次性 bootstrap 脚本只编译 L1a 派生索引（三库 1010 会话，零 LLM、脱敏、可回源）
2. 离线调 L1b/L2：按复用频次选域（VideoTips→NewMinuteDog→SLS），人审产出种子记忆库 = golden set
3. 读路径：FTS5+向量+references 扩散 → 带 token 价签的索引式注入（noReply，≤1k token，防回声标记）
4. 睡眠整理器：session.idle 触发，门禁三明治（确定性前门→无写权 LLM 提议→确定性后门+操作日志）
5. 高阶：L3 三条件晋升门固化 runbook、L4 词表归拢、锚点 JIT 验证续命
```

参考实现：[claude-mem](https://github.com/thedotmack/claude-mem)（90k★，L0-L1+渐进披露标杆，已支持 opencode）、[opencode-mem](https://github.com/tickernelz/opencode-mem)（1.3k★）、[opencode-episodic-memory](https://github.com/robertn702/opencode-episodic-memory)（零 LLM 纯 pull 流派）、[autoharness](https://github.com/tigerless-labs/autoharness) / [self-learning-skills](https://github.com/Kulaxyz/self-learning-skills)（会话→技能归纳蓝图）、[DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（3.9k★，transform hook 实战）。
