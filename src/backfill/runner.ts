import type { Database } from "bun:sqlite";
import { KnowledgeDomainIndexer } from "../knowledge/indexer.ts";
import { KnowledgePruner } from "../knowledge/prune.ts";
import { AdaptiveHierarchyOrganizer } from "../knowledge/hierarchy.ts";
import { MemoryProcessor } from "../worker/processor.ts";
import { BackfillQueue } from "./queue.ts";

export class BackfillRunner {
  private running = false;
  private stopRequested = false;
  private finalizing = false;

  constructor(
    private readonly database: Database,
    private readonly bootstrapPath: string,
    private readonly concurrency = Number.parseInt(Bun.env.OPENCODE_MEMORY_BACKFILL_CONCURRENCY ?? "2", 10),
  ) {}

  start(): void {
    if (this.running) return;
    this.stopRequested = false;
    this.running = true;
    void Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, (_, index) => this.worker(index === 0 ? "priority" : "quick")))
      .finally(() => { this.running = false; });
  }

  stop(): void { this.stopRequested = true; }
  isRunning(): boolean { return this.running; }

  private async finalizeIfIdle(): Promise<void> {
    if (this.finalizing) return;
    this.finalizing = true;
    try {
      await new KnowledgeDomainIndexer(this.database).run();
      await new AdaptiveHierarchyOrganizer(this.database).run().catch(() => null);
      await new KnowledgePruner(this.database).run().catch(() => 0);
    } finally {
      this.finalizing = false;
    }
  }

  private async worker(strategy: "priority" | "quick"): Promise<void> {
    const queue = new BackfillQueue(this.database);
    const processor = new MemoryProcessor(this.database, this.bootstrapPath, 0);
    while (!this.stopRequested) {
      let family: ReturnType<BackfillQueue["claimNext"]>;
      try {
        family = queue.claimNext(strategy);
      } catch (error) {
        console.error("backfill claim failed", error);
        await Bun.sleep(2_000);
        continue;
      }
      if (!family) break;
      try {
        await processor.process({
          sourceId: family.representativeSourceId,
          sessionId: family.representativeSessionId,
          allowFork: true,
          onProgress: (done, total) => queue.progress(family.id, done, total),
        });
        this.mergeFamilyOrigins(queue.members(family.id), family.representativeSourceId, family.representativeSessionId);
        const job = this.database.query<{ status: string; error: string | null }, [string, string]>(`
          SELECT status,error FROM processing_jobs WHERE source_id=? AND session_id=?
        `).get(family.representativeSourceId, family.representativeSessionId);
        queue.finish(family.id, job?.status === "skipped" ? "skipped" : "completed", job?.error ?? undefined);
      } catch (error) {
        queue.finish(family.id, "failed", error instanceof Error ? error.message.slice(0, 4_000) : String(error));
      }
    }
    if (!this.stopRequested && new BackfillQueue(this.database).stats().pending === 0) {
      await this.finalizeIfIdle();
    }
  }

  private mergeFamilyOrigins(
    members: Array<{ sourceId: string; sessionId: string }>,
    representativeSourceId: string,
    representativeSessionId: string,
  ): void {
    if (members.length <= 1) return;
    const entryIds = this.database.query<{ entry_id: string }, [string, string]>(`
      SELECT entry_id FROM entry_origins WHERE source_id=? AND session_id=?
    `).all(representativeSourceId, representativeSessionId).map(({ entry_id }) => entry_id);
    const now = Date.now();
    const insert = this.database.query(`
      INSERT OR IGNORE INTO entry_origins(entry_id,source_id,session_id,source_node_ids,created_at)
      VALUES (?, ?, ?, '[]', ?)
    `);
    this.database.transaction(() => {
      for (const entryId of entryIds) {
        for (const member of members) insert.run(entryId, member.sourceId, member.sessionId, now);
      }
    })();
  }
}
