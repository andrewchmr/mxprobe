import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_API_URL, readConfig, writeConfig, configPath } from "../src/config.ts";
import { freshEnv } from "./helpers.ts";

test("config: env wins, file is written 0600 under XDG_CONFIG_HOME", () => {
  const env = freshEnv();
  assert.equal(readConfig(env).apiKey, null);
  assert.equal(readConfig(env).apiUrl, "https://api.mxprobe.dev");
  const path = writeConfig({ api_key: "mxp_file", email: "a@b.co" }, env);
  assert.equal(path, configPath(env));
  assert.equal(readConfig(env).apiKey, "mxp_file");
  assert.equal(readConfig(env).email, "a@b.co");
  assert.equal(readConfig({ ...env, MXPROBE_API_KEY: "mxp_env" }).apiKey, "mxp_env");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).email, "a@b.co");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("config: configPath prefers XDG_CONFIG_HOME, then HOME/.config", () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" }), join("/x", "mxprobe", "config.json"));
  assert.equal(configPath({ HOME: "/h" }), join("/h", ".config", "mxprobe", "config.json"));
});

test("config: the API URL comes from the env, then the file, then the default, without a trailing slash", () => {
  const env = freshEnv();
  assert.equal(readConfig(env).apiUrl, DEFAULT_API_URL);
  writeConfig({ api_url: "https://file.test/" }, env);
  assert.equal(readConfig(env).apiUrl, "https://file.test");
  assert.equal(readConfig({ ...env, MXPROBE_API_URL: "https://env.test/" }).apiUrl, "https://env.test");
});

test("config: writeConfig merges into the existing file and keeps unknown fields", () => {
  const env = freshEnv();
  writeConfig({ api_key: "one", email: "a@b.co" }, env);
  const path = writeConfig({ api_key: "two" }, env);
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(file, { api_key: "two", email: "a@b.co" });
  writeFileSync(path, JSON.stringify({ ...file, note: "keep me" }));
  writeConfig({ email: "c@d.co" }, env);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { api_key: "two", email: "c@d.co", note: "keep me" });
});

test("config: a corrupt or non-object file reads as empty", () => {
  const env = freshEnv();
  const path = configPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{not json");
  assert.deepEqual(readConfig(env), { apiKey: null, apiUrl: DEFAULT_API_URL, email: null });
  writeFileSync(path, "[1,2]");
  assert.deepEqual(readConfig(env), { apiKey: null, apiUrl: DEFAULT_API_URL, email: null });
  writeConfig({ api_key: "k" }, env);
  assert.equal(readConfig(env).apiKey, "k", "a corrupt file is replaced, not appended to");
});
