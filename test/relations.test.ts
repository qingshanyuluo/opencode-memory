import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { insertStructuralRelation } from "../src/knowledge/relations.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

let database: Database | undefined;
afterEach(() => database?.close());

describe("structural relation compiler", () => {
  test("rejects invalid role pairs and inheritance cycles", () => {
    database = openMemoryDatabase(":memory:");
    const insert = database.query(`
      INSERT INTO entries(id,title,content,role,tags,source_refs,valid_from,created_at,updated_at)
      VALUES (?, ?, 'content', ?, '[]', '[]', 1, 1, 1)
    `);
    insert.run("i", "Interface", "interface");
    insert.run("a", "Abstract A", "abstract");
    insert.run("b", "Abstract B", "abstract");
    insert.run("x", "Instance", "instance");
    insertStructuralRelation(database, "a", "i", "IMPLEMENTS", 1);
    insertStructuralRelation(database, "a", "b", "EXTENDS", 1);

    expect(() => insertStructuralRelation(database as Database, "i", "a", "IMPLEMENTS", 1)).toThrow();
    expect(() => insertStructuralRelation(database as Database, "b", "a", "EXTENDS", 1)).toThrow();
    expect(() => insertStructuralRelation(database as Database, "x", "i", "INSTANCE_OF", 1)).toThrow();
  });
});
