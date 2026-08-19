import { loadConfig } from "../src/config.ts";
import { openMemoryDatabase } from "../src/store/database.ts";
import { bigrams, cosineSimilarity } from "../src/similarity/bigram.ts";
import { domainInterfaceId } from "../src/knowledge/domains.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 15000");
try {
  const orphans = database.query<{ id: string; title: string; content: string; domain: string | null }, []>(`
    SELECT e.id,e.title,e.content,e.domain FROM entries e
    WHERE e.role='implementation' AND e.valid_to IS NULL AND e.status IN ('generated','active')
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_entry_id=e.id AND l.relation IN ('IMPLEMENTS','EXTENDS') AND l.valid_to IS NULL)
  `).all();
  const now = Date.now();
  let linked = 0;
  let toRoot = 0;
  let skipped = 0;
  for (const orphan of orphans) {
    const ovec = bigrams(`${orphan.title} ${orphan.content.slice(0, 400)}`);
    const candidates = orphan.domain
      ? database.query<{ id: string; title: string; content: string }, [string]>(`
          SELECT e.id,e.title,e.content FROM entries e
          WHERE e.role='interface' AND e.kind<>'能力域' AND e.valid_to IS NULL AND e.status='generated' AND e.domain=?
        `).all(orphan.domain)
      : [];
    let best: { id: string } | null = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = cosineSimilarity(ovec, bigrams(`${candidate.title} ${candidate.content.slice(0, 400)}`));
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    const insert = database.query("INSERT OR IGNORE INTO links(source_entry_id,target_entry_id,relation,valid_from,valid_to,created_at) VALUES (?,?,?,?,NULL,?)");
    if (best && bestScore >= 0.25) {
      insert.run(orphan.id, best.id, "IMPLEMENTS", now, now);
      linked += 1;
    } else if (orphan.domain) {
      insert.run(orphan.id, domainInterfaceId(orphan.domain), "IMPLEMENTS", now, now);
      toRoot += 1;
    } else {
      skipped += 1;
    }
  }
  console.log({ orphans: orphans.length, linked, toRoot, skipped });
} finally {
  database.close();
}
