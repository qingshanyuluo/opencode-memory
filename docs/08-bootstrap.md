# 08 初始语料编译（L1a）

> 目标不是备份 opencode，而是把上游私有 schema 编译成稳定、降噪、可检索且可回源的目录。

## 输入

默认读取本机三个只读数据库：

| source_id | 路径 | 当前会话数 |
|---|---|---:|
| main | `~/.local/share/opencode/opencode.db` | 810 |
| dev | `~/.local/share/opencode/opencode-dev.db` | 195 |
| local | `~/.local/share/opencode/opencode-local.db` | 5 |

三库 session ID 无重叠，共 1010 个会话。

## 转换边界

**保留（派生信息）**：session 元数据与统计、全部用户意图文本（脱敏）、工具名/状态/规范化入参、错误首行签名、文件/命令/URL/错误锚点、trigram FTS、源 row IDs 与内容 hash。

**不复制**：assistant 全文、reasoning、step-start/finish、成功工具输出、原始 JSON payload。后续 L1b/L2 按 source/session/message/part ID 回源获取证据。

这条边界保证 `bootstrap.db` 是**目录/索引**而不是第二份原料库，也降低历史工具输出中凭据泄露的风险。

## 命令

```bash
bun run bootstrap
# 输出：~/.local/share/opencode-memory/bootstrap.db

# 显式重建
bun run bootstrap -- --force

# 自定义输出
bun run bootstrap -- --output /path/to/bootstrap.db --force
```

构建写入临时数据库，成功后原子替换目标；目标已存在时默认拒绝覆盖。运行数据统一位于 `~/.local/share/opencode-memory/`，不进入项目目录。

## 输出表

- `sources`：源路径、大小、mtime、扫描时间；
- `session_documents`：每会话一份 manifest（意图、统计、锚点文本、错误文本、hash）；
- `tool_events`：规范化工具事件，成功输出为空，错误保留脱敏签名；
- `artifacts`：去重锚点（file/command/url/error）；
- `session_documents_fts`：面向中英文与代码标识符的 trigram 全文索引。

## 下一层如何使用

L1b/L2 先查 `session_documents_fts` 和复现频次，选出值得处理的 session；然后通过 provenance 回源读取完整消息/part，交给小模型做叙事压缩、对比与归纳。插件在线运行时不执行本脚本，也不复制历史。
