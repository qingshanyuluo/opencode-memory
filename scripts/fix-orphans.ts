import { loadConfig } from "../src/config.ts";
import { openMemoryDatabase } from "../src/store/database.ts";
import { bigrams, cosineSimilarity } from "../src/similarity/bigram.ts";

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
  const allInterfaces = database.query<{ id: string; title: string; content: string }, []>(`
    SELECT id,title,content FROM entries
    WHERE role='interface' AND kind<>'能力域' AND valid_to IS NULL AND status='generated'
  `).all();
  const roots = database.query<{ id: string; title: string; content: string }, []>(`
    SELECT id,title,content FROM entries
    WHERE role='interface' AND kind='能力域' AND valid_to IS NULL
  `).all();
  for (const orphan of orphans) {
    const ovec = bigrams(`${orphan.title} ${orphan.content.slice(0, 400)}`);
    let best: { id: string } | null = null;
    let bestScore = 0;
    for (const candidate of allInterfaces) {
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
      continue;
    }
    let bestRoot: { id: string } | null = null;
    let bestRootScore = 0;
    for (const root of roots) {
      const score = cosineSimilarity(ovec, bigrams(`${root.title} ${root.content.slice(0, 400)}`));
      if (score > bestRootScore) {
        bestRootScore = score;
        bestRoot = root;
      }
    }
    if (bestRoot) {
      insert.run(orphan.id, bestRoot.id, "IMPLEMENTS", now, now);
      toRoot += 1;
    } else {
      skipped += 1;
    }
  }
  console.log({ orphans: orphans.length, linked, toRoot, skipped });
  database.exec(`
    WITH RECURSIVE dom(id, domain) AS (
      SELECT id, title FROM entries
      WHERE role='interface' AND kind='能力域' AND valid_to IS NULL
      UNION
      SELECT l.source_entry_id, dom.domain
      FROM links l JOIN dom ON l.target_entry_id = dom.id
      WHERE l.relation IN ('IMPLEMENTS','EXTENDS') AND l.valid_to IS NULL
    )
    UPDATE entries SET domain = (SELECT domain FROM dom WHERE dom.id = entries.id LIMIT 1)
    WHERE valid_to IS NULL AND role IN ('implementation','interface','abstract')
      AND id IN (SELECT id FROM dom)
  `);
} finally {
  database.close();
}
