import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { jsonrepair } from "jsonrepair";
import { EDGE_RELATIONS, NODE_STATUSES, NODE_TYPES, type ChunkExtraction, type ProposedEpisodeEdge, type ProposedEpisodeNode } from "./types.ts";

interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

interface OpencodeConfig {
  provider?: Record<string, { options?: ProviderOptions }>;
}

interface AuthStore {
  [provider: string]: { type?: string; key?: string } | undefined;
}

export interface BehaviorModel {
  id: string;
  extract(chunk: string, context: string): Promise<ChunkExtraction>;
}

export interface JsonModel {
  id: string;
  generate(system: string, user: string): Promise<unknown>;
}

const SYSTEM_PROMPT = `You reconstruct an agent's observable decision process from a coding-session timeline.

Output only valid JSON with this shape:
{
  "summary": "what this chunk accomplished",
  "outcome": "success|partial|failed|unknown",
  "nodes": [{
    "localId": "n1",
    "type": "goal|hypothesis|action|evidence|revision|decision|outcome|open_question",
    "status": "proposed|confirmed|rejected|partial|unknown",
    "content": "one concise, reusable statement",
    "confidence": 0.0,
    "sourcePartIds": ["prt_..."]
  }],
  "edges": [{
    "source": "n1",
    "target": "n2",
    "relation": "supports|contradicts|leads_to|revises|answers|blocks"
  }]
}

Rules:
- Reconstruct behavior, not hidden chain-of-thought. Compress reasoning into externally useful hypotheses, evidence, revisions and decisions.
- Every node MUST cite one or more part_id values present in the timeline. Never invent IDs.
- Distinguish hypotheses from confirmed evidence. Failed tools are observations, not necessarily conclusions.
- Record belief changes: when later evidence rejects an earlier idea, create a revision node and a contradicts/revises edge.
- Prefer 6-20 high-signal nodes per chunk. Skip routine narration, repeated reads, mechanical edits and status chatter.
- Preserve concrete technical names needed for reuse, but never output credentials or secrets.
- Use the same language as the timeline, usually Chinese.`;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(jsonrepair(candidate));
  }
}

function validateExtraction(value: unknown, allowedPartIds: Set<string>): ChunkExtraction {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawNodes = Array.isArray(object.nodes) ? object.nodes : [];
  const nodes: ProposedEpisodeNode[] = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    const type = typeof node.type === "string" && NODE_TYPES.includes(node.type as never) ? node.type as ProposedEpisodeNode["type"] : null;
    const status = typeof node.status === "string" && NODE_STATUSES.includes(node.status as never) ? node.status as ProposedEpisodeNode["status"] : "unknown";
    const content = typeof node.content === "string" ? node.content.trim() : "";
    const localId = typeof node.localId === "string" ? node.localId : `n${nodes.length + 1}`;
    const sourcePartIds = Array.isArray(node.sourcePartIds)
      ? [...new Set(node.sourcePartIds.filter((id): id is string => typeof id === "string" && allowedPartIds.has(id)))]
      : [];
    if (!type || !content || sourcePartIds.length === 0) continue;
    const confidence = typeof node.confidence === "number" ? Math.max(0, Math.min(1, node.confidence)) : 0.5;
    nodes.push({ localId, type, status, content, confidence, sourcePartIds });
  }

  const ids = new Set(nodes.map(({ localId }) => localId));
  const edges: ProposedEpisodeEdge[] = [];
  for (const raw of Array.isArray(object.edges) ? object.edges : []) {
    if (!raw || typeof raw !== "object") continue;
    const edge = raw as Record<string, unknown>;
    if (typeof edge.source !== "string" || typeof edge.target !== "string" || !ids.has(edge.source) || !ids.has(edge.target)) continue;
    if (typeof edge.relation !== "string" || !EDGE_RELATIONS.includes(edge.relation as never)) continue;
    edges.push({ source: edge.source, target: edge.target, relation: edge.relation as ProposedEpisodeEdge["relation"] });
  }

  const outcomes = ["success", "partial", "failed", "unknown"] as const;
  const outcome = typeof object.outcome === "string" && outcomes.includes(object.outcome as never)
    ? object.outcome as ChunkExtraction["outcome"]
    : "unknown";
  return {
    summary: typeof object.summary === "string" ? object.summary.trim() : "",
    outcome,
    nodes,
    edges,
  };
}

export function createConfiguredJsonModel(modelId = Bun.env.OPENCODE_MEMORY_BEHAVIOR_MODEL ?? "deepseek/deepseek-v4-flash"): JsonModel {
  const separator = modelId.indexOf("/");
  if (separator === -1) throw new Error("behavior model must include provider prefix");
  const providerId = modelId.slice(0, separator);
  const providerModel = modelId.slice(separator + 1);
  const configPath = Bun.env.OPENCODE_CONFIG_PATH ?? resolve(homedir(), ".config/opencode/opencode.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as OpencodeConfig;
  const options = config.provider?.[providerId]?.options;
  const authPath = Bun.env.OPENCODE_AUTH_PATH ?? resolve(homedir(), ".local/share/opencode/auth.json");
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as AuthStore;
  const apiKey = options?.apiKey ?? auth[providerId]?.key;
  if (!apiKey || !options?.baseURL) throw new Error(`provider ${providerId} requires a configured api key and baseURL`);
  const endpoint = `${options.baseURL.replace(/\/$/, "")}/chat/completions`;

  return {
    id: modelId,
    async generate(system, user) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: providerModel,
              temperature: 0,
              max_tokens: Number.parseInt(Bun.env.OPENCODE_MEMORY_MODEL_MAX_TOKENS ?? "32768", 10),
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
            }),
            signal: AbortSignal.timeout(Number.parseInt(Bun.env.OPENCODE_MEMORY_MODEL_TIMEOUT_MS ?? "300000", 10)),
          });
          if (!response.ok) throw new Error(`behavior model failed: ${response.status} ${await response.text()}`);
          const payload = await response.json() as {
            choices?: Array<{
              finish_reason?: string;
              message?: { content?: string; reasoning_content?: string };
            }>;
          };
          const choice = payload.choices?.[0];
          const content = choice?.message?.content || choice?.message?.reasoning_content;
          if (!content) throw new Error(`behavior model returned no content (finish=${choice?.finish_reason ?? "unknown"})`);
          return extractJson(content);
        } catch (error) {
          lastError = error;
          if (attempt < 3) await Bun.sleep(1_000 * 2 ** (attempt - 1));
        }
      }
      throw lastError;
    },
  };
}

export function createConfiguredModel(modelId = Bun.env.OPENCODE_MEMORY_BEHAVIOR_MODEL ?? "deepseek/deepseek-v4-flash"): BehaviorModel {
  const jsonModel = createConfiguredJsonModel(modelId);
  return {
    id: jsonModel.id,
    async extract(chunk, context) {
      const allowedPartIds = new Set([...chunk.matchAll(/part_id="([^"]+)"/g)].map((match) => match[1] as string));
      const extraction = validateExtraction(
        await jsonModel.generate(SYSTEM_PROMPT, `${context}\n\nTIMELINE CHUNK:\n${chunk}`),
        allowedPartIds,
      );
      if (extraction.nodes.length === 0) throw new Error("behavior model returned no evidence-backed nodes");
      return extraction;
    },
  };
}
