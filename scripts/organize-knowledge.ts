import { loadConfig } from "../src/config.ts";
import { readSourceSessionMetadata } from "../src/behavior/source.ts";
import { BehaviorRepository } from "../src/dashboard/behavior-repository.ts";
import { proposeKnowledge, saveKnowledge } from "../src/knowledge/organize.ts";
import { findRecurringTerms } from "../src/knowledge/recurrence.ts";
import { openMemoryDatabase } from "../src/store/database.ts";
import { basename } from "node:path";
import { linkInstanceToKnowledge, saveSessionInstance } from "../src/knowledge/objects.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const source = argument("--source") ?? "main";
const session = argument("--session");
if (!session) throw new Error("--session is required");
const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
try {
  const behavior = new BehaviorRepository(database).session(source, session);
  if (!behavior) throw new Error(`behavior graph not found: ${source}/${session}`);
  const metadata = readSourceSessionMetadata(source, session);
  const namespace = basename(metadata.directory) || metadata.directory;
  const recurrence = findRecurringTerms(config.bootstrapDbPath, behavior, metadata.directory);
  const proposal = await proposeKnowledge(behavior, namespace, recurrence);
  const instanceId = saveSessionInstance(database, source, session, namespace, behavior);
  const ids = saveKnowledge(database, source, session, behavior, proposal);
  linkInstanceToKnowledge(database, instanceId, ids);
  console.log(`${source}/${session}: organized ${ids.length} entries and ${proposal.links.length} links`);
} finally {
  database.close();
}
