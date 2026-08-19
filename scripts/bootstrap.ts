import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createBootstrapDatabase } from "../src/bootstrap/database.ts";
import { processSource, type BootstrapSource } from "../src/bootstrap/process.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const force = process.argv.includes("--force");
const defaultDirectory = resolve(homedir(), ".local/share/opencode");
const outputPath = resolve(
  argument("--output") ?? resolve(homedir(), ".local/share/opencode-memory/bootstrap.db"),
);
const sources: BootstrapSource[] = [
  { id: "main", path: resolve(defaultDirectory, "opencode.db") },
  { id: "dev", path: resolve(defaultDirectory, "opencode-dev.db") },
  { id: "local", path: resolve(defaultDirectory, "opencode-local.db") },
].filter(({ path }) => existsSync(path));

if (sources.length === 0) throw new Error("No opencode databases found");
if (existsSync(outputPath) && !force) {
  throw new Error(`${outputPath} already exists; pass --force to rebuild it`);
}

const temporaryPath = `${outputPath}.tmp-${process.pid}`;
rmSync(temporaryPath, { force: true });

try {
  const database = createBootstrapDatabase(temporaryPath);
  let totalSessions = 0;
  let totalTools = 0;
  let totalArtifacts = 0;

  for (const source of sources) {
    const counts = processSource(database, source);
    totalSessions += counts.sessions;
    totalTools += counts.toolEvents;
    totalArtifacts += counts.artifacts;
    console.log(
      `${source.id}: ${counts.sessions} sessions, ${counts.toolEvents} tool events, ${counts.artifacts} artifacts`,
    );
  }

  database.exec("PRAGMA optimize;");
  database.close();
  rmSync(outputPath, { force: true });
  renameSync(temporaryPath, outputPath);
  console.log(
    `created ${outputPath}: ${totalSessions} sessions, ${totalTools} tool events, ${totalArtifacts} artifacts`,
  );
} catch (error) {
  rmSync(temporaryPath, { force: true });
  throw error;
}
