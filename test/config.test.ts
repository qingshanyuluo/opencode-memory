import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("provides local defaults", () => {
    const config = loadConfig({});

    expect(config.opencodeUrl).toBe("http://127.0.0.1:4096");
    expect(config.opencodeDbPath).toBe(
      resolve(homedir(), ".local/share/opencode/opencode.db"),
    );
    expect(config.memoryDbPath).toBe(
      resolve(homedir(), ".local/share/opencode-memory/memory.db"),
    );
    expect(config.bootstrapDbPath).toBe(
      resolve(homedir(), ".local/share/opencode-memory/bootstrap.db"),
    );
    expect(config.dashboardHost).toBe("127.0.0.1");
    expect(config.dashboardPort).toBe(37_780);
  });

  test("expands home paths", () => {
    const config = loadConfig({ MEMORY_DB_PATH: "~/memory/test.db" });

    expect(config.memoryDbPath).toBe(resolve(homedir(), "memory/test.db"));
  });
});
