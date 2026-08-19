# 18 记忆召回观测

## 原则

没有人工 ground truth 时，不能把“有返回结果”叫真正召回率。系统区分：

| 指标 | 定义 |
|---|---|
| Hit Rate | `memory_pull` 返回对象数 > 0 的调用比例 |
| Coverage | 调用过记忆的唯一 session/project 数、系统索引注入数 |
| Load Depth | 返回 interface/implementation/resource/instance 数量与请求 depth |
| Latency | pull 平均与 P95 毫秒耗时 |
| Follow-up Proxy | pull 后 15 分钟内的工具调用/编辑次数（只作使用后行为代理） |
| Human Usefulness | 人工标注 useful / not_useful 的比例 |
| Missed Recall | 人工标注该次召回漏掉关键知识；用于后续真实召回评测 |

只有 Human Usefulness / Missed Recall 能逐步形成真实 precision/recall 评测集。

## 数据来源

运行时：系统目录注入与 `memory_pull` 直接 POST telemetry。历史与兜底：每 60 秒只读扫描 opencode 三库中的 `tool=memory_pull` part，回填 query、输出、start/end、session/directory/agent，并统计后续 15 分钟工具行为。

runtime 输出携带 `recall_id`；DB importer 读取该 ID，合并为同一事件并补 source part 与 follow-up，避免双计数。

## 表

- `memory_injections`：每 session 的一级索引注入；
- `memory_recalls`：完整 pull 请求/结果/角色构成/耗时/后续行为；
- `memory_feedback`：useful / not_useful / missed + note。

## Web UI

`http://127.0.0.1:37780/?view=observability`

展示：核心指标卡、每日趋势、能力域命中、项目覆盖、类加载角色、最近召回与三种反馈按钮。

首批历史回填发现 opencode.db 中已有 11 次真实 pull，全部 miss。这只是早期索引尚未完善的基线，不足以评价系统；后续样本持续积累后再分析。
