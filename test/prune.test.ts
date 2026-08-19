import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { KnowledgePruner } from "../src/knowledge/prune.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

let database: Database | undefined;
afterEach(() => database?.close());

describe("KnowledgePruner", () => {
  test("selects single-origin short implementations and prunes on demand", () => {
    database = openMemoryDatabase(":memory:");
    const insert = database.query(`
      INSERT INTO entries(id,title,content,role,kind,namespace,domain,tags,source_refs,status,valid_from,created_at,updated_at)
      VALUES (?, ?, ?, 'implementation', ?, 'personal', NULL, '[]', '[]', 'generated', 1, 1, 1)
    `);
    insert.run("trivial", "Java 注释避免 */ 提前闭合", "在 Java 注释里避免出现字面量 */，否则会提前闭合注释导致编译错误。", "小技巧");
    insert.run("valuable", "Redis 集群跨 key Lua 会 CROSSSLOT", "dev 共享 Redis 是集群模式，跨 key 的 Lua 脚本会触发 CROSSSLOT 错误，需要改成批量命令。", "工具坑");
    database.query(`
      INSERT INTO entry_origins(entry_id,source_id,session_id,source_node_ids,created_at)
      VALUES ('trivial','main','ses_1','[]',1),('valuable','main','ses_1','[]',1)
    `).run();

    const pruner = new KnowledgePruner(database);
    expect(pruner.selectCandidates().map(({ id }) => id)).toEqual(["trivial"]);

    expect(pruner.prune("trivial", "低价值")).toBe(1);
    const status = database.query<{ status: string }, [string]>("SELECT status FROM entries WHERE id = ?").get("trivial");
    expect(status?.status).toBe("rejected");
  });
});
