# 05 理念与知识模型

> 第二轮讨论沉淀（2026-08-11）。本文件是项目的"宪法"：核心理念、知识精炼阶梯、通用存储原语。
> 与 02-design 的关系：02 的触发/注入架构不变；02 §7 的知识组织方式被本文 §8 的通用原语**取代**（supersedes）。

## 1. 核心理念

**把 agent 的探索从一次性费用，变成可复利的资产。**

agent 每次自我探索（试错、查日志、读代码、踩坑）烧掉的 token 和时间，在会话结束时归零——纯费用。记忆系统的本质是**资本化机制**：同一个认知只买一次，之后每次复用都是零成本分红。

```
飞轮：探索 → 沉淀 → 注入 → 不再重复探索 → 省下的算力探索新边界 → 更多沉淀
ROI = 复用次数 × 单次探索成本 − 维护成本 − 注入税
```

实证依据（本机 opencode 三库，共 1010 会话）：VideoTips 被 175 个会话触及、NewMinuteDog 136、SLS 查日志 104——**复用次数是三位数**，ROI 天然为正。这也解释了为什么 LoCoMo 类 benchmark（复用≈1）证明不了记忆的价值，而我们的场景不需要 benchmark 证明。

### 五条支撑原则

1. **原料不可再生，产物皆可重算**——原始转录是唯一不可再生资产；提取/图谱/索引都是衍生品，随时用更好的模型重算。囤原料优先于建管线。
2. **知识即代码**——记忆库是工程产物：契约与锚点分离、版本演化（supersede 不删除）、由异步整理器持续重构。
3. **原语固定，语义涌现**——系统只硬编码极少原语，分类法从使用中长出。通用性不来自设计得全，而来自约定得少。
4. **反思是异步的**——记忆形成发生在"睡眠期"，绝不侵入执行热路径。
5. **错的记忆比没有记忆更糟**——写时宁缺毋滥、过期必须失效、注入必须有界。

### 反对清单

反对囤积主义（未整理的存储只是更大的垃圾堆）；反对预设本体（单场景分类法必然过拟合）；反对热路径干预；反对 benchmark 崇拜（唯一评测是自己的重复任务少走了多少弯路）。

## 2. 知识精炼阶梯（L0-L4）

原料→知识不是一次提取，是逐级压缩的阶梯。越往上越稳定、越通用、注入越便宜。

| 层 | 内容 | LLM 依赖 | 晋升触发 |
|---|---|---|---|
| **L4 词表** | 知识的知识：稳定下来的 kind/rel 词汇表 | 批量归拢用 | 定期批处理（词表普查） |
| **L3 规程** | 可执行知识：runbook / workflow（含排除清单） | 归纳用 | 成功路径重复 + **执行验证** |
| **L2 洞见** | 跨情节归纳：去情境化真理、坑卡、口径 | **必需**（真正的分水岭） | **复现检测** + 显著性累积 |
| **L1b 叙事** | 单会话语义压缩：概述、转折、类型标签 | Haiku 级、异步、**可重算可延后** | 会话结束 |
| **L1a 骨架** | 确定性解析：文件/命令/报错/PR/触及组件 | **零**（JSON 字段+正则） | 捕获时同步 |
| **L0 情节** | 原始转录，永不改动，带出处 | **零** | 实时 |

关键性质：

- **coding 转录是半结构化的**（聊天记忆没有的红利）：opencode `part` 表里工具调用天生带结构，大半个 L1 靠确定性解析白拿。
- **坑卡（pitfall）是唯一可单例晋升的 L2**——失败自带执行验证（报错即证据）；但也是**最易过期**的记忆（负面结论无法便宜地 JIT 验证），必须带 `valid_to` + 报错原文锚点。
- 试错过程属于 L0，试错的价值属于 L2（坑卡），归宿是 L3（规程的"已证伪岔路"清单）。

## 3. 三种驱动力

| 力 | 机制 | 证据 |
|---|---|---|
| **重复** | 抽象是对重复的压缩；单例只能压缩（L1），重复才能归纳（L2） | AWM 从重复轨迹归纳 workflow，WebArena +51%（arXiv 2409.07429）；RecMem 只在语义相似交互复现时才巩固，**省 87% token 且更准**（arXiv 2605.16045）；folksonomy 频率幂律收敛 |
| **对比** | 洞见来自差分：成功/失败轨迹对 | ExpeL 用同任务成败对 + 跨任务成功列表提洞见；洞见池 ADD/EDIT/UPVOTE/DOWNVOTE，计数归零删除（arXiv 2308.10144） |
| **回放** | 巩固发生在离线自问自答 | Generative Agents：重要性累积超阈值 → **"问自己 3 个最突出的高层问题"** → 问题当检索词 → 提炼洞见并引用证据编号 → 反思树（arXiv 2304.03442）。反思=向自己的记忆提问，不是"总结一下" |

## 4. 知识即代码（L3 的构造法）

1. **换元即抽象**：AWM 把 "dry cat food" 换成 `{product-name}`——实例→函数就是变量替换；
2. **组合即调用**：已归纳的 workflow 成为更复杂 workflow 的子目标；
3. **执行即真理**：Voyager 技能只有通过执行+批评者验证才入库（去掉自验证 -73% 效果，arXiv 2305.16291）。**runbook 的验证 = 下次照着跑是否省调用**——dogfooding 是 L3 的构造性环节，不只是评测。

CoALA 警告：程序性知识写入风险最高（错的规程被反复执行）→ L3 晋升门最严。可采标准（self-learning-skills 的三条件门）：**一个通过的检查 + 一个被命名的失败模式 + 至少一个被排除的死路**。

## 5. 语义涌现（L4 的收敛法）

不是放任，是三环循环，缺一环就同义词爆炸：

1. **环 1 自由生成**：提取时词汇不设限（OpenIE/A-MEM 式）；
2. **环 2 模仿回灌**：**生成新词时让模型看得见旧词**（EDC 把已有 schema 检索进提取 prompt，arXiv 2404.03868；Graphiti 解析到"最完整的已有名字"）。命名博弈证明仅靠局部模仿即发生相变式收敛（Baronchelli 2006）；
3. **环 3 定期归拢**：批量 embedding 聚类 + LLM 裁决合并（CESI / BERTopic / AutoSchemaKG conceptualization，arXiv 2505.23628）。批处理归拢比逐条便宜（"Better Later Than Sooner"）。

失败模式：只做环 1 = 同义词爆炸；不做环 3 = 漂移（Graphiti 自认社区结构会发散，需定期刷新）。

## 6. 架构原型：CLS 双存储 + 睡眠

CLS 理论（McClelland 1995；Kumaran/Hassabis/McClelland 2016）：新皮层"慢速从经验集合发现结构"，海马体"快速学习新项目而不破坏该结构"，转移靠睡眠回放。映射：

```
L0-L1 = 海马体（快、逐字、无损、即写）
L2-L4 = 新皮层（慢、结构化、间隔混合地学 = 重复+对比）
异步整理器 = 睡眠回放（选择性，不是均匀回放）
```

工程量化验证：Letta sleep-time compute **省 5x 测试时算力**、+13~18% 准确率（arXiv 2504.13171）；HippoRAG 在线检索**便宜 10-30x**（arXiv 2405.14831）；RecMem **87%**；Auto-Dreamer（CLS 明确启发，arXiv 2605.20616）。

## 7. 存储原语（通用记忆架构）

> 取代 04 文档的六类节点/八种边硬编码本体——那是从单个排障会话过拟合的特解。

**固定层（代码实现，永不变）**：

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,           -- Markdown 正文
  kind TEXT,                       -- 自由标签，非枚举，涌现（runbook/decision/pitfall…自然长出）
  namespace TEXT,                  -- 归属域，自动推断，可多属
  tags TEXT,                       -- JSON 数组
  source_session TEXT,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,                -- 被 supersede 时填，不删除
  embedding BLOB
);
CREATE TABLE links (
  src TEXT NOT NULL, dst TEXT NOT NULL,
  rel TEXT NOT NULL,               -- 自由文本短语
  valid_from INTEGER NOT NULL, valid_to INTEGER,
  PRIMARY KEY (src, dst, rel)
);
```

**特权谓词只有三个**（系统有特殊逻辑）：`supersedes`（检索时自动过滤旧口径）、`references`（召回扩散 1-2 跳）、`related`（兜底弱关系）。其余 rel 自由生成，系统只存不解释。

**四个通用整理动作**（领域无关）：`merge`（合并相似）/ `abstract`（多具体→一通用，即"提取公共接口"）/ `link` / `supersede`。全部进操作日志，可回放可审查。

**设计谱系**（哪条抄自哪里）：

| 本设计 | 先例 |
|---|---|
| 特权谓词+自由 rel 的切分 | Graphiti：固定系统边（MENTIONS/RELATES_TO）+ 自由语义 name/fact；"Prescribed & Learned Ontology: …let structure emerge from your data. Start simple, evolve as patterns appear" |
| LLM 生成 kind/tags/links 无分类法 | A-MEM（arXiv 2502.12110，NeurIPS 2025）："without predefined rules"、"emerges organically" |
| 词表定期收敛 | AutoSchemaKG conceptualization + A-MEM evolution |
| valid_to 失效不删除 | Graphiti 双时间（t_valid/t_invalid，"invalidated — not deleted"） |
| 谓词自由文本 | OpenIE 传统（Banko 2007 TextRunner → HippoRAG "schemaless KG"） |

**A-MEM 采信边界**（详见调研）：论文数字全部自报、无任何第三方复现成功（GitHub 复现 issue 全部大幅偏低）、LoCoMo benchmark 本身公信力已破产——**抄设计不抄代码不按其数字设预期**。演化机制只准动 tags/links，**不准改 content**（LLM 改写历史会漂移/腐化，TRUSTMEM 实测遗漏/污染/幻觉，arXiv 2606.25161）。

## 8. 质量边界（复利兑现的前提）

1. **保鲜**：机制知识随代码腐烂；`valid_to`/`supersedes` + 锚点是防记忆变谎话的生命线。锚点应为**可机器验证的谓词**（文件存在？key 还在？配置还是这个值？）——注入前 JIT 验证，通过则续命（Copilot Memory 模式：citations + 实时验证 + 28 天过期，A/B 实测 PR 合并率 +7%）。
2. **精度优先于召回**：10 条准的记忆比 100 条半准的值钱。写时判断带 skip 偏置。
3. **注入税**：注入的每条记忆后续每轮烧 token → 有界注入（首消息一次、带 token 价签的索引式渐进披露）。

**L2 验收标准**（把 claude-mem 作者不做 L2 的理由反转成清单）：有晋升门（错误结论进不来）、有执行验证（结论由成功背书）、有 valid_to（结论会过期）、原料永留（结论永远可重算）。我们不反驳"让未来更强的模型去归纳"的哲学——**只是给它加一层缓存**：重算从每次读取的运行时，改为睡眠期批处理 + 结果缓存。

市场反面教材：Claude Code auto memory 被用户成规模关闭（存入"严重错误的陈述"）；1,080 runs 对照研究显示 agent 随手写的记忆零改进（2026-08，HN 49247780）；Cursor 3.0 撤掉 Memories。**无门禁的自动记忆已被市场证伪**——门禁不是可选项。
