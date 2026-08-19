import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AppConfig {
  opencodeUrl: string;
  opencodeDbPath: string;
  bootstrapDbPath: string;
  memoryDbPath: string;
  dashboardHost: string;
  dashboardPort: number;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dashboardPort = Number.parseInt(env.OPENCODE_MEMORY_DASHBOARD_PORT ?? "37780", 10);
  if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65_535) {
    throw new Error("OPENCODE_MEMORY_DASHBOARD_PORT must be a valid TCP port");
  }

  return {
    opencodeUrl: env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    opencodeDbPath: expandHome(
      env.OPENCODE_DB_PATH ?? "~/.local/share/opencode/opencode.db",
    ),
    bootstrapDbPath: expandHome(
      env.BOOTSTRAP_DB_PATH ?? "~/.local/share/opencode-memory/bootstrap.db",
    ),
    memoryDbPath: expandHome(
      env.MEMORY_DB_PATH ?? "~/.local/share/opencode-memory/memory.db",
    ),
    dashboardHost: env.OPENCODE_MEMORY_DASHBOARD_HOST ?? "127.0.0.1",
    dashboardPort,
  };
}
