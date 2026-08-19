import { CryptoHasher } from "bun";
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { redactText, sanitizeValue } from "./redact.ts";

export interface BootstrapSource {
  id: string;
  path: string;
}

export interface BootstrapCounts {
  sessions: number;
  toolEvents: number;
  artifacts: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

interface MessageRow {
  id: string;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
  message_data: string;
}

interface ToolEvent {
  messageId: string;
  partId: string;
  createdAt: number;
  tool: string;
  status: string;
  inputSummary: string;
  outputPreview: string;
  errorSignature: string | null;
}

interface Artifact {
  kind: string;
  value: string;
  messageId: string | null;
  partId: string | null;
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[TRUNCATED ${text.length - max} chars]`;
}

function stringify(value: unknown): string {
  return JSON.stringify(sanitizeValue(value));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function summarizeInput(tool: string, input: unknown): string {
  const sanitized = sanitizeValue(input);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return truncate(stringify(sanitized), 2_000);
  }

  const fields = sanitized as Record<string, unknown>;
  if (tool === "bash") return truncate(stringField(fields.command), 4_000);
  if (["read", "write", "edit", "apply_patch"].includes(tool)) {
    const filePath = stringField(fields.filePath) || stringField(fields.path);
    return filePath ? stringify({ filePath }) : truncate(stringify(fields), 2_000);
  }
  return truncate(stringify(fields), 2_000);
}

function summarizeOutput(state: Record<string, unknown>): string {
  if (state.status === "error") return truncate(redactText(stringField(state.error)), 4_000);
  return "";
}

function normalizeError(text: string): string {
  return truncate(
    redactText(text)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "unknown error",
    500,
  );
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map(([url]) => redactText(url));
}

function collectArtifacts(tool: string, input: unknown, event: ToolEvent): Artifact[] {
  const artifacts: Artifact[] = [];
  const fields = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const filePath = stringField(fields.filePath) || stringField(fields.path);
  if (filePath) artifacts.push({ kind: "file", value: filePath, messageId: event.messageId, partId: event.partId });

  if (tool === "bash") {
    const command = truncate(redactText(stringField(fields.command)), 4_000);
    if (command) artifacts.push({ kind: "command", value: command, messageId: event.messageId, partId: event.partId });
  }

  for (const url of extractUrls(`${event.inputSummary}\n${event.outputPreview}`)) {
    artifacts.push({ kind: "url", value: url, messageId: event.messageId, partId: event.partId });
  }
  if (event.errorSignature) {
    artifacts.push({ kind: "error", value: event.errorSignature, messageId: event.messageId, partId: event.partId });
  }
  return artifacts;
}

function hashContent(parts: string[]): string {
  const hasher = new CryptoHasher("sha256");
  hasher.update(parts.join("\u0000"));
  return hasher.digest("hex");
}

function sourceId(source: BootstrapSource): string {
  return source.id || basename(source.path, ".db");
}

export function processSource(output: Database, source: BootstrapSource): BootstrapCounts {
  const sourceDatabase = new Database(source.path, { readonly: true, strict: true });
  const sourceStats = statSync(source.path);
  const id = sourceId(source);
  const processedAt = Date.now();

  const sessions = sourceDatabase.query<SessionRow, []>(`
    SELECT id, project_id, parent_id, directory, title, version,
           time_created, time_updated, time_archived
    FROM session ORDER BY time_created, id
  `).all();

  const insertSource = output.query(`
    INSERT INTO sources(id, path, size_bytes, modified_at, scanned_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertDocument = output.query(`
    INSERT INTO session_documents(
      source_id, session_id, parent_id, project_id, directory, title,
      opencode_version, time_created, time_updated, time_archived,
      message_count, user_message_count, assistant_message_count, part_count,
      tool_call_count, tool_error_count, user_intent, artifact_text, error_text,
      content_hash, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTool = output.query(`
    INSERT INTO tool_events(
      source_id, session_id, message_id, part_id, time_created, tool, status,
      input_summary, output_preview, error_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertArtifact = output.query(`
    INSERT OR IGNORE INTO artifacts(
      source_id, session_id, kind, value, source_message_id, source_part_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertFts = output.query(`
    INSERT INTO session_documents_fts(
      source_id, session_id, title, directory, user_intent, artifact_text, error_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let toolEventCount = 0;
  let artifactCount = 0;

  output.transaction(() => {
    insertSource.run(id, source.path, sourceStats.size, sourceStats.mtimeMs, processedAt);

    for (const session of sessions) {
      const messages = sourceDatabase.query<MessageRow, [string]>(
        "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
      ).all(session.id);
      const parts = sourceDatabase.query<PartRow, [string]>(`
        SELECT p.id, p.message_id, p.time_created, p.data, m.data AS message_data
        FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ? ORDER BY p.time_created, p.id
      `).all(session.id);

      const roles = messages.map(({ data }) => stringField(parseJson(data).role));
      const userTexts: string[] = [];
      const toolEvents: ToolEvent[] = [];
      const artifacts = new Map<string, Artifact>();

      for (const part of parts) {
        const data = parseJson(part.data);
        const message = parseJson(part.message_data);
        if (data.type === "text" && message.role === "user") {
          if (data.synthetic === true || (data.metadata && typeof data.metadata === "object" && (data.metadata as Record<string, unknown>).opencodeMemory)) continue;
          const text = redactText(stringField(data.text)).trim();
          if (text) userTexts.push(text);
          continue;
        }
        if (data.type !== "tool") continue;

        const state = data.state && typeof data.state === "object"
          ? data.state as Record<string, unknown>
          : {};
        const tool = stringField(data.tool) || "unknown";
        const error = state.status === "error" ? normalizeError(stringField(state.error)) : null;
        const event: ToolEvent = {
          messageId: part.message_id,
          partId: part.id,
          createdAt: part.time_created,
          tool,
          status: stringField(state.status) || "unknown",
          inputSummary: summarizeInput(tool, state.input),
          outputPreview: summarizeOutput(state),
          errorSignature: error,
        };
        toolEvents.push(event);
        for (const artifact of collectArtifacts(tool, state.input, event)) {
          artifacts.set(`${artifact.kind}\u0000${artifact.value}`, artifact);
        }
      }

      const artifactList = [...artifacts.values()];
      const artifactText = artifactList.map(({ kind, value }) => `[${kind}] ${value}`).join("\n");
      const errorText = toolEvents.flatMap(({ errorSignature }) => errorSignature ? [errorSignature] : []).join("\n");
      const userIntent = userTexts.join("\n\n---\n\n");
      const contentHash = hashContent([
        session.title,
        userIntent,
        artifactText,
        errorText,
        String(session.time_updated),
      ]);

      insertDocument.run(
        id, session.id, session.parent_id, session.project_id, session.directory,
        session.title, session.version, session.time_created, session.time_updated,
        session.time_archived, messages.length,
        roles.filter((role) => role === "user").length,
        roles.filter((role) => role === "assistant").length,
        parts.length, toolEvents.length,
        toolEvents.filter(({ status }) => status === "error").length,
        userIntent, artifactText, errorText, contentHash, processedAt,
      );

      for (const event of toolEvents) {
        insertTool.run(
          id, session.id, event.messageId, event.partId, event.createdAt, event.tool,
          event.status, event.inputSummary, event.outputPreview, event.errorSignature,
        );
      }
      for (const artifact of artifactList) {
        const result = insertArtifact.run(
          id, session.id, artifact.kind, artifact.value, artifact.messageId, artifact.partId,
        );
        artifactCount += result.changes;
      }
      insertFts.run(id, session.id, session.title, session.directory, userIntent, artifactText, errorText);
      toolEventCount += toolEvents.length;
    }
  })();

  sourceDatabase.close();
  return { sessions: sessions.length, toolEvents: toolEventCount, artifacts: artifactCount };
}
