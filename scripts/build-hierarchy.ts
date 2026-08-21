import { loadConfig } from "../src/config.ts";
import { AdaptiveHierarchyOrganizer } from "../src/knowledge/hierarchy.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
database.exec("PRAGMA busy_timeout = 15000");
try {
  console.log(await new AdaptiveHierarchyOrganizer(database).run());
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  throw error;
} finally {
  database.close();
}
