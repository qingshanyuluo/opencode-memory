import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BackfillQueue, populateBackfillQueue } from "../src/backfill/queue.ts";
import { createBootstrapDatabase } from "../src/bootstrap/database.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

let memory: Database | undefined;
let bootstrap: Database | undefined;
let directory: string | undefined;

afterEach(() => {
  memory?.close();
  bootstrap?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("historical backfill queue", () => {
  test("groups forks and atomically claims one family", () => {
    directory = mkdtempSync(resolve(tmpdir(), "opencode-memory-backfill-"));
    const bootstrapPath = resolve(directory, "bootstrap.db");
    bootstrap = createBootstrapDatabase(bootstrapPath);
    bootstrap.query("INSERT INTO sources VALUES ('main','/source.db',1,1,1)").run();
    const insert = bootstrap.query(`
      INSERT INTO session_documents VALUES (
        'main', ?, ?, 'project', '/repo', ?, '1.18.16', 1, ?, NULL,
        2, 1, 1, 4, ?, 0, 'intent', ?, '', ?, 1
      )
    `);
    insert.run("ses_1", null, "Fix Redis issue", 2, 10, "[command] kubectl get pod", "h1");
    insert.run("ses_2", "ses_1", "Fix Redis issue (fork #1)", 3, 20, "[command] kubectl logs", "h2");
    bootstrap.close();
    bootstrap = undefined;
    memory = openMemoryDatabase(":memory:");

    expect(populateBackfillQueue(memory, bootstrapPath)).toBe(1);
    const queue = new BackfillQueue(memory);
    const family = queue.claimNext();
    expect(family?.memberCount).toBe(2);
    expect(family?.representativeSessionId).toBe("ses_2");
    expect(queue.claimNext()).toBeNull();
    expect(family?.attempts).toBe(0);
    queue.finish(family?.id as string, "completed");
    expect(queue.stats().completed).toBe(1);
  });
});
