import type { Database } from "bun:sqlite";

export class TelemetryMetrics {
  constructor(private readonly database: Database) {}

  summary(): Record<string, unknown> {
    const totals = this.database.query<{
      total: number; hits: number; sessions: number; projects: number;
      avg_latency: number | null; avg_hits: number | null;
      avg_followup: number | null; avg_edits: number | null;
    }, []>(`
      SELECT count(*) AS total,
             sum(CASE WHEN hit_count>0 THEN 1 ELSE 0 END) AS hits,
             count(DISTINCT session_id) AS sessions,
             count(DISTINCT directory) AS projects,
             avg(latency_ms) AS avg_latency,avg(hit_count) AS avg_hits,
             avg(followup_tool_count) AS avg_followup,avg(followup_edit_count) AS avg_edits
      FROM memory_recalls
    `).get() ?? { total: 0, hits: 0, sessions: 0, projects: 0, avg_latency: 0, avg_hits: 0, avg_followup: 0, avg_edits: 0 };
    const injectionCount = this.database.query<{ count: number }, []>("SELECT count(*) AS count FROM memory_injections").get()?.count ?? 0;
    const latencyRows = this.database.query<{ latency_ms: number }, []>("SELECT latency_ms FROM memory_recalls ORDER BY latency_ms").all();
    const p95Index = Math.max(0, Math.ceil(latencyRows.length * 0.95) - 1);
    const p95 = latencyRows[p95Index]?.latency_ms ?? 0;
    const feedback = this.database.query<{ verdict: string; count: number }, []>(`
      SELECT verdict,count(*) AS count FROM memory_feedback GROUP BY verdict
    `).all();
    const feedbackMap = Object.fromEntries(feedback.map(({ verdict, count }) => [verdict, count]));
    const judged = (feedbackMap.useful ?? 0) + (feedbackMap.not_useful ?? 0);
    const trend = this.database.query<{ day: string; total: number; hits: number; avgLatency: number }, []>(`
      SELECT date(recalled_at/1000,'unixepoch','localtime') AS day,
             count(*) AS total,sum(CASE WHEN hit_count>0 THEN 1 ELSE 0 END) AS hits,
             round(avg(latency_ms)) AS avgLatency
      FROM memory_recalls GROUP BY day ORDER BY day DESC LIMIT 30
    `).all().reverse();
    const byDomain = this.database.query<{ domain: string; total: number; hits: number }, []>(`
      SELECT coalesce(domain,'未指定') AS domain,count(*) AS total,
             sum(CASE WHEN hit_count>0 THEN 1 ELSE 0 END) AS hits
      FROM memory_recalls GROUP BY domain ORDER BY total DESC LIMIT 15
    `).all();
    const byProject = this.database.query<{ directory: string; total: number; hits: number }, []>(`
      SELECT directory,count(*) AS total,sum(CASE WHEN hit_count>0 THEN 1 ELSE 0 END) AS hits
      FROM memory_recalls GROUP BY directory ORDER BY total DESC LIMIT 12
    `).all();
    const roles = this.database.query<{ role: string; count: number }, []>(`
      SELECT 'interface' AS role,sum(interface_count) AS count FROM memory_recalls UNION ALL
      SELECT 'implementation',sum(implementation_count) FROM memory_recalls UNION ALL
      SELECT 'resource',sum(resource_count) FROM memory_recalls UNION ALL
      SELECT 'instance',sum(instance_count) FROM memory_recalls
    `).all();
    return {
      recalls: totals.total,
      hits: totals.hits,
      misses: totals.total - totals.hits,
      hitRate: totals.total ? totals.hits / totals.total : null,
      uniqueSessions: totals.sessions,
      projects: totals.projects,
      injections: injectionCount,
      avgLatencyMs: Math.round(totals.avg_latency ?? 0),
      p95LatencyMs: p95,
      avgEntries: Number((totals.avg_hits ?? 0).toFixed(2)),
      avgFollowupTools: Number((totals.avg_followup ?? 0).toFixed(2)),
      avgFollowupEdits: Number((totals.avg_edits ?? 0).toFixed(2)),
      feedback: { ...feedbackMap, judged, usefulness: judged ? (feedbackMap.useful ?? 0) / judged : null },
      trend,
      byDomain,
      byProject,
      roles,
    };
  }

  recalls(limit = 100, offset = 0): { items: unknown[]; total: number } {
    const total = this.database.query<{ count: number }, []>("SELECT count(*) AS count FROM memory_recalls").get()?.count ?? 0;
    const items = this.database.query<Record<string, unknown>, [number, number]>(`
      SELECT r.id,r.source,r.session_id AS sessionId,r.directory,r.agent,r.query,r.domain,
             r.namespace,r.mode,r.depth,r.include_instances AS includeInstances,
             r.status,r.hit_count AS hitCount,r.root_count AS rootCount,
             r.interface_count AS interfaceCount,r.implementation_count AS implementationCount,
             r.resource_count AS resourceCount,r.instance_count AS instanceCount,
             r.latency_ms AS latencyMs,r.recalled_at AS recalledAt,
             r.followup_tool_count AS followupToolCount,r.followup_edit_count AS followupEditCount,
             r.error,f.verdict,f.note
      FROM memory_recalls r LEFT JOIN memory_feedback f ON f.recall_id=r.id
      ORDER BY r.recalled_at DESC LIMIT ? OFFSET ?
    `).all(Math.max(1, Math.min(limit, 200)), Math.max(0, offset));
    return { items, total };
  }
}
