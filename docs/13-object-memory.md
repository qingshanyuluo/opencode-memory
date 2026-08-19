# 13 知识对象、继承与按需加载

## 对象角色

长期记忆不是平面文档，而是五类对象：

| role | Java 类比 | 默认 pull |
|---|---|---|
| `interface` | 接口 | 是：稳定契约 |
| `abstract` | 抽象类 | 是：公共步骤与默认策略 |
| `implementation` | 实现类 | 是：项目/平台具体覆写 |
| `resource` | 依赖资源 | 是：SLS/OBS/Nacos/Redis/表/key/命令等 |
| `instance` | 具体对象/案例 | 否：仅请求证据时加载 |

`kind` 继续表达自由业务分类，不参与类加载语义。对象额外包含：

- `contract`：triggers/inputs/outputs/invariants/verification；
- `delta`：steps/overrides/defaults/boundaries 或实例 outcome/evidence；
- `content`：人类可读说明；
- provenance、status、confidence、validity。

## 固定结构关系

`IMPLEMENTS / EXTENDS / INSTANCE_OF / REFERENCES / SUPERSEDES / CONTRADICTS`。

确定性关系编译器校验角色配对并拒绝 EXTENDS 环：

- implementation/abstract → IMPLEMENTS → interface；
- implementation/abstract → EXTENDS → abstract；
- instance → INSTANCE_OF → implementation；
- implementation/instance/interface/abstract → REFERENCES → resource（另允许实例引用实现、实现引用实现）；
- SUPERSEDES/CONTRADICTS 只允许同角色。

## 三档异步整理

### Light：idle 会话 → instance

保存行为图的结果与高置信证据，实例自动 active，但默认不注入、不参与普通搜索。它是方法知识的证据对象。

### Medium：复现触发 → implementation/resource

跨会话复现词给 organizer 加权。两阶段模型先提候选，再由严格主编删除短命业务事实。输出 2-6 个 implementation，resource 仅作共享依赖；实例按证据重叠度挂到最匹配 implementation。

### Deep：多个 implementation → interface/abstract

知识变化后 30 分钟防抖运行（也可 `bun run refactor:knowledge`）。至少两个 implementation 才允许提取 interface/abstract。新契约、抽象和继承关系均保留生成来源；管理台可修改或删除。

## 类加载式 Pull

```text
memory_pull(query, namespace?, mode?, depth?, include_instances?, limit?)
```

- `auto`：匹配根对象，然后沿 IMPLEMENTS/EXTENDS/REFERENCES 展开；
- `interface`：只从接口入口加载实现；
- `implementation`：从具体实现入口加载父契约和依赖；
- `evidence` 或 `include_instances=true`：额外加载具体案例；
- depth 0-4，默认 2。

返回按 interface → abstract → implementation → resource → instance 排序，并包含对象关系。普通 pull 不返回 instance，避免证据淹没方法。

## 当前样本对象图

```text
interface: aichat-v2 事后数据验证接口
  ↑ IMPLEMENTS
implementation: BytePlus 实验分桶三态判别与掉出排查
implementation: 提示词修复验证（llm_raw）
  → REFERENCES resource: aichat-v2 日志/OBS/Redis 数据源速查

instance: 分钟级舔狗冷静期未生效日志排查
  → INSTANCE_OF BytePlus 实验分桶排查
```

管理台目录按 namespace → role → object 展示；主视图按 interface → abstract → implementation → instance 层级展开，resource 作为 REFERENCES 依赖展示。对象弹窗只允许修改或永久删除，不提供批准/驳回按钮。修改角色时会重新运行关系编译，非法修改整笔回滚。
