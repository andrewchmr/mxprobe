// Where the API key lives: MXPROBE_API_KEY in the environment wins, then
// ~/.config/mxprobe/config.json (written by `mxprobe signup`).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.mxprobe.dev";

/** What the file holds. Every field is optional; unknown fields are kept. */
export interface ConfigFile {
  api_key?: string;
  api_url?: string;
  email?: string;
}

/** The effective config: environment over file over defaults. */
export interface Config {
  apiKey: string | null;
  apiUrl: string;
  email: string | null;
}

export type Env = NodeJS.ProcessEnv;

export function configPath(env: Env = process.env): string {
  const base = env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config");
  return join(base, "mxprobe", "config.json");
}

function readFile(path: string): ConfigFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ConfigFile) : {};
  } catch {
    return {}; // no file yet, or not JSON
  }
}

export function readConfig(env: Env = process.env): Config {
  const file = readFile(configPath(env));
  return {
    apiKey: env["MXPROBE_API_KEY"] || file.api_key || null,
    apiUrl: (env["MXPROBE_API_URL"] || file.api_url || DEFAULT_API_URL).replace(/\/$/, ""),
    email: file.email || null,
  };
}

/** Merge `patch` into the file (mode 0600) and return its path. */
export function writeConfig(patch: ConfigFile, env: Env = process.env): string {
  const path = configPath(env);
  const next: ConfigFile = { ...readFile(path), ...patch };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return path;
}
