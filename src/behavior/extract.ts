import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createConfiguredModel, type BehaviorModel } from "./model.ts";
import { readSessionTimeline, renderTimelineEvents } from "./source.ts";
import type { ChunkExtraction, EpisodeGraph, ProposedEpisodeEdge, ProposedEpisodeNode, TimelineEvent } from "./types.ts";

function outcomeRank(value: EpisodeGraph["outcome"]): number {
  return { unknown: 0, failed: 1, partial: 2, success: 3 }[value];
}

export async function extractEpisodeGraph(
  sourceId: string,
  sessionId: string,
  database: Database,
  model: BehaviorModel = createConfiguredModel(),
  onProgress?: ((done: number, total: number) => void) | undefined,
): Promise<EpisodeGraph> {
  const timeline = readSessionTimeline(sourceId, sessionId);
  const nodes: ProposedEpisodeNode[] = [];
  const edges: ProposedEpisodeEdge[] = [];
  const summaries: string[] = [];
  let outcome: EpisodeGraph["outcome"] = "unknown";

  function applyExtraction(extraction: ChunkExtraction, prefix: string): void {
    const idMap = new Map<string, string>();
    for (const node of extraction.nodes) idMap.set(node.localId, `${prefix}${node.localId}`);
    nodes.push(...extraction.nodes.map((node) => ({ ...node, localId: idMap.get(node.localId) as string })));
    edges.push(...extraction.edges.flatMap((edge) => {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      return source && target ? [{ ...edge, source, target }] : [];
    }));
    if (extraction.summary) summaries.push(extraction.summary);
    if (outcomeRank(extraction.outcome) > outcomeRank(outcome)) outcome = extraction.outcome;
  }

  async function extractUnit(events: TimelineEvent[], cacheKey: number, label: string, depth = 0): Promise<void> {
    const renderedEvents = renderTimelineEvents(events);
    const chunkHash = createHash("sha256").update(renderedEvents).digest("hex");
    const prior = nodes.slice(-20).map((node) => `${node.localId} [${node.type}/${node.status}] ${node.content}`).join("\n");
    const context = `SESSION: ${timeline.title}\nCHUNK: ${label}\nPRIOR HIGH-SIGNAL NODES:\n${prior || "none"}`;
    const cached = database.query<{ payload: string }, [string, string, number, string, string]>(`
      SELECT payload FROM episode_chunk_results
      WHERE source_id = ? AND session_id = ? AND chunk_index = ? AND source_hash = ? AND model = ?
    `).get(sourceId, sessionId, cacheKey, chunkHash, model.id);

    if (cached) {
      const extraction = JSON.parse(cached.payload) as ChunkExtraction;
      console.log(`reused chunk ${label}: ${extraction.nodes.length} nodes`);
      applyExtraction(extraction, `c${cacheKey}_`);
      return;
    }

    try {
      const extraction = await model.extract(renderedEvents, context);
      database.query(`
        INSERT OR REPLACE INTO episode_chunk_results(
          source_id, session_id, chunk_index, source_hash, model, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sourceId, sessionId, cacheKey, chunkHash, model.id, JSON.stringify(extraction), Date.now());
      console.log(`extracted chunk ${label}: ${extraction.nodes.length} nodes`);
      applyExtraction(extraction, `c${cacheKey}_`);
    } catch (error) {
      if (events.length < 4 || depth >= 5) throw error;
      const middle = Math.ceil(events.length / 2);
      console.warn(`splitting chunk ${label} after extraction failure`);
      const base = 1_000_000 + cacheKey * 10;
      await extractUnit(events.slice(0, middle), base + 1, `${label}.1`, depth + 1);
      await extractUnit(events.slice(middle), base + 2, `${label}.2`, depth + 1);
    }
  }

  for (const chunk of timeline.chunks) {
    await extractUnit(chunk.events, chunk.index, `${chunk.index + 1}/${timeline.chunks.length}`);
    onProgress?.(chunk.index + 1, timeline.chunks.length);
  }

  return {
    title: timeline.title,
    summary: summaries.join("\n"),
    outcome,
    sourceHash: timeline.sourceHash,
    model: model.id,
    chunkCount: timeline.chunks.length,
    nodes,
    edges,
  };
}

export function saveEpisodeGraph(database: Database, sourceId: string, sessionId: string, graph: EpisodeGraph): void {
  const now = Date.now();
  database.transaction(() => {
    database.query("DELETE FROM episode_capsules WHERE source_id = ? AND session_id = ?").run(sourceId, sessionId);
    database.query(`
      INSERT INTO episode_capsules(
        source_id, session_id, title, summary, outcome, model, source_hash,
        status, chunk_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'generated', ?, ?, ?)
    `).run(sourceId, sessionId, graph.title, graph.summary, graph.outcome, graph.model, graph.sourceHash, graph.chunkCount, now, now);

    const nodeIds = new Map<string, string>();
    const insertNode = database.query(`
      INSERT INTO episode_nodes(
        id, source_id, session_id, sequence, type, status, content,
        confidence, source_part_ids, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    graph.nodes.forEach((node, sequence) => {
      const id = randomUUID();
      nodeIds.set(node.localId, id);
      insertNode.run(id, sourceId, sessionId, sequence, node.type, node.status, node.content, node.confidence, JSON.stringify(node.sourcePartIds), now);
    });

    const insertEdge = database.query(`
      INSERT OR IGNORE INTO episode_edges(source_node_id, target_node_id, relation, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const edge of graph.edges) {
      const source = nodeIds.get(edge.source);
      const target = nodeIds.get(edge.target);
      if (source && target) insertEdge.run(source, target, edge.relation, now);
    }
  })();
}
