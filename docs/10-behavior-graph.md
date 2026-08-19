# 10 L1b 模型行为图

## 目的

L1a 只能回答“用户说了什么、agent 调了什么工具”。L1b 从 opencode 原库回源读取 user / assistant / reasoning / tool parts，重建 agent 的可观察认知变化：

```text
目标 → 假设 → 动作 → 证据 → 修正 → 决策 → 结果
```

原始 chain-of-thought 不作为记忆保存。提取器只落短陈述、状态、置信度和 source part IDs；原始文本仍留在 opencode 源库。

## 节点与边

节点类型：`goal / hypothesis / action / evidence / revision / decision / outcome / open_question`。

状态：`proposed / confirmed / rejected / partial / unknown`。

边：`supports / contradicts / leads_to / revises / answers / blocks`。

每个节点必须引用至少一个当前 chunk 内真实存在的 part ID；模型虚构的 ID、空证据节点、悬空边会被确定性校验丢弃。

## 提取策略

1. 按用户回合组织事件；
2. 每回合保留用户目标、有限 reasoning、assistant 的判断更新、关键工具动作和全部错误；重复 read/grep/glob 只留代表性动作；
3. 若大块模型输出失败，按事件边界自动二分；
4. 每个成功子块立即缓存到 `episode_chunk_results`，失败后重跑会断点续用；
5. 整个 session 完成后事务替换 capsule/nodes/edges，避免半成品对管理台可见。

## 使用

```bash
bun run extract:behavior -- \
  --source main \
  --session ses_02446e44fffeYZLh6VuqPDqCCK
```

默认模型来自 opencode 已配置的 `deepseek/deepseek-v4-flash`，可通过 `OPENCODE_MEMORY_BEHAVIOR_MODEL` 替换；provider key 优先读 opencode config，缺失时读 opencode auth store，凭据不进入项目文件或 memory.db。

## 首个复杂样本

`ses_02446e44fffeYZLh6VuqPDqCCK` 已生成：185 节点 / 132 边 / 18 个主块，全部 185 个节点的 part 引用在源库中存在。轨迹可识别：

- “男用户消息导致提前触发”假设被日志与代码证据修正为“缺少 timer 重置机制”；
- geo 与代码版本两个假设被对照证据否定；
- probe 默认值 `false` 无法区分对照组与未进实验，修正为 SENTINEL 后确认未分桶；
- 按天计数方案被滚动 24h ZSET 决策取代；
- 多次实现、测试、PR 与线上验证结果均有证据引用。

管理台会话详情现在优先展示“模型行为与认知轨迹”，L1a 用户意图和工具档案放在其后。当前仅提取两个试验会话，尚未批量运行全库。
