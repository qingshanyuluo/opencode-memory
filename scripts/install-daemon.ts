import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const project = resolve(import.meta.dir, "..");
const source = resolve(project, "support/io.opencode.memory.plist");
const targetDirectory = resolve(homedir(), "Library/LaunchAgents");
const target = resolve(targetDirectory, "io.opencode.memory.plist");
const dataDirectory = resolve(homedir(), ".local/share/opencode-memory");

mkdirSync(targetDirectory, { recursive: true });
mkdirSync(dataDirectory, { recursive: true });
copyFileSync(source, target);
chmodSync(target, 0o644);

const uid = process.getuid?.() ?? 501;
const service = `gui/${uid}/io.opencode.memory`;
const unload = Bun.spawnSync(["launchctl", "bootout", service]);
if (unload.exitCode !== 0 && !unload.stderr.toString().includes("Could not find service")) {
  console.warn(unload.stderr.toString().trim());
}
const bootstrap = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, target]);
if (bootstrap.exitCode !== 0) throw new Error(bootstrap.stderr.toString().trim());
const enable = Bun.spawnSync(["launchctl", "enable", service]);
if (enable.exitCode !== 0) throw new Error(enable.stderr.toString().trim());
const kickstart = Bun.spawnSync(["launchctl", "kickstart", "-k", service]);
if (kickstart.exitCode !== 0) throw new Error(kickstart.stderr.toString().trim());

console.log(`installed ${service}`);
console.log("dashboard: http://127.0.0.1:37780");
