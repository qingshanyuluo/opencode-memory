# 09 本地记忆管理台

## 定位

管理台对 opencode 原始数据和 L1a 档案保持只读；“长期知识”页允许人类修改或删除 `memory.db` 中的 L2/L3 对象。

默认地址：`http://127.0.0.1:37780`。只绑定 localhost，不提供 opencode 原始数据写、删或回源全文接口。

## 启动方式

全局插件已安装到：

```text
~/.config/opencode/plugins/opencode-memory.ts
```

opencode 初始化插件时先请求 `/api/health`；服务不存在则从本项目启动独立 Bun worker。配置或插件代码变更后需要退出并重启 opencode。

也可独立运行：

```bash
bun run dashboard
```

环境变量：

```text
BOOTSTRAP_DB_PATH=~/.local/share/opencode-memory/bootstrap.db
OPENCODE_MEMORY_DASHBOARD_HOST=127.0.0.1
OPENCODE_MEMORY_DASHBOARD_PORT=37780
```

## 页面能力

- corpus 总量、工具失败、锚点和来源库统计；
- trigram FTS：检索中文、英文、代码标识符、文件/命令/错误；
- source 过滤与分页；
- 会话详情：脱敏用户意图、文件/命令/URL/错误锚点、规范化工具轨迹；
- provenance：source/session/message/part 标识，可供后续 L1b/L2 回源。

## 安全边界

- 成功工具输出、assistant 全文、reasoning 不进入 bootstrap.db；
- 用户输入与工具入参经过确定性凭据脱敏；
- 原始档案 API 只读；知识对象 API 仅允许修改和删除，默认只监听 `127.0.0.1`；
- 管理台不连接业务数据库、不运行 shell、不提供原始 opencode 数据下载。
