import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { BehaviorRepository } from "../src/dashboard/behavior-repository.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("BehaviorRepository", () => {
  test("returns an evidence-backed behavior graph", () => {
    database = openMemoryDatabase(":memory:");
    database.query(`
      INSERT INTO episode_capsules VALUES (
        'main', 'ses_1', 'Title', 'Summary', 'success', 'test/model', 'hash',
        'generated', 1, 1, 1
      )
    `).run();
    database.query(`
      INSERT INTO episode_nodes VALUES (
        'node_1', 'main', 'ses_1', 0, 'evidence', 'confirmed', 'Observed fact',
        0.9, '["prt_1"]', 1
      )
    `).run();

    const repository = new BehaviorRepository(database);
    const behavior = repository.session("main", "ses_1");

    expect(repository.stats()).toEqual({ capsules: 1, nodes: 1 });
    expect(behavior?.capsule.outcome).toBe("success");
    expect(behavior?.nodes[0]?.sourcePartIds).toEqual(["prt_1"]);
  });
});
