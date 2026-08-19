import { Database } from "bun:sqlite";

export interface SessionSearch {
  query?: string | undefined;
  source?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

interface CountRow {
  count: number;
}

interface SourceRow {
  id: string;
  sessions: number;
  scannedAt: number;
}

interface ToolRow {
  tool: string;
  count: number;
  errors: number;
}

interface KindRow {
  kind: string;
  count: number;
}

interface DirectoryRow {
  directory: string;
  count: number;
}

export interface DashboardStats {
  sessions: number;
  toolEvents: number;
  toolErrors: number;
  artifacts: number;
  sources: SourceRow[];
  topTools: ToolRow[];
  artifactKinds: KindRow[];
  topDirectories: DirectoryRow[];
}

export interface SessionListItem {
  sourceId: string;
  sessionId: string;
  parentId: string | null;
  title: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
  messageCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  intentPreview: string;
}

export interface SessionDetail extends SessionListItem {
  projectId: string;
  opencodeVersion: string;
  timeArchived: number | null;
  userMessageCount: number;
  assistantMessageCount: number;
  partCount: number;
  userIntent: string;
  contentHash: string;
  processedAt: number;
  tools: Array<{
    messageId: string;
    partId: string;
    timeCreated: number;
    tool: string;
    status: string;
    inputSummary: string;
    errorSignature: string | null;
  }>;
  artifacts: Array<{
    kind: string;
    value: string;
    sourceMessageId: string | null;
    sourcePartId: string | null;
  }>;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 40;
  return Math.max(1, Math.min(Math.trunc(value ?? 40), 100));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value ?? 0));
}

function ftsQuery(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

export class DashboardRepository {
  constructor(private readonly database: Database) {}

  stats(): DashboardStats {
    const count = (table: string, condition = ""): number =>
      this.database.query<CountRow, []>(`SELECT count(*) AS count FROM ${table} ${condition}`).get()?.count ?? 0;

    return {
      sessions: count("session_documents"),
      toolEvents: count("tool_events"),
      toolErrors: count("tool_events", "WHERE status = 'error'"),
      artifacts: count("artifacts"),
      sources: this.database.query<SourceRow, []>(`
        SELECT s.id, count(d.session_id) AS sessions, s.scanned_at AS scannedAt
        FROM sources s LEFT JOIN session_documents d ON d.source_id = s.id
        GROUP BY s.id ORDER BY sessions DESC
      `).all(),
      topTools: this.database.query<ToolRow, []>(`
        SELECT tool, count(*) AS count,
               sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
        FROM tool_events GROUP BY tool ORDER BY count DESC LIMIT 12
      `).all(),
      artifactKinds: this.database.query<KindRow, []>(`
        SELECT kind, count(*) AS count FROM artifacts GROUP BY kind ORDER BY count DESC
      `).all(),
      topDirectories: this.database.query<DirectoryRow, []>(`
        SELECT directory, count(*) AS count FROM session_documents
        GROUP BY directory ORDER BY count DESC LIMIT 10
      `).all(),
    };
  }

  searchSessions(search: SessionSearch): { items: SessionListItem[]; total: number } {
    const query = search.query?.trim() ?? "";
    const source = search.source?.trim() ?? "";
    const limit = clampLimit(search.limit);
    const offset = normalizeOffset(search.offset);

    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (source) {
      conditions.push("d.source_id = ?");
      params.push(source);
    }
    if (query) {
      conditions.push("session_documents_fts MATCH ?");
      params.push(ftsQuery(query));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const from = query
      ? "FROM session_documents_fts f JOIN session_documents d ON d.source_id=f.source_id AND d.session_id=f.session_id"
      : "FROM session_documents d";

    const total = this.database
      .query<CountRow, Array<string | number>>(`SELECT count(*) AS count ${from} ${where}`)
      .get(...params)?.count ?? 0;

    const items = this.database.query<SessionListItem, Array<string | number>>(`
      SELECT d.source_id AS sourceId, d.session_id AS sessionId, d.parent_id AS parentId,
             d.title, d.directory, d.time_created AS timeCreated, d.time_updated AS timeUpdated,
             d.message_count AS messageCount, d.tool_call_count AS toolCallCount,
             d.tool_error_count AS toolErrorCount,
             substr(replace(d.user_intent, char(10), ' '), 1, 240) AS intentPreview
      ${from} ${where}
      ORDER BY d.time_updated DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return { items, total };
  }

  session(sourceId: string, sessionId: string): SessionDetail | null {
    const session = this.database.query<Omit<SessionDetail, "tools" | "artifacts">, [string, string]>(`
      SELECT source_id AS sourceId, session_id AS sessionId, parent_id AS parentId,
             project_id AS projectId, title, directory, opencode_version AS opencodeVersion,
             time_created AS timeCreated, time_updated AS timeUpdated, time_archived AS timeArchived,
             message_count AS messageCount, user_message_count AS userMessageCount,
             assistant_message_count AS assistantMessageCount, part_count AS partCount,
             tool_call_count AS toolCallCount, tool_error_count AS toolErrorCount,
             user_intent AS userIntent, substr(replace(user_intent, char(10), ' '), 1, 240) AS intentPreview,
             content_hash AS contentHash, processed_at AS processedAt
      FROM session_documents WHERE source_id = ? AND session_id = ?
    `).get(sourceId, sessionId);
    if (!session) return null;

    const tools = this.database.query<SessionDetail["tools"][number], [string, string]>(`
      SELECT message_id AS messageId, part_id AS partId, time_created AS timeCreated,
             tool, status, input_summary AS inputSummary, error_signature AS errorSignature
      FROM tool_events WHERE source_id = ? AND session_id = ?
      ORDER BY time_created, part_id LIMIT 1_000
    `).all(sourceId, sessionId);
    const artifacts = this.database.query<SessionDetail["artifacts"][number], [string, string]>(`
      SELECT kind, value, source_message_id AS sourceMessageId, source_part_id AS sourcePartId
      FROM artifacts WHERE source_id = ? AND session_id = ?
      ORDER BY kind, value LIMIT 2_000
    `).all(sourceId, sessionId);

    return { ...session, tools, artifacts };
  }
}
