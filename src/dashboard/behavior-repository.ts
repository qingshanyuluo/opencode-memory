import type { Database } from "bun:sqlite";

interface BehaviorStats {
  capsules: number;
  nodes: number;
}

interface EpisodeCapsule {
  title: string;
  summary: string;
  outcome: string;
  model: string;
  status: string;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

interface EpisodeNode {
  id: string;
  sequence: number;
  type: string;
  status: string;
  content: string;
  confidence: number;
  sourcePartIds: string[];
}

interface EpisodeEdge {
  sourceNodeId: string;
  targetNodeId: string;
  relation: string;
}

export interface EpisodeBehavior {
  capsule: EpisodeCapsule;
  nodes: EpisodeNode[];
  edges: EpisodeEdge[];
}

export class BehaviorRepository {
  constructor(private readonly database: Database) {}

  stats(): BehaviorStats {
    const capsules = this.database.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM episode_capsules",
    ).get()?.count ?? 0;
    const nodes = this.database.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM episode_nodes",
    ).get()?.count ?? 0;
    return { capsules, nodes };
  }

  hasSession(sourceId: string, sessionId: string): boolean {
    return Boolean(this.database.query<{ value: number }, [string, string]>(
      "SELECT 1 AS value FROM episode_capsules WHERE source_id = ? AND session_id = ?",
    ).get(sourceId, sessionId));
  }

  session(sourceId: string, sessionId: string): EpisodeBehavior | null {
    const capsule = this.database.query<EpisodeCapsule, [string, string]>(`
      SELECT title, summary, outcome, model, status, chunk_count AS chunkCount,
             created_at AS createdAt, updated_at AS updatedAt
      FROM episode_capsules WHERE source_id = ? AND session_id = ?
    `).get(sourceId, sessionId);
    if (!capsule) return null;

    const nodes = this.database.query<Omit<EpisodeNode, "sourcePartIds"> & { sourcePartIdsJson: string }, [string, string]>(`
      SELECT id, sequence, type, status, content, confidence,
             source_part_ids AS sourcePartIdsJson
      FROM episode_nodes WHERE source_id = ? AND session_id = ? ORDER BY sequence
    `).all(sourceId, sessionId).map(({ sourcePartIdsJson, ...node }) => ({
      ...node,
      sourcePartIds: JSON.parse(sourcePartIdsJson) as string[],
    }));
    const edges = this.database.query<EpisodeEdge, [string, string]>(`
      SELECT e.source_node_id AS sourceNodeId, e.target_node_id AS targetNodeId,
             e.relation
      FROM episode_edges e JOIN episode_nodes n ON n.id = e.source_node_id
      WHERE n.source_id = ? AND n.session_id = ?
      ORDER BY n.sequence
    `).all(sourceId, sessionId);
    return { capsule, nodes, edges };
  }
}
