import { loadConfig } from "../src/config.ts";
import { populateBackfillQueue, BackfillQueue } from "../src/backfill/queue.ts";
import { BackfillRunner } from "../src/backfill/runner.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
populateBackfillQueue(database, config.bootstrapDbPath);
const runner = new BackfillRunner(database, config.bootstrapDbPath);
runner.start();
while (runner.isRunning()) {
  console.log(new BackfillQueue(database).stats());
  await Bun.sleep(10_000);
}
console.log("backfill complete", new BackfillQueue(database).stats());
database.close();
