# 14 个人历史记忆回填

## 目标

不因模型成本限制回填范围。现有 1065 个会话中，初筛出约 723 个 coding/运维会话，按目录与归一化标题聚成约 697 个会话族。每个会话族选择工具与证据最完整的代表进入 L1b/对象化管线，其余 fork/延续会话作为 provenance 合并，避免重复生成 implementation。

## 优先沉淀内容

- 数据库连接与路由：DMS instance/database ID、schema/table、只读约束、时间列与查询范式；
- Aliyun SLS：region、project/logstore、service tag、trace/user/chat 关联、时间窗与聚合方式；
- Nacos、Redis、BytePlus、Kubernetes、Docker、部署与环境访问；
- Gradle/Maven/npm/测试、git/rebase/release-test、线上验证与日志排障；
- 多次失败后找到的可靠路径与不要再试的死路。

跨项目可复用的平台手册/工具坑可落到 `personal` namespace；项目实现留在项目 namespace，Deep Pass 再从多个实现提取 global interface/abstract。

## 队列

表：`backfill_families`、`backfill_members`。状态：pending/running/completed/skipped/failed。队列按工具调用、错误数和平台关键词加权排序，失败最多重试四次。构建过程持久化，worker 重启会将遗留 running 任务恢复为 pending。

默认两路并发：

```text
OPENCODE_MEMORY_BACKFILL_CONCURRENCY=2
OPENCODE_MEMORY_BACKFILL_AUTO=1
```

管理台左栏显示进度并支持暂停、继续和重试失败。也可前台运行：

```bash
bun run backfill
```

当队列完成后自动尝试一次 Deep Pass。

## 全局守护进程

```bash
bun run daemon:install
```

安装 `~/Library/LaunchAgents/io.opencode.memory.plist`。launchd 在登录时启动 worker，异常退出或手动 kill 后自动重启；队列中的 running 会在重启时恢复为 pending，再按 chunk 缓存断点续跑。日志：

```text
~/.local/share/opencode-memory/daemon.log
~/.local/share/opencode-memory/daemon.error.log
```
