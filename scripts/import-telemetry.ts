import { loadConfig } from "../src/config.ts";
import { openMemoryDatabase } from "../src/store/database.ts";
import { importOpencodeTelemetry } from "../src/telemetry/importer.ts";

const config = loadConfig();
const database = openMemoryDatabase(config.memoryDbPath);
try { console.log({ imported: importOpencodeTelemetry(database) }); }
finally { database.close(); }
