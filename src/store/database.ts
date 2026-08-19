import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'implementation',
    kind TEXT,
    namespace TEXT,
    domain TEXT,
    contract TEXT NOT NULL DEFAULT '{}',
    delta TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '[]',
    source_refs TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'generated',
    confidence REAL NOT NULL DEFAULT 0.5,
    review_note TEXT,
    reviewed_at INTEGER,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS links (
    source_entry_id TEXT NOT NULL,
    target_entry_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_entry_id, target_entry_id, relation),
    FOREIGN KEY (source_entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    proposal TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    applied_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS episode_capsules (
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    outcome TEXT NOT NULL,
    model TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS episode_nodes (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_part_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (source_id, session_id)
      REFERENCES episode_capsules(source_id, session_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS episode_edges (
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_node_id, target_node_id, relation),
    FOREIGN KEY (source_node_id) REFERENCES episode_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_node_id) REFERENCES episode_nodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS episode_nodes_session_idx
    ON episode_nodes(source_id, session_id, sequence);

  CREATE TABLE IF NOT EXISTS episode_chunk_results (
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, session_id, chunk_index)
  );

  CREATE TABLE IF NOT EXISTS entry_origins (
    entry_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_node_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, source_id, session_id),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS processing_jobs (
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    requested_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    PRIMARY KEY (source_id, session_id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    entry_id UNINDEXED,
    title,
    content,
    role,
    kind,
    namespace,
    tags,
    tokenize = 'trigram'
  );

  CREATE TABLE IF NOT EXISTS maintenance_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backfill_families (
    id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    representative_source_id TEXT NOT NULL,
    representative_session_id TEXT NOT NULL,
    member_count INTEGER NOT NULL,
    priority REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    progress_done INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS backfill_members (
    family_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    PRIMARY KEY (family_id, source_id, session_id),
    FOREIGN KEY (family_id) REFERENCES backfill_families(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS hierarchy_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'map',
    source_count INTEGER NOT NULL,
    progress_done INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS hierarchy_cache (
    stage TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (stage, input_hash)
  );

  CREATE TABLE IF NOT EXISTS memory_injections (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    agent TEXT,
    object_count INTEGER NOT NULL,
    domain_count INTEGER NOT NULL,
    injected_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_recalls (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_part_id TEXT,
    session_id TEXT NOT NULL,
    message_id TEXT,
    directory TEXT NOT NULL,
    agent TEXT,
    query TEXT NOT NULL,
    domain TEXT,
    namespace TEXT,
    mode TEXT NOT NULL,
    depth INTEGER NOT NULL,
    include_instances INTEGER NOT NULL,
    requested_limit INTEGER NOT NULL,
    status TEXT NOT NULL,
    hit_count INTEGER NOT NULL,
    root_count INTEGER NOT NULL,
    interface_count INTEGER NOT NULL,
    implementation_count INTEGER NOT NULL,
    resource_count INTEGER NOT NULL,
    instance_count INTEGER NOT NULL,
    returned_entry_ids TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    recalled_at INTEGER NOT NULL,
    followup_tool_count INTEGER NOT NULL DEFAULT 0,
    followup_edit_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    UNIQUE(source, source_part_id)
  );

  CREATE TABLE IF NOT EXISTS memory_feedback (
    recall_id TEXT PRIMARY KEY,
    verdict TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (recall_id) REFERENCES memory_recalls(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS memory_recalls_time_idx ON memory_recalls(recalled_at);
  CREATE INDEX IF NOT EXISTS memory_recalls_session_idx ON memory_recalls(session_id,recalled_at);

  CREATE INDEX IF NOT EXISTS backfill_families_status_priority_idx
    ON backfill_families(status, priority DESC);
`;

export function openMemoryDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const database = new Database(path, { create: true });
  if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL;");
  database.exec(SCHEMA);
  const columns = new Set(
    database.query<{ name: string }, []>("PRAGMA table_info(entries)").all().map(({ name }) => name),
  );
  const migrations: Array<[string, string]> = [
    ["title", "TEXT NOT NULL DEFAULT ''"],
    ["role", "TEXT NOT NULL DEFAULT 'implementation'"],
    ["domain", "TEXT"],
    ["contract", "TEXT NOT NULL DEFAULT '{}'"],
    ["delta", "TEXT NOT NULL DEFAULT '{}'"],
    ["status", "TEXT NOT NULL DEFAULT 'generated'"],
    ["confidence", "REAL NOT NULL DEFAULT 0.5"],
    ["review_note", "TEXT"],
    ["reviewed_at", "INTEGER"],
  ];
  for (const [name, definition] of migrations) {
    if (!columns.has(name)) database.exec(`ALTER TABLE entries ADD COLUMN ${name} ${definition}`);
  }
  const backfillColumns = new Set(
    database.query<{ name: string }, []>("PRAGMA table_info(backfill_families)").all().map(({ name }) => name),
  );
  if (!backfillColumns.has("progress_done")) database.exec("ALTER TABLE backfill_families ADD COLUMN progress_done INTEGER NOT NULL DEFAULT 0");
  if (!backfillColumns.has("progress_total")) database.exec("ALTER TABLE backfill_families ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0");
  const ftsColumns = new Set(
    database.query<{ name: string }, []>("PRAGMA table_info(entries_fts)").all().map(({ name }) => name),
  );
  if (!ftsColumns.has("role") || !ftsColumns.has("domain")) {
    database.exec("DROP TABLE IF EXISTS entries_fts");
    database.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        entry_id UNINDEXED, title, content, role, kind, namespace, domain, tags,
        tokenize = 'trigram'
      );
    `);
  }
  return database;
}
