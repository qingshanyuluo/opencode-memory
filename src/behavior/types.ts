export const NODE_TYPES = [
  "goal",
  "hypothesis",
  "action",
  "evidence",
  "revision",
  "decision",
  "outcome",
  "open_question",
] as const;

export const NODE_STATUSES = ["proposed", "confirmed", "rejected", "partial", "unknown"] as const;
export const EDGE_RELATIONS = ["supports", "contradicts", "leads_to", "revises", "answers", "blocks"] as const;

export type EpisodeNodeType = typeof NODE_TYPES[number];
export type EpisodeNodeStatus = typeof NODE_STATUSES[number];
export type EpisodeEdgeRelation = typeof EDGE_RELATIONS[number];

export interface TimelineEvent {
  partId: string;
  messageId: string;
  timestamp: number;
  role: "user" | "assistant" | "reasoning" | "tool";
  text: string;
  tool?: string | undefined;
  toolStatus?: string | undefined;
}

export interface TimelineChunk {
  index: number;
  events: TimelineEvent[];
  text: string;
}

export interface ProposedEpisodeNode {
  localId: string;
  type: EpisodeNodeType;
  status: EpisodeNodeStatus;
  content: string;
  confidence: number;
  sourcePartIds: string[];
}

export interface ProposedEpisodeEdge {
  source: string;
  target: string;
  relation: EpisodeEdgeRelation;
}

export interface ChunkExtraction {
  summary: string;
  outcome: "success" | "partial" | "failed" | "unknown";
  nodes: ProposedEpisodeNode[];
  edges: ProposedEpisodeEdge[];
}

export interface EpisodeGraph {
  title: string;
  summary: string;
  outcome: "success" | "partial" | "failed" | "unknown";
  sourceHash: string;
  model: string;
  chunkCount: number;
  nodes: ProposedEpisodeNode[];
  edges: ProposedEpisodeEdge[];
}
