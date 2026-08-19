import { loadConfig } from "../src/config.ts";
import { KnowledgePruner } from "../src/knowledge/prune.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
try {
  const result = await new KnowledgePruner(database, undefined, 0).run();
  console.log(result);
} finally {
  database.close();
}
