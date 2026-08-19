import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createBootstrapDatabase } from "../src/bootstrap/database.ts";
import { DashboardRepository } from "../src/dashboard/repository.ts";

let database: Database | undefined;
let directory: string | undefined;

afterEach(() => {
  database?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  database = undefined;
  directory = undefined;
});

function fixture(): DashboardRepository {
  directory = mkdtempSync(resolve(tmpdir(), "opencode-memory-dashboard-"));
  database = createBootstrapDatabase(resolve(directory, "bootstrap.db"));
  database.query("INSERT INTO sources VALUES (?, ?, ?, ?, ?)")
    .run("main", "/source.db", 10, 1, 2);
  database.query(`
    INSERT INTO session_documents VALUES (
      'main', 'ses_1', NULL, 'project', '/repo', 'Nacos investigation', '1.18.16',
      1, 2, NULL, 2, 1, 1, 4, 1, 1, '检查 Nacos 配置',
      '[file] /repo/config.kt', 'Request timed out', 'hash', 3
    )
  `).run();
  database.query(`
    INSERT INTO session_documents_fts VALUES (
      'main', 'ses_1', 'Nacos investigation', '/repo', '检查 Nacos 配置',
      '[file] /repo/config.kt', 'Request timed out'
    )
  `).run();
  database.query(`
    INSERT INTO tool_events VALUES (
      'main', 'ses_1', 'msg_1', 'prt_1', 2, 'webfetch', 'error',
      '{"url":"https://example.com"}', 'Request timed out', 'Request timed out'
    )
  `).run();
  database.query(`
    INSERT INTO artifacts VALUES (
      'main', 'ses_1', 'file', '/repo/config.kt', 'msg_1', 'prt_1'
    )
  `).run();
  return new DashboardRepository(database);
}

describe("DashboardRepository", () => {
  test("returns aggregate stats and FTS results", () => {
    const repository = fixture();

    expect(repository.stats().sessions).toBe(1);
    expect(repository.searchSessions({ query: "Nacos" }).total).toBe(1);
    expect(repository.searchSessions({ query: "missing" }).total).toBe(0);
  });

  test("returns normalized session detail", () => {
    const repository = fixture();
    const session = repository.session("main", "ses_1");

    expect(session?.title).toBe("Nacos investigation");
    expect(session?.tools[0]?.errorSignature).toBe("Request timed out");
    expect(session?.artifacts[0]?.value).toBe("/repo/config.kt");
  });
});
