# 15 能力域索引层

## 问题

知识天然多分类。`pi agent websearch 方法调研` 同时是“检索”知识和“agent”知识，单归属 namespace（树）会丢信息，且 namespace 被既当项目名又当领域名，出现 `git`/`版本控制`/`global` 碎片。

## 设计

两个正交维度：

| 维度 | 含义 | 稳定性 | 用途 |
|---|---|---|---|
| `domain` | 能力域 | 稳定、小词汇表 | 最底层索引、跨项目检索 |
| `namespace` | 项目/来源 | 自由文本 | provenance 与过滤 |

9 个规范化能力域（`kind='能力域'` 的 interface 对象）：

```text
检索 / 日志诊断 / 数据查询 / 配置接入 / 部署发布 /
验证评测 / agent-runtime / 代码库分析 / 服务契约
```

## 结构

```text
interface: 检索能力契约（稳定，global）
  ↑ IMPLEMENTS
implementation: Pi 添加 web search 的选型与实施
  ↑ IMPLEMENTS（可选，跨域多分类）
interface: agent 运行时契约
```

- 每个 implementation 按能力域分类，`IMPLEMENTS` 对应域接口；
- 资源与实例带上 `domain` 列参与分组和 FTS，不强制挂接口；
- 域接口 content 内嵌检索关键词，FTS 命中即把整个域入口带出。

## 分类

`src/knowledge/domains.ts` 的关键词分类器，按命中关键词**总长度**打分（长词更特异），避免“配置/模型”这类宽泛词吞掉“opencode/子代理”。未命中的条目 domain 为空，等待模型辅助分类（暂未开启）。

## 维护

- `KnowledgeDomainIndexer`：确保域接口存在、给未分类条目赋域、把实现挂到域接口。幂等、可续跑。
- 已接入守护进程：知识变化后 5 分钟防抖，回填结束后也会跑一次。
- 手动：`bun run index:domains`，或 `POST /api/memory/index`。

## 结果

首次运行：9 个域接口、1247 个条目赋域、674 条实现挂域，仅 4 条未分类。域分布：agent-runtime 307、配置接入 161、服务契约 144、验证评测 142、日志诊断 141、数据查询 122、部署发布 119、代码库分析 85、检索 35。

pull 命中域接口后，沿 IMPLEMENTS/REFERENCES 展开到具体实现与依赖。
