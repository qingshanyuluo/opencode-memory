import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../src/store/database.ts";

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("openMemoryDatabase", () => {
  test("creates the durable memory schema without copying source sessions", () => {
    database = openMemoryDatabase(":memory:");

    const tables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    expect(tables).toContain("entries");
    expect(tables).toContain("links");
    expect(tables).toContain("operations");
    expect(tables).not.toContain("raw_messages");
  });
});
