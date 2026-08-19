import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = DELETE;

  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    scanned_at INTEGER NOT NULL
  );

  CREATE TABLE session_documents (
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_id TEXT,
    project_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    opencode_version TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_archived INTEGER,
    message_count INTEGER NOT NULL,
    user_message_count INTEGER NOT NULL,
    assistant_message_count INTEGER NOT NULL,
    part_count INTEGER NOT NULL,
    tool_call_count INTEGER NOT NULL,
    tool_error_count INTEGER NOT NULL,
    user_intent TEXT NOT NULL,
    artifact_text TEXT NOT NULL,
    error_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, session_id),
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
  );

  CREATE TABLE tool_events (
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    part_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    tool TEXT NOT NULL,
    status TEXT NOT NULL,
    input_summary TEXT NOT NULL,
    output_preview TEXT NOT NULL,
    error_signature TEXT,
    PRIMARY KEY (source_id, part_id),
    FOREIGN KEY (source_id, session_id)
      REFERENCES session_documents(source_id, session_id) ON DELETE CASCADE
  );

  CREATE TABLE artifacts (
    source_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    source_message_id TEXT,
    source_part_id TEXT,
    PRIMARY KEY (source_id, session_id, kind, value),
    FOREIGN KEY (source_id, session_id)
      REFERENCES session_documents(source_id, session_id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE session_documents_fts USING fts5(
    source_id UNINDEXED,
    session_id UNINDEXED,
    title,
    directory,
    user_intent,
    artifact_text,
    error_text,
    tokenize = 'trigram'
  );

  CREATE INDEX tool_events_session_idx
    ON tool_events(source_id, session_id, time_created);
  CREATE INDEX artifacts_value_idx ON artifacts(kind, value);
`;

export function createBootstrapDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec(SCHEMA);
  return database;
}
