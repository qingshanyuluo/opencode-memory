# opencode-memory

Local-first memory worker for opencode. The project captures lossless session data first, then derives recomputable memory artifacts asynchronously.

## 核心创新点

1. **「能力 / 对象 / 形态」三维正交知识本体**：知识按三个正交维度组织——**能力**（agent 能做什么，如诊断、查询、配置、验证、部署）、**对象**（针对什么，如消息、数据、代码）、**形态**（什么类型，如排障规程、平台手册、工具坑、抽象原则）。三层都由 LLM 自动生成，不写死任何分类，既稳定（能力维度是有限正交的），又能随知识内容自然扩展。

2. **「恢复成本」作为记忆价值的唯一判据**：不按「是否常用 / 是否重要」判断，而是按「如果忘掉这条，靠 `--help`、官方文档、一次搜索能否一步恢复」——恢复成本高的（踩坑归纳、项目特定锚点、被证伪的死路、抽象方法论）才值得记。这直接对齐「减少试错成本」这个核心 ROI，而不是「复现次数」这种表面指标。

3. **写时判断 + 注入零 LLM**：判断「值不值得记」放在会话结束的写时（异步，不影响前台）；每轮注入热路径**零 LLM**——只注入紧凑索引，正文通过 `memory_pull` 工具按需加载。避免把 LLM 延迟乘进工具循环，也避免每轮变化注入破坏 prompt cache。

4. **稳定 id + ON CONFLICT 的增量合并**：每条知识的 id 由 `namespace + role + kind + title` 哈希而来，同主题知识 id 相同，新会话提炼出的同类知识自动归并进旧条目（机器生成的覆盖更新、人工审核过的保留、置信度取 max），知识库不随会话增多而无限膨胀。

5. **薄壳 plugin + 独立 daemon 的进程外架构**：opencode 侧只挂一个薄适配层（注入索引 + 暴露 `memory_pull` 工具 + 监听会话空闲），提取 / 整理 / 检索全在独立 daemon 进程里跑，二者通过 REST 通信。与 opencode 的耦合收敛到稳定 REST 面（不依赖 experimental API），macOS 用 launchd、Linux 用 systemd 自动自启动，崩溃自愈。

6. **多级自适应层级**：从 implementation 自动抽象出 interface 层级（Map-Reduce），顶层是 AI 自动发现的能力域，数量随知识演化而动态变化，而非预设的固定分类。

## Status

The repository currently contains the project foundation:

- Bun + strict TypeScript
- SQLite schema for durable L2+ entries, links, and operation logs
- one-time L1a compiler for local opencode databases
- adapter contracts for direct, read-only opencode access
- research, architecture, and roadmap documents under [`docs/`](docs/README.md)

The installed opencode plugin now queues idle sessions for asynchronous behavior extraction and durable knowledge organization. The hot path only injects a compact memory directory and serves the pull tool; it never runs an LLM.

## Install

Requirements: macOS / Linux + [Bun](https://bun.sh).

```bash
# 1. 安装依赖
bun install

# 2. 配置模型 provider
#    默认用 deepseek/deepseek-v4-flash，需在 ~/.local/share/opencode/auth.json 里配好 deepseek key；
#    换模型/端点：复制 .env.example 为 .env 并设置 OPENCODE_MEMORY_BEHAVIOR_MODEL 与对应 provider 的 key/baseURL。

# 3. 编译初始语料（一次性读取本机 opencode.db，生成 L1a 索引）
bun run bootstrap

# 4. 安装 daemon 自启动 + 生成 opencode 全局插件 loader
bun run daemon:install

# 5. 重启 opencode 使插件生效
```

`daemon:install` 会按平台自动选择自启动方式，并把插件 loader 写到
`~/.config/opencode/plugins/opencode-memory.ts`（路径按实际安装位置动态生成）：

- **macOS** → launchd（`~/Library/LaunchAgents/io.opencode.memory.plist`，`KeepAlive` 崩溃自愈）。
- **Linux** → systemd user unit（`~/.config/systemd/user/opencode-memory.service`，`Restart=always`）。

daemon 与插件配合避免重复启动：daemon 启动时若已有健康实例则静默退出，
插件只在 daemon 挂掉时用文件锁兜底拉起（多会话并发互斥）。

## Development

```bash
bun install
bun test
bun run typecheck
bun run start
```

Environment variables are documented in [`.env.example`](.env.example).

## Build The Initial Corpus

The bootstrap command reads the local `opencode.db`, `opencode-dev.db`, and
`opencode-local.db` databases once and creates a deterministic L1a index:

```bash
bun run bootstrap
```

The generated `~/.local/share/opencode-memory/bootstrap.db` contains session manifests, sanitized tool
event summaries, artifacts, errors, and an FTS index. It does **not** copy raw
assistant text or successful tool output. Every derived row retains source
database and session/message/part identifiers so later stages can read the
original data on demand.

Rebuild explicitly with `bun run bootstrap -- --force`.

Future runtime memory is stored separately at
`~/.local/share/opencode-memory/memory.db`. Neither database belongs in the
project checkout.

## Dashboard

The opencode plugin starts a local dashboard automatically at:

```text
http://127.0.0.1:37780
```

It exposes the sanitized L1a corpus: aggregate statistics, full-text session
search, user intent, normalized tool events, errors, and source anchors. It
also shows generated L1b behavior graphs and the object-oriented long-term
knowledge graph (`interface`, `abstract`, `implementation`, `instance`, and
`resource`). It does not expose
raw assistant messages, chain-of-thought, or successful tool output. The
knowledge view allows human review of generated entries without modifying the
source opencode databases.

The opencode system prompt receives a stable level-1 capability index for each
session. The `memory_pull` tool loads knowledge like classes: match a contract or
implementation, expand inheritance and references, and include concrete
instances only when evidence is requested.

The dashboard includes recall observability: system-index injection coverage,
pull hits/misses, loaded roles, average/P95 latency, follow-up tool activity,
and human useful/not-useful/missed-recall feedback. Hit rate is deliberately
not presented as true recall without human ground truth.

Historical consolidation is persistent and resumable. On first launch it
groups technical sessions into families, selects the richest representative,
merges fork provenance, and continuously builds the personal object graph.

Install the macOS user daemon with `bun run daemon:install`. It starts at login
and is restarted by launchd after crashes or manual termination.

The installed global loader is:

```text
~/.config/opencode/plugins/opencode-memory.ts
```

Restart opencode after changing the plugin or dashboard configuration.

## Structure

```text
src/
├── adapter/       # Stable boundary around opencode REST/SQLite surfaces
├── bootstrap/     # Deterministic L1a corpus compiler
├── store/         # Project-owned SQLite schema and persistence
├── config.ts      # Environment configuration
└── index.ts       # Worker entry point
test/              # Unit tests
docs/              # Research, philosophy, design, and roadmap
```
