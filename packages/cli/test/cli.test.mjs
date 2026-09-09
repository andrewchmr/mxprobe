import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEmails, createClient, ApiError } from "../src/client.mjs";
import { readConfig, writeConfig, configPath } from "../src/config.mjs";
import { main } from "../src/cli.mjs";

const nx = (code) => Object.assign(new Error(code), { code });
const resolver = {
  async resolveMx(d) {
    if (d === "dead.test") throw nx("ENOTFOUND");
    return [{ exchange: "mx.good.test", priority: 10 }];
  },
  async resolve4(h) {
    if (h === "mx.good.test") return ["192.0.2.1"];
    throw nx("ENODATA");
  },
  async resolve6() {
    throw nx("ENODATA");
  },
  async reverse() {
    throw nx("ENOTFOUND");
  },
};

function capture() {
  const out = { stdout: "", stderr: "" };
  return { out, stdout: { write: (s) => (out.stdout += s) }, stderr: { write: (s) => (out.stderr += s) } };
}

test("checkEmails: DNS kills stay local, survivors go to the hosted probe", async () => {
  const sent = [];
  const client = {
    verify: async (emails) => {
      sent.push(emails);
      return {
        results: emails.map((email) => ({ email, action: "kill", verdict: "DEAD", reason: "hosted says no", checks: { syntax: true, mx: "mx.good.test", smtp: "rejected", catch_all: null } })),
        credits_left: 42,
      };
    },
  };
  const out = await checkEmails(["a@good.test", "x@dead.test", "junk"], { hosted: true, client, verifierOptions: { resolver } });
  assert.deepEqual(sent, [["a@good.test"]]);
  assert.deepEqual(out.results.map((r) => r.reason), ["hosted says no", "domain does not exist (NXDOMAIN)", "not an email address"]);
  assert.equal(out.hosted, 1);
  assert.equal(out.credits_left, 42);
  assert.deepEqual(out.summary, { send: 0, hold: 0, kill: 3, total: 3 });
});

test("checkEmails: without hosted nothing leaves the machine", async () => {
  const out = await checkEmails(["a@good.test"], { hosted: false, client: null, verifierOptions: { resolver } });
  assert.equal(out.results[0].action, "send");
  assert.equal(out.results[0].checks.smtp, "skipped");
  assert.equal(out.hosted, 0);
});

test("createClient: bearer header, JSON errors become ApiError, no key is 401 before any request", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: false, status: 402, text: async () => JSON.stringify({ error: "insufficient_credits", message: "dry" }) };
  };
  const c = createClient({ apiUrl: "https://api.test/", apiKey: "mxp_k", fetchImpl });
  await assert.rejects(c.verify(["a@b.co"]), (e) => e instanceof ApiError && e.status === 402 && e.message === "dry");
  assert.equal(calls[0].url, "https://api.test/v1/verify");
  assert.equal(calls[0].init.headers.authorization, "Bearer mxp_k");
  const noKey = createClient({ apiUrl: "https://api.test", apiKey: null, fetchImpl });
  await assert.rejects(noKey.balance(), (e) => e.status === 401);
  assert.equal(calls.length, 1, "no request without a key");
});

test("config: env wins, file is written 0600 under XDG_CONFIG_HOME", () => {
  const dir = mkdtempSync(join(tmpdir(), "mxprobe-"));
  const env = { XDG_CONFIG_HOME: dir, HOME: dir };
  assert.equal(readConfig(env).apiKey, null);
  assert.equal(readConfig(env).apiUrl, "https://api.mxprobe.dev");
  const path = writeConfig({ api_key: "mxp_file", email: "a@b.co" }, env);
  assert.equal(path, configPath(env));
  assert.equal(readConfig(env).apiKey, "mxp_file");
  assert.equal(readConfig({ ...env, MXPROBE_API_KEY: "mxp_env" }).apiKey, "mxp_env");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).email, "a@b.co");
});

test("cli: version, help, usage errors, a syntax kill exits 1", async () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "mxprobe-")) };
  let c = capture();
  await main(["--version"], { ...c, env });
  assert.match(c.out.stdout, /^\d+\.\d+\.\d+\n$/);
  c = capture();
  await main([], { ...c, env });
  assert.match(c.out.stdout, /mxprobe check <email>/);
  c = capture();
  assert.equal(await main(["check"], { ...c, env }), 2);
  c = capture();
  assert.equal(await main(["bogus"], { ...c, env }), 2);
  c = capture();
  assert.equal(await main(["check", "junk"], { ...c, env }), 1);
  assert.match(c.out.stdout, /^kill DEAD junk\s+not an email address/);
  c = capture();
  assert.equal(await main(["check", "--json", "junk"], { ...c, env }), 1);
  assert.equal(JSON.parse(c.out.stdout).results[0].action, "kill");
  c = capture();
  assert.equal(await main(["balance"], { ...c, env }), 1);
  assert.match(c.out.stderr, /401: No API key/);
});
