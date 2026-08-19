import { loadConfig } from "./config.ts";
import { startDashboard } from "./dashboard/server.ts";
import { openMemoryDatabase } from "./store/database.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
const dashboard = startDashboard(config, database);

console.log(`opencode-memory initialized: ${config.memoryDbPath}`);
console.log(`opencode-memory dashboard: ${dashboard.url}`);

async function shutdown(): Promise<void> {
  await dashboard.stop();
  database.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await new Promise(() => {});
