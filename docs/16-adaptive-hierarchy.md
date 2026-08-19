# 16 自适应多级整理（递归 Map-Reduce）

## 核心

层级不是固定的。输入是原子 implementation；每轮：

```text
Map：局部归组 + 提炼父契约
Reduce：全局合并/规范化所有父契约
递归：父契约作为下一轮原子
终止：无父契约，或本轮压缩率不足 15%
```

深度由数据自然决定，代码仅有 8 层安全上限（防异常，不是目标层数）。

## 编译器约束

- 每个父节点至少 2 个 child；
- 每个 child 每轮最多一个主父节点；
- Map 不允许虚构 child ID；
- Reduce 必须覆盖每个 proposal，允许单 proposal 保留；
- 父节点必须比子节点更抽象，禁止只改标题；
- 每层必须有效压缩（parent/child < 0.85），否则停止；
- 实现通过 IMPLEMENTS 挂父接口，接口通过 EXTENDS 挂更高接口；
- REFERENCES 保留为旁路图，不参与主树父关系。

## 持久化与断点

- `hierarchy_runs`：run/level/stage/progress/result/error；
- `hierarchy_cache`：按 model+prompt+input hash 缓存 Map/Reduce 结果；
- 中断后重新运行会复用已完成 batch；
- 全部层完成后一次事务替换生成的 interface 与 IMPLEMENTS/EXTENDS，避免半成品进入 pull。

## 当前运行

`POST /api/memory/refactor` 或 `bun run build:hierarchy`。管理台左栏显示 level、Map/Reduce 和 batch 进度。

固定 9 个 domain 只作辅助索引，不决定层数；递归接口树是主结构。
