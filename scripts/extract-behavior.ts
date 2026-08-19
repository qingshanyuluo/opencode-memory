import { loadConfig } from "../src/config.ts";
import { extractEpisodeGraph, saveEpisodeGraph } from "../src/behavior/extract.ts";
import { openMemoryDatabase } from "../src/store/database.ts";

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
  const graph = await extractEpisodeGraph(source, session, database);
  saveEpisodeGraph(database, source, session, graph);
  console.log(`${source}/${session}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.chunkCount} chunks, outcome=${graph.outcome}`);
} finally {
  database.close();
}
