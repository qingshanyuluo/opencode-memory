# 11 自动记忆闭环

## 数据流

```text
session.idle / session.status{idle}
  → 全局插件 POST /api/process（fire-and-forget）
  → 用户活动取消待处理；idle 后 5 分钟静默防抖 + 串行队列
  → L1b 行为图（目标/假设/证据/修正/决策/结果）
  → L2/L3 organizer（3-12 条长期知识 + links）
  → generated entries
  → 管理台修改或删除对象
  → system transform 注入一级能力域目录
  → agent 按需调用 memory_pull 拉正文
```

热路径只有目录 API 和 pull 搜索，不调用模型。idle 整理失败只记录 `processing_jobs`，不影响 opencode 会话。

## 长期知识晋升

organizer 经“候选提取 + 严格主编”两阶段，只晋升跨需求可复用的方法论、平台手册、排障规程、工程约定和工具坑；具体业务规则留在行为图。详见 [12-promotion-policy.md](12-promotion-policy.md)。每条 entry 必须引用真实 behavior node sequence，最终保存 source session + behavior node IDs。

新对象可立即被 pull，并携带生成状态和证据来源。管理台不提供“批准/驳回”流程，只允许人类修改对象（标题、正文、role、contract、delta）或永久删除。结构修改会经过关系编译器，非法角色关系或继承环会整笔回滚。

## 系统提示词一级索引注入

全局插件通过 `experimental.chat.system.transform` 注入 `<memory-system-index>`：只包含能力域目录、对象角色分布、当前项目相关标题和 `memory_pull` 协议，不包含正文。每个 session 首次生成后缓存同一字节串，后续 agent-loop step 重复注入完全一致，避免 prompt cache 抖动。

`chat.message` 只预热目录并取消 idle 整理，不再插入 synthetic user part，因此会话历史不会被记忆索引污染。会话删除事件会清理 session 级缓存。

## pull tool

```text
memory_pull(query, domain?, namespace?, mode?, depth?, include_instances?, limit?)
```

查询 `entries_fts` 后像类加载一样沿 IMPLEMENTS/EXTENDS/REFERENCES 展开。`domain` 来自系统提示词中的一级能力域索引；默认不返回 instance，`mode=evidence` 或 `include_instances=true` 才加载案例。返回状态、domain、对象角色、contract、delta、namespace、置信度、来源 session 和 memory_id。

## 管理台

“长期知识”页提供：

- namespace → kind → entry 目录树；
- entry/link SVG 关系图；
- 对象/关系计数；
- 全文搜索、人工修改和永久删除。

## 配置

```text
OPENCODE_MEMORY_IDLE_DEBOUNCE_MS=300000
OPENCODE_MEMORY_BEHAVIOR_MODEL=deepseek/deepseek-v4-flash
OPENCODE_MEMORY_MODEL_TIMEOUT_MS=300000
```

自动模式默认跳过 `parent_id` 非空的子代理会话，避免父会话与研究子任务重复晋升。需要时仍可用手工脚本针对子会话提取。
