import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../src/store/database.ts";
import { TelemetryMetrics } from "../src/telemetry/metrics.ts";
import { TelemetryRepository } from "../src/telemetry/repository.ts";

let database: Database | undefined;
afterEach(() => database?.close());

describe("memory telemetry", () => {
  test("records injections, hits, misses and human usefulness", () => {
    database = openMemoryDatabase(":memory:");
    const telemetry = new TelemetryRepository(database);
    telemetry.recordInjection({ sessionId: "s1", directory: "/repo", objectCount: 10, domainCount: 3 });
    telemetry.recordRecall({
      id: "r1", sessionId: "s1", directory: "/repo", query: "Redis", domain: "数据查询",
      mode: "auto", depth: 2, includeInstances: false, requestedLimit: 8, status: "completed",
      entries: [{ id: "m1", role: "interface" }, { id: "m2", role: "implementation" }],
      rootCount: 1, latencyMs: 12, recalledAt: 1,
    });
    telemetry.recordRecall({
      id: "r2", sessionId: "s2", directory: "/repo", query: "missing",
      mode: "auto", depth: 2, includeInstances: false, requestedLimit: 8, status: "completed",
      entries: [], rootCount: 0, latencyMs: 20, recalledAt: 2,
    });
    telemetry.feedback("r1", "useful");

    const summary = new TelemetryMetrics(database).summary() as Record<string, any>;
    expect(summary.recalls).toBe(2);
    expect(summary.hitRate).toBe(0.5);
    expect(summary.injections).toBe(1);
    expect(summary.feedback.usefulness).toBe(1);
  });
});
