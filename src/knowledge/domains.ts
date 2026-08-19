import { createHash } from "node:crypto";

export interface Domain {
  id: string;
  title: string;
  description: string;
  keywords: string[];
}

export const CANONICAL_DOMAINS: Domain[] = [
  {
    id: "检索",
    title: "检索能力契约",
    description: "如何用 websearch、grep/glob、FTS、向量、外部数据源等手段定位与检索信息，以及被反爬/索引缺失时的替代路线。",
    keywords: ["websearch", "search", "检索", "grep", "glob", "fts", "向量", "embedding", "reddit", "pullpush", "搜索", "web_fetch", "webfetch"],
  },
  {
    id: "日志诊断",
    title: "日志诊断契约",
    description: "用 SLS 等日志系统按 traceId、userId、chatId、时间窗定位问题，并做跨数据源交叉验证。",
    keywords: ["sls", "日志", "log", "traceid", "trace", "排障", "定位", "时间分桶", "logstore", "日志查询", "onepilot", "logtail"],
  },
  {
    id: "数据查询",
    title: "数据查询契约",
    description: "数据库与缓存查询：DMS、PostgreSQL/MySQL/ADB、Redis、分区表、行数与完整性校验。",
    keywords: ["dms", "数据库", "redis", "postgres", "pg", "mysql", "adb", "greenplum", "sql", "查询", "表", "字段", "分区", "索引", "zset", "hash"],
  },
  {
    id: "配置接入",
    title: "配置接入契约",
    description: "模型/服务/网关的 provider、模型、nacos、环境变量等配置接入、验证与生效条件。",
    keywords: ["provider", "模型", "配置", "接入", "nacos", "api", "base_url", "baseurl", "网关", "gateway", "路由", "实验", "abtest", "byteplus", "模型服务"],
  },
  {
    id: "部署发布",
    title: "部署发布契约",
    description: "k8s、docker、git、release/test、镜像、构建与发布，以及环境访问与连通。",
    keywords: ["k8s", "kubectl", "docker", "部署", "发布", "release", "merge", "git", "jenkins", "镜像", "pr", "分支", "port-forward", "ingress", "构建"],
  },
  {
    id: "验证评测",
    title: "验证评测契约",
    description: "验证修复是否生效、评测模型质量、核对数据完整性与统计口径、回归判定。",
    keywords: ["验证", "评测", "盲评", "benchmark", "评分", "核对", "校验", "完整性", "断言", "回归", "测试", "对齐", "diff", "对账"],
  },
  {
    id: "agent-runtime",
    title: "agent 运行时契约",
    description: "coding agent 的工具、子代理、提示词、模型档位、配置与插件扩展机制。",
    keywords: ["agent", "子代理", "subagent", "工具", "tool", "提示词", "prompt", "注入", "opencode", "claude code", "codex", "pi ", "插件", "扩展", "skill", "tui", "运行时"],
  },
  {
    id: "代码库分析",
    title: "代码库分析契约",
    description: "对未知代码库/仓库做只读侦察、结构理解、功能定位、作者归属与架构判断。",
    keywords: ["代码库", "仓库", "代码", "源码", "模块", "架构", "重构", "结构", "侦察", "理解", "定位", "分析", "职责"],
  },
  {
    id: "服务契约",
    title: "服务契约契约",
    description: "gRPC/protobuf/HTTP 跨服务契约、字段回退链、枚举兼容与 SDK 发布。",
    keywords: ["grpc", "protobuf", "proto", "契约", "服务", "sdk", "接口", "消息", "枚举", "rpc", "跨服务"],
  },
];

export const DOMAIN_BY_ID = new Map(CANONICAL_DOMAINS.map((domain) => [domain.id, domain]));

export function classifyDomain(fields: string[]): string | null {
  const haystack = fields.join(" ").toLowerCase();
  let best: { id: string; score: number } | null = null;
  for (const domain of CANONICAL_DOMAINS) {
    let score = 0;
    for (const keyword of domain.keywords) {
      if (haystack.includes(keyword.toLowerCase())) score += keyword.length;
    }
    if (score > 0 && (!best || score > best.score)) best = { id: domain.id, score };
  }
  return best?.id ?? null;
}

export function domainInterfaceId(domainId: string): string {
  return `mem_${createHash("sha256").update(`domain\u0000${domainId}`).digest("hex").slice(0, 24)}`;
}
