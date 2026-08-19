export const MEMORY_ROLES = ["interface", "abstract", "implementation", "instance", "resource"] as const;
export const STRUCTURAL_RELATIONS = ["IMPLEMENTS", "EXTENDS", "INSTANCE_OF", "REFERENCES", "SUPERSEDES", "CONTRADICTS"] as const;
export type MemoryRole = typeof MEMORY_ROLES[number];
export type StructuralRelation = typeof STRUCTURAL_RELATIONS[number];

export interface KnowledgeProposalEntry {
  localId: string;
  title: string;
  content: string;
  role: MemoryRole;
  kind: string;
  namespace: string;
  contract: Record<string, unknown>;
  delta: Record<string, unknown>;
  tags: string[];
  confidence: number;
  sourceSequences: number[];
}

export interface KnowledgeProposalLink {
  source: string;
  target: string;
  relation: StructuralRelation;
}

export interface KnowledgeProposal {
  entries: KnowledgeProposalEntry[];
  links: KnowledgeProposalLink[];
}
