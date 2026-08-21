import { loadConfig } from "./config.ts";
import { startDashboard } from "./dashboard/server.ts";
import { openMemoryDatabase } from "./store/database.ts";

const config = loadConfig();

// 已有健康 daemon 在跑（例如 launchd KeepAlive 与 plugin 兜底同时拉起）时静默退出，
// 避免重复绑定端口导致 EADDRINUSE crash 与 KeepAlive 反复重启。
try {
  const existing = await fetch(`http://${config.dashboardHost}:${config.dashboardPort}/api/health`, {
    signal: AbortSignal.timeout(500),
  });
  if (existing.ok) {
    console.log("opencode-memory already running; exiting");
    process.exit(0);
  }
} catch {
  // 端口无响应，说明没有 daemon 在跑，继续启动
}

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
