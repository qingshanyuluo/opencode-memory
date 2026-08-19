import { loadConfig } from "../src/config.ts";
import { RefineConsolidator } from "../src/knowledge/consolidate-pairs.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
database.exec("PRAGMA busy_timeout = 15000");
try {
  console.log(await new RefineConsolidator(database).consolidate());
} finally {
  database.close();
}
