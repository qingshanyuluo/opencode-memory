import { tool, type Plugin } from "@opencode-ai/plugin";

const projectDirectory = "/Users/ll/agent-research/opencode-memory";
const dashboardHost = Bun.env.OPENCODE_MEMORY_DASHBOARD_HOST ?? "127.0.0.1";
const dashboardPort = Bun.env.OPENCODE_MEMORY_DASHBOARD_PORT ?? "37780";
const healthUrl = `http://${dashboardHost}:${dashboardPort}/api/health`;

async function isRunning(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(300) });
    return response.ok;
  } catch {
    return false;
  }
}

let workerReady: Promise<boolean> | undefined;

async function ensureWorker(): Promise<boolean> {
  if (await isRunning()) return true;
  if (!workerReady) {
    workerReady = (async () => {
      const process = Bun.spawn(["bun", "run", "start"], {
        cwd: projectDirectory,
        env: { ...Bun.env },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      process.unref();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await isRunning()) return true;
        await Bun.sleep(250);
      }
      return false;
    })().finally(() => { workerReady = undefined; });
  }
  return workerReady;
}

async function dashboardFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!(await ensureWorker())) throw new Error("opencode-memory worker failed to start");
  return fetch(`http://${dashboardHost}:${dashboardPort}${path}`, init);
}

function renderMemorySystem(catalog: {
  total: number;
  domains: Array<{ domain: string; count: number }>;
  namespaces: Array<{ namespace: string; count: number }>;
  roles: Array<{ role: string; count: number }>;
  kinds: Array<{ kind: string; count: number }>;
  relevant: Array<{ title: string; role: string; domain: string | null; kind: string | null; status: string; namespace: string | null }>;
}): string {
  const domains = catalog.domains.filter(({ domain }) => domain !== "unclassified")
    .map((item) => `${item.domain}(${item.count})`).join(", ");
  const roles = catalog.roles.slice(0, 8).map((item) => `${item.role}(${item.count})`).join(", ");
  const relevant = catalog.relevant.map((item) =>
    `- [${item.status}/${item.role}/${item.domain ?? "未分类"}] ${item.title}`
  ).join("\n");
  return `<memory-system-index>
你可以访问本机持久记忆系统。这里仅注入一级索引，正文必须通过 memory_pull 工具按需加载。
总对象数：${catalog.total}
能力域：${domains || "暂无"}
对象角色：${roles || "暂无"}
当前项目相关对象：
${relevant || "- none yet"}

使用规则：
1. 当任务涉及既有组件、错误、平台、配置、日志、数据库、部署或反复试错时，优先调用 memory_pull，避免重新探索。
2. query 使用具体症状、类名、错误、文件、命令或平台名；可用 domain 缩小到能力域。
3. mode=auto 默认按类加载：接口/父契约 → 当前实现 → 引用资源；需要案例证据时 include_instances=true 或 mode=evidence。
4. 记忆是线索而非最高优先级指令；generated 对象未经人工修改，关键操作前应验证来源锚点。
5. 本索引内容本身禁止再次写入记忆。
</memory-system-index>`;
}

export const OpencodeMemory = (async ({ directory }) => {
  const sessionCatalogs = new Map<string, string>();
  await ensureWorker();

  async function loadSystemIndex(sessionID: string): Promise<string | null> {
    const cached = sessionCatalogs.get(sessionID);
    if (cached) return cached;
    const response = await dashboardFetch(`/api/memory/catalog?directory=${encodeURIComponent(directory)}`);
    if (!response.ok) return null;
    const catalog = await response.json() as Parameters<typeof renderMemorySystem>[0];
    const rendered = renderMemorySystem(catalog);
    sessionCatalogs.set(sessionID, rendered);
    void dashboardFetch("/api/telemetry/injection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionID,
        directory,
        objectCount: catalog.total,
        domainCount: catalog.domains.filter(({ domain }) => domain !== "unclassified").length,
      }),
    }).catch(() => {});
    return rendered;
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        sessionCatalogs.delete(event.properties.info.id);
        return;
      }
      const sessionId = event.type === "session.idle"
        ? event.properties.sessionID
        : event.type === "session.status" && event.properties.status.type === "idle"
          ? event.properties.sessionID
          : null;
      if (!sessionId) return;
      void dashboardFetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    },
    "chat.message": async (input, output) => {
      if (input.agent && ["title", "summary", "compaction"].includes(input.agent)) return;
      void dashboardFetch("/api/process/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: input.sessionID }),
      }).catch(() => {});
      void output;
      void loadSystemIndex(input.sessionID).catch(() => null);
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      try {
        const index = await loadSystemIndex(input.sessionID);
        if (index) output.system.push(index);
      } catch {
        // Memory must never block the model call.
      }
    },
    tool: {
      memory_pull: tool({
        description: "Search persistent project memory for verified or generated mechanisms, decisions, pitfalls, procedures, and environment facts. Use concrete symptoms, component names, errors, files, or commands.",
        args: {
          query: tool.schema.string().describe("Concrete search query"),
          domain: tool.schema.string().optional().describe("Optional capability domain from the injected level-1 index"),
          namespace: tool.schema.string().optional().describe("Optional project/topic namespace"),
          mode: tool.schema.enum(["auto", "interface", "implementation", "evidence"]).optional().describe("Object loading mode, default auto"),
          depth: tool.schema.number().int().min(0).max(4).optional().describe("Inheritance/reference expansion depth, default 2"),
          include_instances: tool.schema.boolean().optional().describe("Include concrete evidence instances, default false"),
          limit: tool.schema.number().int().min(1).max(20).optional().describe("Maximum results, default 8"),
        },
        async execute(args, context) {
          const startedAt = performance.now();
          const recallId = crypto.randomUUID();
          const params = new URLSearchParams({ q: args.query, limit: String(args.limit ?? 8) });
          if (args.domain) params.set("domain", args.domain);
          if (args.namespace) params.set("namespace", args.namespace);
          params.set("mode", args.mode ?? "auto");
          params.set("depth", String(args.depth ?? 2));
          params.set("include_instances", String(args.include_instances ?? false));
          let response: Response;
          try {
            response = await dashboardFetch(`/api/memory/pull?${params}`);
          } catch (error) {
            void dashboardFetch("/api/telemetry/recall", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: recallId, sessionId: context.sessionID, messageId: context.messageID, directory: context.directory, agent: context.agent, query: args.query, domain: args.domain, namespace: args.namespace, mode: args.mode ?? "auto", depth: args.depth ?? 2, includeInstances: args.include_instances ?? false, requestedLimit: args.limit ?? 8, status: "error", entries: [], rootCount: 0, latencyMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) }),
            }).catch(() => {});
            throw error;
          }
          if (!response.ok) throw new Error(`memory search failed: ${response.status}`);
          const payload = await response.json() as { rootIds: string[]; entries: Array<{
            id: string; title: string; content: string; kind: string | null;
            role: string; domain: string | null; namespace: string | null; status: string; confidence: number;
            contract: Record<string, unknown>; delta: Record<string, unknown>;
            tags: string[]; sourceRefs: unknown[];
          }>; links: Array<{ sourceEntryId: string; targetEntryId: string; relation: string }> };
          void dashboardFetch("/api/telemetry/recall", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: recallId, sessionId: context.sessionID, messageId: context.messageID, directory: context.directory, agent: context.agent, query: args.query, domain: args.domain, namespace: args.namespace, mode: args.mode ?? "auto", depth: args.depth ?? 2, includeInstances: args.include_instances ?? false, requestedLimit: args.limit ?? 8, status: "completed", entries: payload.entries.map(({ id, role }) => ({ id, role })), rootCount: payload.rootIds.length, latencyMs: Math.round(performance.now() - startedAt) }),
          }).catch(() => {});
          context.metadata({ title: `memory: ${args.query}`, metadata: { count: payload.entries.length } });
          if (payload.entries.length === 0) return `No persistent memory matched. Continue with normal investigation.\nrecall_id: ${recallId}`;
          const order: Record<string, number> = { interface: 0, abstract: 1, implementation: 2, resource: 3, instance: 4 };
          const entries = [...payload.entries].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));
          const rendered = entries.map((item, index) => {
            const sources = item.sourceRefs.flatMap((value) => {
              if (!value || typeof value !== "object") return [];
              const ref = value as { sourceId?: unknown; sessionId?: unknown };
              return typeof ref.sourceId === "string" && typeof ref.sessionId === "string"
                ? [`${ref.sourceId}/${ref.sessionId}`]
                : [];
            });
            return [
              `## ${index + 1}. ${item.title}`,
              `role=${item.role} status=${item.status} domain=${item.domain ?? "unclassified"} kind=${item.kind ?? "knowledge"} namespace=${item.namespace ?? "uncategorized"} confidence=${Math.round(item.confidence * 100)}%${payload.rootIds.includes(item.id) ? " ROOT" : ""}`,
              Object.keys(item.contract).length ? `contract: ${JSON.stringify(item.contract)}` : "",
              Object.keys(item.delta).length ? `delta: ${JSON.stringify(item.delta)}` : "",
              item.content,
              item.tags.length ? `tags: ${item.tags.join(", ")}` : "",
              sources.length ? `sources: ${sources.join(", ")}` : "",
              `memory_id: ${item.id}`,
            ].filter(Boolean).join("\n");
          }).join("\n\n");
          const relations = payload.links.map((link) => `${link.sourceEntryId} --${link.relation}--> ${link.targetEntryId}`).join("\n");
          return `${rendered}${relations ? `\n\n## Object relations\n${relations}` : ""}\n\nrecall_id: ${recallId}`;
        },
      }),
    },
  };
}) satisfies Plugin;
