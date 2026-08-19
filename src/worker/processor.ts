import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { extractEpisodeGraph, saveEpisodeGraph } from "../behavior/extract.ts";
import { findSessionSource, readSessionTimeline, readSourceSessionMetadata } from "../behavior/source.ts";
import { BehaviorRepository } from "../dashboard/behavior-repository.ts";
import { proposeKnowledge, saveKnowledge } from "../knowledge/organize.ts";
import { findRecurringTerms } from "../knowledge/recurrence.ts";
import { linkInstanceToKnowledge, saveSessionInstance } from "../knowledge/objects.ts";

export interface ProcessingRequest {
  sessionId: string;
  sourceId?: string | undefined;
  allowFork?: boolean | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export class MemoryProcessor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue = Promise.resolve();

  constructor(
    private readonly database: Database,
    private readonly bootstrapDbPath: string,
    private readonly debounceMs = Number.parseInt(Bun.env.OPENCODE_MEMORY_IDLE_DEBOUNCE_MS ?? "300000", 10),
    private readonly onKnowledgeChanged?: (() => void) | undefined,
  ) {}

  request(input: ProcessingRequest): void {
    const current = this.timers.get(input.sessionId);
    if (current) clearTimeout(current);
    this.timers.set(input.sessionId, setTimeout(() => {
      this.timers.delete(input.sessionId);
      this.queue = this.queue.then(() => this.process(input)).catch((error) => {
        console.error(`memory processing failed for ${input.sessionId}`, error);
      });
    }, this.debounceMs));
  }

  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  async process(input: ProcessingRequest): Promise<void> {
    const sourceId = input.sourceId ?? findSessionSource(input.sessionId);
    if (!sourceId) throw new Error(`cannot locate session ${input.sessionId}`);
    const now = Date.now();
    this.database.query(`
      INSERT INTO processing_jobs(source_id, session_id, status, attempts, requested_at, started_at)
      VALUES (?, ?, 'running', 1, ?, ?)
      ON CONFLICT(source_id, session_id) DO UPDATE SET
        status='running', attempts=processing_jobs.attempts+1, error=NULL,
        requested_at=excluded.requested_at, started_at=excluded.started_at
    `).run(sourceId, input.sessionId, now, now);

    try {
      const metadata = readSourceSessionMetadata(sourceId, input.sessionId);
      if (metadata.parentId && !input.allowFork) {
        this.complete(sourceId, input.sessionId);
        return;
      }
      const timeline = readSessionTimeline(sourceId, input.sessionId);
      if (timeline.events.length < 2) throw new Error("session has too little observable behavior");
      const codeTools = new Set(["edit", "write", "apply_patch"]);
      const hasCodeSignal = timeline.events.some((event) =>
        event.role === "tool" && (
          codeTools.has(event.tool ?? "")
          || (event.tool === "bash" && /\b(?:git|gradle|mvn|npm|bun|pnpm|yarn|pytest|cargo|go test|kubectl|aliyun|docker|gh)\b/i.test(event.text))
        )
      );
      if (!hasCodeSignal) {
        this.database.query(`
          UPDATE processing_jobs SET status='skipped', error='no code or operations signal', completed_at=?
          WHERE source_id=? AND session_id=?
        `).run(Date.now(), sourceId, input.sessionId);
        return;
      }
      const existing = this.database.query<{ source_hash: string }, [string, string]>(
        "SELECT source_hash FROM episode_capsules WHERE source_id = ? AND session_id = ?",
      ).get(sourceId, input.sessionId);
      const origins = this.database.query<{ count: number }, [string, string]>(
        "SELECT count(*) AS count FROM entry_origins WHERE source_id = ? AND session_id = ?",
      ).get(sourceId, input.sessionId)?.count ?? 0;
      if (existing?.source_hash === timeline.sourceHash && origins > 0) {
        this.complete(sourceId, input.sessionId);
        return;
      }

      const graph = await extractEpisodeGraph(sourceId, input.sessionId, this.database, undefined, input.onProgress);
      saveEpisodeGraph(this.database, sourceId, input.sessionId, graph);
      const behavior = new BehaviorRepository(this.database).session(sourceId, input.sessionId);
      if (!behavior) throw new Error("saved behavior graph cannot be loaded");
      const namespace = basename(metadata.directory) || metadata.directory;
      const instanceId = saveSessionInstance(this.database, sourceId, input.sessionId, namespace, behavior);
      const recurrence = findRecurringTerms(this.bootstrapDbPath, behavior, metadata.directory);
      const proposal = await proposeKnowledge(behavior, namespace, recurrence);
      const knowledgeIds = saveKnowledge(this.database, sourceId, input.sessionId, behavior, proposal);
      linkInstanceToKnowledge(this.database, instanceId, knowledgeIds);
      this.onKnowledgeChanged?.();
      this.complete(sourceId, input.sessionId);
      console.log(`organized memory for ${sourceId}/${input.sessionId}: ${proposal.entries.length} entries`);
    } catch (error) {
      this.database.query(`
        UPDATE processing_jobs SET status='failed', error=?, completed_at=?
        WHERE source_id=? AND session_id=?
      `).run(error instanceof Error ? error.message.slice(0, 4_000) : String(error), Date.now(), sourceId, input.sessionId);
      throw error;
    }
  }

  private complete(sourceId: string, sessionId: string): void {
    this.database.query(`
      UPDATE processing_jobs SET status='completed', error=NULL, completed_at=?
      WHERE source_id=? AND session_id=?
    `).run(Date.now(), sourceId, sessionId);
  }
}
