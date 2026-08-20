import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../config.ts";
import { BehaviorRepository } from "./behavior-repository.ts";
import { DashboardRepository } from "./repository.ts";
import { KnowledgeRepository } from "../knowledge/repository.ts";
import { KnowledgePruner } from "../knowledge/prune.ts";
import { AdaptiveHierarchyOrganizer } from "../knowledge/hierarchy.ts";
import { TelemetryRepository } from "../telemetry/repository.ts";
import { TelemetryMetrics } from "../telemetry/metrics.ts";
import { importOpencodeTelemetry } from "../telemetry/importer.ts";
import { MemoryProcessor } from "../worker/processor.ts";
import { BackfillQueue, populateBackfillQueue } from "../backfill/queue.ts";
import { BackfillRunner } from "../backfill/runner.ts";

const PUBLIC_DIRECTORY = resolve(import.meta.dir, "public");

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function parseInteger(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function staticFile(name: string, contentType: string): Response {
  return new Response(Bun.file(resolve(PUBLIC_DIRECTORY, name)), {
    headers: { "Content-Type": contentType, "Cache-Control": "no-cache" },
  });
}

export interface DashboardServer {
  url: string;
  stop(): Promise<void>;
}

export function startDashboard(config: AppConfig, memoryDatabase: Database): DashboardServer {
  if (!existsSync(config.bootstrapDbPath)) {
    throw new Error(`bootstrap database not found: ${config.bootstrapDbPath}; run bun run bootstrap`);
  }

  const database = new Database(config.bootstrapDbPath, { readonly: true, strict: true });
  const repository = new DashboardRepository(database);
  const behavior = new BehaviorRepository(memoryDatabase);
  const knowledge = new KnowledgeRepository(memoryDatabase);
  const pruner = new KnowledgePruner(memoryDatabase);
  const hierarchy = new AdaptiveHierarchyOrganizer(memoryDatabase);
  const telemetry = new TelemetryRepository(memoryDatabase);
  const telemetryMetrics = new TelemetryMetrics(memoryDatabase);
  importOpencodeTelemetry(memoryDatabase);
  const telemetryImporter = setInterval(() => importOpencodeTelemetry(memoryDatabase), 60_000);
  const processor = new MemoryProcessor(memoryDatabase, config.bootstrapDbPath, undefined, () => {
    pruner.request();
    // Hierarchy builds are expensive and cached; run only after the stream settles.
  });
  populateBackfillQueue(memoryDatabase, config.bootstrapDbPath);
  const backfillQueue = new BackfillQueue(memoryDatabase);
  const backfill = new BackfillRunner(memoryDatabase, config.bootstrapDbPath);
  if (Bun.env.OPENCODE_MEMORY_BACKFILL_AUTO !== "0") backfill.start();
  const backfillSupervisor = setInterval(() => {
    if (backfillQueue.stats().pending > 0 && !backfill.isRunning()) backfill.start();
  }, 60_000);
  const server = Bun.serve({
    hostname: config.dashboardHost,
    port: config.dashboardPort,
    idleTimeout: 30,
    fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/api/health") return json({ ok: true });
        if (url.pathname === "/api/stats") return json({ ...repository.stats(), behavior: behavior.stats() });
        if (url.pathname === "/api/process" && request.method === "POST") {
          return request.json().then((body: unknown) => {
            const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
            if (typeof input.sessionId !== "string") return json({ error: "sessionId is required" }, 400);
            processor.request({
              sessionId: input.sessionId,
              sourceId: typeof input.sourceId === "string" ? input.sourceId : undefined,
            });
            return json({ accepted: true }, 202);
          });
        }
        if (url.pathname === "/api/process/activity" && request.method === "POST") {
          return request.json().then((body: unknown) => {
            const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
            if (typeof input.sessionId !== "string") return json({ error: "sessionId is required" }, 400);
            processor.cancel(input.sessionId);
            return json({ cancelled: true });
          });
        }
        if (url.pathname === "/api/memory/catalog") {
          return json(knowledge.catalog(url.searchParams.get("directory") ?? undefined));
        }
        if (url.pathname === "/api/telemetry/injection" && request.method === "POST") {
          return request.json().then((body: unknown) => {
            const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
            if (typeof input.sessionId !== "string" || typeof input.directory !== "string") return json({ error: "invalid injection event" }, 400);
            telemetry.recordInjection({
              sessionId: input.sessionId,
              directory: input.directory,
              agent: typeof input.agent === "string" ? input.agent : null,
              objectCount: typeof input.objectCount === "number" ? input.objectCount : 0,
              domainCount: typeof input.domainCount === "number" ? input.domainCount : 0,
            });
            return json({ recorded: true });
          });
        }
        if (url.pathname === "/api/telemetry/recall" && request.method === "POST") {
          return request.json().then((body: unknown) => {
            const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
            if (typeof input.sessionId !== "string" || typeof input.query !== "string" || typeof input.directory !== "string") return json({ error: "invalid recall event" }, 400);
            const entries = Array.isArray(input.entries)
              ? input.entries.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).id === "string" && typeof (entry as Record<string, unknown>).role === "string"
                ? [{ id: (entry as { id: string }).id, role: (entry as { role: string }).role }]
                : [])
              : [];
            const id = telemetry.recordRecall({
              id: typeof input.id === "string" ? input.id : undefined,
              sessionId: input.sessionId,
              messageId: typeof input.messageId === "string" ? input.messageId : null,
              directory: input.directory,
              agent: typeof input.agent === "string" ? input.agent : null,
              query: input.query,
              domain: typeof input.domain === "string" ? input.domain : null,
              namespace: typeof input.namespace === "string" ? input.namespace : null,
              mode: typeof input.mode === "string" ? input.mode : "auto",
              depth: typeof input.depth === "number" ? input.depth : 2,
              includeInstances: input.includeInstances === true,
              requestedLimit: typeof input.requestedLimit === "number" ? input.requestedLimit : 8,
              status: typeof input.status === "string" ? input.status : "completed",
              entries,
              rootCount: typeof input.rootCount === "number" ? input.rootCount : 0,
              latencyMs: typeof input.latencyMs === "number" ? input.latencyMs : 0,
              error: typeof input.error === "string" ? input.error : null,
            });
            return json({ recorded: true, id });
          });
        }
        if (url.pathname === "/api/observability/summary") return json(telemetryMetrics.summary());
        if (url.pathname === "/api/observability/recalls") {
          return json(telemetryMetrics.recalls(parseInteger(url.searchParams.get("limit")), parseInteger(url.searchParams.get("offset"))));
        }
        if (url.pathname === "/api/observability/feedback" && request.method === "POST") {
          return request.json().then((body: unknown) => {
            const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
            if (typeof input.recallId !== "string" || typeof input.verdict !== "string") return json({ error: "recallId and verdict are required" }, 400);
            telemetry.feedback(input.recallId, input.verdict, typeof input.note === "string" ? input.note : undefined);
            return json({ recorded: true });
          });
        }
        if (url.pathname === "/api/memory/search") {
          return json({ items: knowledge.search(url.searchParams.get("q") ?? "", {
            domain: url.searchParams.get("domain") ?? undefined,
            namespace: url.searchParams.get("namespace") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
            limit: parseInteger(url.searchParams.get("limit")),
          }) });
        }
        if (url.pathname === "/api/memory/pull") {
          const modeValue = url.searchParams.get("mode");
          const mode = ["auto", "interface", "implementation", "evidence"].includes(modeValue ?? "")
            ? modeValue as "auto" | "interface" | "implementation" | "evidence"
            : "auto";
          return json(knowledge.load(url.searchParams.get("q") ?? "", {
            domain: url.searchParams.get("domain") ?? undefined,
            namespace: url.searchParams.get("namespace") ?? undefined,
            mode,
            depth: parseInteger(url.searchParams.get("depth")),
            includeInstances: url.searchParams.get("include_instances") === "true",
            limit: parseInteger(url.searchParams.get("limit")),
          }));
        }
        if (url.pathname === "/api/memory/graph") {
          return json(knowledge.graph(url.searchParams.get("inactive") !== "false"));
        }
        if (url.pathname === "/api/memory/refactor" && request.method === "POST") {
          return hierarchy.run().then((result) => json(result));
        }
        if (url.pathname === "/api/hierarchy") {
          const run = memoryDatabase.query<Record<string, unknown>, []>(`
            SELECT id,status,level,stage,source_count AS sourceCount,
                   progress_done AS progressDone,progress_total AS progressTotal,
                   result,error,created_at AS createdAt,updated_at AS updatedAt,
                   completed_at AS completedAt
            FROM hierarchy_runs ORDER BY created_at DESC LIMIT 1
          `).get() ?? null;
          return json({ run });
        }
        if (url.pathname === "/api/memory/prune" && request.method === "POST") {
          return pruner.run().then((result) => json(result));
        }
        if (url.pathname === "/api/backfill") {
          return json({ ...backfillQueue.stats(), active: backfill.isRunning(), families: backfillQueue.active() });
        }
        if (url.pathname === "/api/backfill/start" && request.method === "POST") {
          backfill.start();
          return json({ started: true, ...backfillQueue.stats() });
        }
        if (url.pathname === "/api/backfill/stop" && request.method === "POST") {
          backfill.stop();
          return json({ stopping: true, ...backfillQueue.stats() });
        }
        if (url.pathname === "/api/backfill/retry" && request.method === "POST") {
          backfillQueue.resetFailed();
          backfill.start();
          return json({ retried: true, ...backfillQueue.stats() });
        }
        const reviewMatch = url.pathname.match(/^\/api\/memory\/entries\/([^/]+)$/);
        if (reviewMatch && request.method === "PATCH") {
          const id = decodeURIComponent(reviewMatch[1] ?? "");
          return request.json().then((body: unknown) => {
            const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
            const reviewed = knowledge.review(id, {
              status: typeof input.status === "string" ? input.status : undefined,
              title: typeof input.title === "string" ? input.title : undefined,
              content: typeof input.content === "string" ? input.content : undefined,
              role: typeof input.role === "string" ? input.role : undefined,
              contract: input.contract && typeof input.contract === "object" && !Array.isArray(input.contract) ? input.contract as Record<string, unknown> : undefined,
              delta: input.delta && typeof input.delta === "object" && !Array.isArray(input.delta) ? input.delta as Record<string, unknown> : undefined,
              reviewNote: typeof input.reviewNote === "string" ? input.reviewNote : undefined,
            });
            return reviewed ? json(reviewed) : json({ error: "memory entry not found" }, 404);
          });
        }
        if (reviewMatch && request.method === "DELETE") {
          const id = decodeURIComponent(reviewMatch[1] ?? "");
          return knowledge.delete(id) ? json({ deleted: true }) : json({ error: "memory entry not found" }, 404);
        }
        if (url.pathname === "/api/sessions") {
          const result = repository.searchSessions({
            query: url.searchParams.get("q") ?? undefined,
            source: url.searchParams.get("source") ?? undefined,
            limit: parseInteger(url.searchParams.get("limit")),
            offset: parseInteger(url.searchParams.get("offset")),
          });
          return json({ ...result, items: result.items.map((item) => ({
            ...item,
            hasBehavior: behavior.hasSession(item.sourceId, item.sessionId),
          })) });
        }
        const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
        if (match) {
          const sourceId = decodeURIComponent(match[1] ?? "");
          const sessionId = decodeURIComponent(match[2] ?? "");
          const session = repository.session(sourceId, sessionId);
          return session ? json({ ...session, behavior: behavior.session(sourceId, sessionId) }) : json({ error: "session not found" }, 404);
        }
        if (url.pathname === "/app.css") return staticFile("app.css", "text/css; charset=utf-8");
        if (url.pathname === "/app.js") return staticFile("app.js", "text/javascript; charset=utf-8");
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return staticFile("index.html", "text/html; charset=utf-8");
        }
        return json({ error: "not found" }, 404);
      } catch (error) {
        console.error("dashboard request failed", error);
        return json({ error: error instanceof Error ? error.message : "request failed" }, 500);
      }
    },
  });

  return {
    url: `http://${config.dashboardHost}:${server.port}`,
    async stop() {
      await server.stop();
      database.close();
    },
  };
}
