# 17 opencode 系统注入与 Pull Tool

## 安装

全局 loader：

```text
~/.config/opencode/plugins/opencode-memory.ts
```

它引用本项目 `plugin/opencode-memory.ts`。修改插件后需要退出并重启 opencode；worker 由 launchd 独立守护。

## 系统提示词

hook：`experimental.chat.system.transform`。每个 session 注入一次生成、后续字节稳定的 `<memory-system-index>`：

```text
总对象数
能力域及数量（检索/日志诊断/数据查询/...）
对象角色分布
当前项目 namespace 的相关对象标题
memory_pull 调用规则
```

目录不是任务指令，不包含记忆正文。插件不再通过 `chat.message` 写 synthetic user part。

## 工具

```text
memory_pull(
  query,
  domain?,
  namespace?,
  mode = auto|interface|implementation|evidence,
  depth = 0..4,
  include_instances = false,
  limit = 8
)
```

`mode=auto` 返回根命中并沿继承/引用类加载。结果按 interface → abstract → implementation → resource → instance 排序，并包含 contract、delta、结构关系和来源 session。

## 验证

当前版本实测：

```text
user message parts: 0
system index count: 1
same session index stable: true
memory_pull(query=websearch, domain=检索): 命中 Pi WebSearch implementation
```
