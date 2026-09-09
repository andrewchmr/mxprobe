// Where the API key lives: MXPROBE_API_KEY in the environment wins, then
// ~/.config/mxprobe/config.json (written by `mxprobe signup`).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.mxprobe.dev";

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "mxprobe", "config.json");
}

export function readConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch {
    /* no file yet */
  }
  return {
    apiKey: env.MXPROBE_API_KEY || file.api_key || null,
    apiUrl: (env.MXPROBE_API_URL || file.api_url || DEFAULT_API_URL).replace(/\/$/, ""),
    email: file.email || null,
  };
}

export function writeConfig(patch, env = process.env) {
  const path = configPath(env);
  let file = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* new file */
  }
  const next = { ...file, ...patch };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return path;
}
