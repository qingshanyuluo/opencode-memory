import { loadConfig } from "../src/config.ts";
import { openMemoryDatabase } from "../src/store/database.ts";
import { classifyDomainsByLLM } from "../src/knowledge/domain-classifier.ts";
import { KnowledgeRepository } from "../src/knowledge/repository.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
database.exec("PRAGMA busy_timeout = 15000");
try {
  const rows = database.query<{ id: string; title: string; content: string; kind: string | null; tags: string; domain: string | null }, []>(`
    SELECT id,title,content,kind,tags,domain FROM entries
    WHERE valid_to IS NULL AND status IN ('generated','active')
      AND role IN ('implementation','interface')
      AND kind <> '能力域'
  `).all();
  const domains = await classifyDomainsByLLM(rows, undefined, database);
  let changed = 0;
  const now = Date.now();
  const update = database.query("UPDATE entries SET domain=?,updated_at=? WHERE id=?");
  database.transaction(() => {
    for (const row of rows) {
      const domain = domains.get(row.id) ?? null;
      if (domain && domain !== row.domain) {
        update.run(domain, now, row.id);
        changed += 1;
      }
    }
  });
  new KnowledgeRepository(database).rebuildFts();
  console.log({ total: rows.length, changed });
} finally {
  database.close();
}
