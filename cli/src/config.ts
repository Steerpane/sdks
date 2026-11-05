import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredConfig {
  token?: string;
  api_url?: string;
}

/** `STEERPANE_CONFIG_DIR` overrides the place, mainly for tests. */
export function configPath(): string {
  const base = process.env["STEERPANE_CONFIG_DIR"]
    ?? (process.platform === "win32" ? join(process.env["APPDATA"] ?? homedir(), "steerpane") : join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "steerpane"));
  return join(base, "config.json");
}

export function readConfig(): StoredConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredConfig;
  } catch {
    throw new Error(`${path} is not valid JSON. Delete it and log in again.`);
  }
}

/** Owner-only on POSIX. On Windows the file sits in the user's profile, whose permissions already keep other users out. */
export function writeConfig(config: StoredConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function deleteConfig(): boolean {
  const path = configPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
