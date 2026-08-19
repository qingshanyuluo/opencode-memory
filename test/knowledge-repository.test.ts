import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { KnowledgeRepository } from "../src/knowledge/repository.ts";
import { openMemoryDatabase } from "../src/store/database.ts";
import { insertStructuralRelation } from "../src/knowledge/relations.ts";

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("KnowledgeRepository", () => {
  test("searches active knowledge and supports human review", () => {
    database = openMemoryDatabase(":memory:");
    database.query(`
      INSERT INTO entries(
        id,title,content,kind,namespace,tags,source_refs,status,confidence,
        valid_from,created_at,updated_at
      ) VALUES ('mem_1','Nacos access','Use the pod-side client','procedure','aichat-v2',
        '["nacos"]','[]','generated',0.9,1,1,1)
    `).run();
    const repository = new KnowledgeRepository(database);
    repository.rebuildFts();

    expect(repository.search("Nacos")[0]?.title).toBe("Nacos access");
    expect(repository.catalog("/repo/aichat-v2").relevant).toHaveLength(1);
    expect(repository.review("mem_1", { status: "active", reviewNote: "verified" })?.status).toBe("active");
    expect(repository.graph().entries[0]?.reviewNote).toBe("verified");
  });

  test("loads interface, implementation, resources and optional instances", () => {
    database = openMemoryDatabase(":memory:");
    const insert = database.query(`
      INSERT INTO entries(
        id,title,content,role,kind,namespace,contract,delta,tags,source_refs,status,
        confidence,valid_from,created_at,updated_at
      ) VALUES (?, ?, ?, ?, 'test', ?, '{}', '{}', '[]', '[]', 'active', 1, 1, 1, 1)
    `);
    insert.run("iface", "实验诊断", "区分实验状态", "interface", "global");
    insert.run("impl", "BytePlus 实验诊断", "具体实现", "implementation", "aichat-v2");
    insert.run("resource", "OBS agent_runs", "权威分桶来源", "resource", "aichat-v2");
    insert.run("case", "一次掉出实验案例", "案例证据", "instance", "aichat-v2");
    insertStructuralRelation(database, "impl", "iface", "IMPLEMENTS", 1);
    insertStructuralRelation(database, "impl", "resource", "REFERENCES", 1);
    insertStructuralRelation(database, "case", "impl", "INSTANCE_OF", 1);
    const repository = new KnowledgeRepository(database);
    repository.rebuildFts();

    const normal = repository.load("BytePlus", { namespace: "aichat-v2", depth: 2 });
    expect(normal.entries.map(({ role }) => role).sort()).toEqual(["implementation", "interface", "resource"]);
    expect(normal.entries.some(({ role }) => role === "instance")).toBeFalse();

    const evidence = repository.load("BytePlus", { namespace: "aichat-v2", depth: 2, includeInstances: true });
    expect(evidence.entries.some(({ role }) => role === "instance")).toBeTrue();

    expect(repository.delete("iface")).toBeTrue();
    expect(repository.graph().entries.some(({ id }) => id === "iface")).toBeFalse();
    expect(repository.graph().links.some(({ targetEntryId }) => targetEntryId === "iface")).toBeFalse();
  });

  test("matches Chinese short terms via LIKE fallback and excludes domain roots", () => {
    database = openMemoryDatabase(":memory:");
    const insert = database.query(`
      INSERT INTO entries(id,title,content,role,kind,namespace,domain,tags,source_refs,status,valid_from,created_at,updated_at)
      VALUES (?, ?, ?, 'implementation', '排障规程', 'repo', '日志诊断', '["舔狗"]', '[]', 'generated', 1, 1, 1)
    `);
    insert.run("dog", "分钟级舔狗冷静期排查", "男用户消息后舔狗 timer 未重置，查 SLS 日志定位调度点。");
    database.query(`
      INSERT INTO entries(id,title,content,role,kind,namespace,domain,tags,source_refs,status,valid_from,created_at,updated_at)
      VALUES ('dom', '日志诊断契约', '能力域根', 'interface', '能力域', 'global', '日志诊断', '[]', '[]', 'active', 1, 1, 1)
    `).run();
    const repository = new KnowledgeRepository(database);
    repository.rebuildFts();

    const hits = repository.search("舔狗");
    expect(hits.some(({ id }) => id === "dog")).toBeTrue();
    expect(hits.some(({ id }) => id === "dom")).toBeFalse();
  });
});
