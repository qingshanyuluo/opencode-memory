# 06 竞品与生态

> 2026-08-11 实测（GitHub API 星数 + HN 全量风评 + 官方文档核实）。核心结论：**没有任何工具实现完整精炼阶梯；L0-L1 是红海，L2-L4 是空白。**

## 1. code agent 原生记忆记分卡

| 工具 | L0 | L1/L2 | L3 规程归纳 | L4 | 晋升门 | 睡眠巩固 |
|---|---|---|---|---|---|---|
| **opencode** | ✅ SQLite | ❌ **原生零记忆**（docs/memory 404，纯插件领地） | ❌ | ❌ | ❌ | ❌ |
| **Claude Code** | ✅ JSONL | ⚠️ auto memory（会话内即写、无门、仅超限重写） | ⚠️ **窄域自动**：`/run-skill-generator`、`/verify` 把验证过的配方写成 skill | ❌ | ❌ | ❌ |
| **GitHub Copilot** | ✅ | ✅ Copilot Memory（默认开启，事实+偏好） | ❌ | ❌ | ✅ 引用+JIT 验证+28 天过期 | ❌ **架构上明确拒绝** |
| **Codex** | ✅ | ✅ 后台两段式（extract_model + consolidation_model）——最接近官方"睡眠" | ⚠️ Record&Replay（演示→skill 草稿）；扫 sessions 建 skill 是官方定时任务菜谱 | ❌ | ⚠️ 资格门 | ⚠️ 浅 |
| **Devin** | ✅ | ✅ Knowledge Suggestions（自动提议+**人审门**） | ⚠️ playbooks（用户发起） | ❌ | ✅ 人审 | ❌ |
| **Cursor** | ✅ | ❌ **3.0 撤掉了 Memories**，退回 rules | ❌ | ❌ | — | — |
| Cline / Amp | ✅ | ❌ 手工 markdown 约定 / 无 | ❌ | ❌ | — | — |

## 2. 三个关键市场信号

1. **Copilot 的"反睡眠"路线有效但有边界**：拒绝离线整理（"Instead of offline memory curation, we store memories with citations… verified in real-time"），靠锚点 JIT 验证 + 28 天过期（验证成功续命）保质量，A/B 实测 PR 合并率 90% vs 83%（p<0.00001）。**前提是真值源在代码库里**——只能承载事实层，产不出规程/洞见/词表。启示：我们的锚点应升级为可机器验证谓词。
2. **Claude Code 在窄域实现了 Voyager**：`/verify` 自记录（"capture what worked… other agents follow the recorded recipe instead of rediscovering it"）= 执行即真理的 L3 构造，但只覆盖构建/运行域；通用的 memory→skill 晋升官方明确留给人。
3. **Cursor 撤退 = 无门禁自动记忆的死刑判决**：结合 Claude Code auto memory 的"默认关闭"用户文化、1,080 runs 零改进研究——**社区用脚投票：自动化程度与信任度成反比**。

## 3. 七家设计精华（可抄清单）

| 来源 | 抄什么 | 落在管线哪 |
|---|---|---|
| **OpenClaw dreaming** | 门禁三明治：确定性前门（六信号加权：相关 0.30/频率 0.24/查询多样性 0.15/新近 0.15/多日复现 0.10/概念丰富 0.06 + 出处污点一票否决）→ LLM 整理 → 确定性后门（旧条目丢失 ≤25% 否则拒绝）；**防回声标记**（被召回内容永不二次提取）；DREAMS.md 审计面；"Nothing crosses from episodic to curated without passing the promotion gates" | 睡眠整理器骨架 |
| **Copilot** | 锚点=可验证谓词，注入前 JIT 验证 + 过期续命 | 事实层保鲜 |
| **Codex** | 资格门四件套（闲时/配额/外部上下文污染排除/密钥脱敏）+ 提取/整理双模型分档 | 触发与成本 |
| **Claude Code** | 做成功一次当场固化，成功信号即晋升门 | L3 构造方式 |
| **Devin** | 用户纠正是最高信噪比提取信号；trigger-based recall；冷启动人审门 | 提取信号/检索 |
| **autoharness**（911★） | **提议者/晋升者权限分离**（reflector 无写工具，promoter 验收落库）；ledger 隔离（只动机器创建的条目） | 整理器安全架构 |
| **self-learning-skills**（950★） | 三条件晋升门："a passing check + a named failure pattern + at least one ruled-out dead-end" | L2→L3 晋升标准 |

Mem0 v3 的重要信号：把"写时两次调用（提取+对旧裁决）"砍成 **ADD-only 单次**，冲突解决全移后台 Dream（supersede/merge 非破坏）——"让模型把算力花在理解输入上，而不是 diff 旧状态"。**写时极简、睡时裁决**是行业收敛方向。

## 4. claude-mem 深拆（声量王，90,383★）

```
[捕获] PostToolUse 每次工具调用 → fire-and-forget HTTP POST 给本地 worker（2s 超时不阻塞）
[压缩] 常驻 worker（Bun）排队 → Haiku 观察者（分层路由省 52%）→ 单工具执行压成 observation
       （title/narrative/facts/concepts/type，9 类型；session summary 是检查点非终点）
[存储] SQLite WAL + FTS5 + 可选 Chroma；SHA-256 去重；永不删除/过期/改写
[注入] SessionStart 注入 ~1,000 token 带 token 价签的「索引」（近 10 会话 50 条，仅最近 5 条全文）
[检索] 三层渐进披露：索引(~50-100 tok) → 时间线(~100-200) → 全文(~500-1000)；skill+MCP 双通道
```

四个制胜设计：**渐进披露**（"We provide the map; the agent chooses the path"——v1 时代一次灌 35k token 仅 1.4% 相关的血泪产物）；**绝不策展**（"Missing a summary is preferable to creating a fake one"）；**绝不阻塞**（记忆故障不影响 IDE）；**持续删防御性代码**。

**它 = L0+L1+检索，刻意止步 L2**。作者不做 L2 的理由重构与评估见 05 §8：理由对横向产品成立（无域知识、无验证信号、错误结论毒性大），对我们全部翻转（垂直域有执行验证、复用 110 次的写一读百经济学、检索语义鸿沟——"跑了 curl 得到 401" 匹配不上 "怎么拿 Nacos 配置"）。

**已原生支持 opencode**（`npx claude-mem install --ide opencode`，v10.7.0+）。

## 5. opencode 生态对标

| | claude-mem | opencode-mem (1,322★) | opencode-episodic-memory | open-mem (25★) |
|---|---|---|---|---|
| 捕获 | 每工具调用实时 | session.idle+10s 防抖批处理 | 只读 opencode.db 不捕获 | idle 压缩 |
| 压缩 | Haiku 逐工具 observation | Haiku 结构化提取（含 skip） | **零 LLM**（刻意） | AI observation |
| 存储 | SQLite+FTS5+Chroma | libSQL/Turso DiskANN | SQLite FTS5+暴力余弦 | SQLite |
| 注入 | ~1k token 索引 | 首消息 push top-3 | 纯 pull（反对 push） | — |
| 健康 | 日更/405 开 issue | 活跃 | 活跃/文档极好 | **停滞** |

episodic-memory 与 claude-mem 是同一哲学两极（都不策展；前者连提取 LLM 都不要）。opencode-mem 是唯一做写时判断的。

## 6. 社区风评规律（HN 实测）

- **claude-mem**：声量断层第一，真实好评 + 具体批评（"buggy, token-heavy, complex setup"）；
- **OpenClaw memory**：设计被借鉴、实现被弃用——专骂帖 168 分/177 评（"unreliable, and you don't know when it will break"），周边长出十几个"修 OpenClaw 记忆"插件；
- **Claude Code auto memory**：成文批评最重（默认关闭文化 + 零改进研究）；
- **Copilot Memory**：装机量最大但零热情（默认开启铺开，不是被爱用）；
- **autoharness / self-learning-skills**：星涨快（各 ~950，6 周）但 Show HN 各 3 分 0 评——当蓝图看，不当验证过的标杆看。

**规律：声量与自动化程度成反比。** 做 L0-L1 的拿 90k 星；做全自动整理的被关闭和批评。"agent 自动管理记忆"目前不被信任，"人可控的简单记忆"被拥抱。

## 7. 定位结论

1. opencode 原生记忆 = 零，插件填真空，不与官方路线冲突；
2. L0-L1 是红海（claude-mem 90k★ + 两个 1.3-1.5k★ 原生插件），只做到 L1 是跟成熟产品拼工程；
3. **差异化 = 它们刻意不做的**：L2 复现触发+对比提炼、L3 执行验证规程、L4 词表涌现、带门禁的睡眠整理；
4. 采纳路径学 claude-mem：先把 L0-L1 做到可信（"它记得且查得到"），L2-L4 魔法藏后台渐进开（"不自作主张"）；
5. 1,080 runs 研究测的是"agent 随手写的记忆"，没测"重复触发+对比提炼+执行验证的记忆"——我们的 dogfooding 若证明后者有效，就是这个领域缺失的正面证据。
