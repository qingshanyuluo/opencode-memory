import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const project = resolve(import.meta.dir, "..");
const dataDirectory = resolve(homedir(), ".local/share/opencode-memory");
const bunPath = Bun.which("bun") ?? "/usr/bin/env bun";

mkdirSync(dataDirectory, { recursive: true });

// 1. 生成 opencode 全局插件 loader（跨平台，re-export 到项目实际的 plugin 文件）
const pluginSource = resolve(project, "plugin/opencode-memory.ts");
const pluginLoaderDirectory = resolve(homedir(), ".config/opencode/plugins");
const pluginLoader = resolve(pluginLoaderDirectory, "opencode-memory.ts");
mkdirSync(pluginLoaderDirectory, { recursive: true });
writeFileSync(pluginLoader, `export { OpencodeMemory } from ${JSON.stringify(pluginSource)};\n`);
console.log(`plugin loader -> ${pluginLoader}`);

// 2. 按平台安装 daemon 自启动
if (process.platform === "darwin") {
  installLaunchd();
} else if (process.platform === "linux") {
  installSystemd();
} else {
  console.warn(`unsupported platform "${process.platform}"; start the daemon manually with "bun run start"`);
}

function renderTemplate(path: string): string {
  return readFileSync(path, "utf8")
    .replaceAll("__BUN__", bunPath)
    .replaceAll("__PROJECT_DIR__", project)
    .replaceAll("__DATA_DIR__", dataDirectory);
}

function installLaunchd(): void {
  const source = resolve(project, "support/io.opencode.memory.plist");
  const targetDirectory = resolve(homedir(), "Library/LaunchAgents");
  const target = resolve(targetDirectory, "io.opencode.memory.plist");
  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(target, renderTemplate(source));
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
}

function installSystemd(): void {
  const source = resolve(project, "support/opencode-memory.service");
  const targetDirectory = resolve(homedir(), ".config/systemd/user");
  const target = resolve(targetDirectory, "opencode-memory.service");
  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(target, renderTemplate(source));

  const reload = Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
  if (reload.exitCode !== 0) console.warn(reload.stderr.toString().trim());
  const enable = Bun.spawnSync(["systemctl", "--user", "enable", "--now", "opencode-memory"]);
  if (enable.exitCode !== 0) {
    console.warn(enable.stderr.toString().trim());
    console.warn(`systemd enable failed; start manually with: systemctl --user start opencode-memory`);
    console.log(`installed systemd user unit at ${target} (not started)`);
    return;
  }
  console.log("installed and started systemd user unit opencode-memory");
  console.log("dashboard: http://127.0.0.1:37780");
}
