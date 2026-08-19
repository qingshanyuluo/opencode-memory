import { loadConfig } from "../src/config.ts";
import { KnowledgeDomainIndexer } from "../src/knowledge/indexer.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
database.exec("PRAGMA busy_timeout = 15000");
try {
  console.log(await new KnowledgeDomainIndexer(database, 0).run());
} finally {
  database.close();
}
