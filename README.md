# opencode-memory

Local-first memory worker for opencode. The project captures lossless session data first, then derives recomputable memory artifacts asynchronously.

## Status

The repository currently contains the project foundation:

- Bun + strict TypeScript
- SQLite schema for durable L2+ entries, links, and operation logs
- one-time L1a compiler for local opencode databases
- adapter contracts for direct, read-only opencode access
- research, architecture, and roadmap documents under [`docs/`](docs/README.md)

The installed opencode plugin now queues idle sessions for asynchronous behavior extraction and durable knowledge organization. The hot path only injects a compact memory directory and serves the pull tool; it never runs an LLM.

## Install

Requirements: macOS + [Bun](https://bun.sh).

```bash
# 1. 安装依赖
bun install

# 2. 配置模型 provider
#    默认用 deepseek/deepseek-v4-flash，需在 ~/.local/share/opencode/auth.json 里配好 deepseek key；
#    换模型/端点：复制 .env.example 为 .env 并设置 OPENCODE_MEMORY_BEHAVIOR_MODEL 与对应 provider 的 key/baseURL。

# 3. 编译初始语料（一次性读取本机 opencode.db，生成 L1a 索引）
bun run bootstrap

# 4. 安装 daemon（launchd，开机自启 + 崩溃自愈）+ 生成 opencode 全局插件 loader
bun run daemon:install

# 5. 重启 opencode 使插件生效
```

安装后 `daemon:install` 会自动把插件 loader 写到
`~/.config/opencode/plugins/opencode-memory.ts`（路径按实际安装位置动态生成）。
daemon 以 launchd 为主（`KeepAlive` 自愈），插件只做 health check 兜底并在多
会话并发下拉起时用文件锁互斥，避免重复绑定端口。

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
