import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { readConfig } from "../src/config.ts";
import { capture, fakeFetch, freshEnv, hostedResult, resolver, type Canned } from "./helpers.ts";

const run = (argv: string[], env = freshEnv(), canned: Canned = {}) => {
  const c = capture();
  const f = fakeFetch(canned);
  return main(argv, { ...c, env, fetchImpl: f.fetchImpl, verifierOptions: { resolver } }).then((code) => ({ code, ...c.out, calls: f.calls }));
};

test("cli: version, help, usage errors, a syntax kill exits 1", async () => {
  const env = freshEnv();
  let r = await run(["--version"], env);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(r.code, 0);
  r = await run([], env);
  assert.match(r.stdout, /mxprobe check <email>/);
  assert.equal(r.code, 0);
  assert.match((await run(["-h"], env)).stdout, /Usage/);
  assert.match((await run(["help"], env)).stdout, /Usage/);
  r = await run(["check"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: mxprobe check/);
  r = await run(["bogus"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command "bogus"/);
  r = await run(["check", "junk"], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^kill DEAD junk\s+not an email address/);
  assert.match(r.stderr, /1 checked: 0 send, 0 hold, 1 kill\. DNS tier only/);
  r = await run(["check", "--json", "junk"], env);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).results[0].action, "kill");
  r = await run(["balance"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401: No API key/);
  assert.equal(r.calls.length, 0);
});

test("cli: check prints one aligned line per address; a kill among several exits 0", async () => {
  const r = await run(["check", "a@good.test", "x@dead.test"]);
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^send OK {3}a@good.test {2}MX mx.good.test; mailbox not probed$/);
  assert.match(lines[1] ?? "", /^kill DEAD x@dead.test {2}domain does not exist/);
  assert.match(r.stderr, /2 checked: 1 send, 0 hold, 1 kill/);
});

test("cli: --file adds one address per line, skipping blanks and comments", async () => {
  const env = freshEnv();
  const list = join(env["HOME"] ?? "", "list.txt");
  writeFileSync(list, "# my list\n\n  b@good.test  \nc@dead.test\n");
  const r = await run(["check", "--json", "a@good.test", "--file", list], env);
  assert.equal(r.code, 0);
  assert.deepEqual(
    JSON.parse(r.stdout).results.map((x: { email: string }) => x.email),
    ["a@good.test", "b@good.test", "c@dead.test"],
  );
});

test("cli: --hosted sends the survivors to the API with the key and reports the credits", async () => {
  const env = freshEnv({ MXPROBE_API_KEY: "mxp_env" });
  const r = await run(["check", "--hosted", "a@good.test", "x@dead.test", "b@good.test"], env, {
    "POST /v1/verify": (call) => {
      const emails = (call.body as { emails: string[] }).emails;
      return { body: { results: emails.map((e) => hostedResult(e, e.startsWith("b") ? "DEAD" : "OK")), summary: {}, credits_used: emails.length, credits_left: 7 } };
    },
  });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]?.url, "https://api.mxprobe.dev/v1/verify");
  assert.equal(r.calls[0]?.headers["authorization"], "Bearer mxp_env");
  assert.deepEqual(r.calls[0]?.body, { emails: ["a@good.test", "b@good.test"] });
  assert.match(r.stdout, /^send OK {3}a@good.test {2}hosted says OK\n/);
  assert.match(r.stdout, /\nkill DEAD b@good.test {2}hosted says DEAD\n/);
  assert.match(r.stderr, /3 checked: 1 send, 0 hold, 2 kill; 2 probed on the hosted tier, 7 credits left/);
});

test("cli: --api-url overrides the base for this run", async () => {
  const env = freshEnv({ MXPROBE_API_KEY: "mxp_env" });
  const r = await run(["balance", "--api-url", "http://localhost:8787/"], env, { "GET /v1/balance": { body: { email: "a@b.co", credits: 3, checks_total: 97, created_at: "" } } });
  assert.equal(r.code, 0);
  assert.equal(r.calls[0]?.url, "http://localhost:8787/v1/balance");
  assert.equal(r.stdout, "3 credits left on the key for a@b.co (97 checks so far)\n");
});

test("cli: signup saves the key and the api url to the config file", async () => {
  const env = freshEnv();
  assert.equal((await run(["signup"], env)).code, 2);
  const r = await run(["signup", "Ops@Good.test", "--api-url", "https://api.test"], env, {
    "POST /v1/signup": { status: 201, body: { api_key: "mxp_new", email: "ops@good.test", credits: 100, mailed: true, message: "m" } },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls[0]?.body, { email: "Ops@Good.test" });
  assert.match(r.stdout, /^Key saved to .*config\.json\. 100 free checks on it\. The key was also mailed to ops@good\.test\.\n$/);
  assert.deepEqual(readConfig(env), { apiKey: "mxp_new", apiUrl: "https://api.test", email: "ops@good.test" });
});

test("cli: balance --json and buy --packs", async () => {
  const env = freshEnv({ MXPROBE_API_KEY: "mxp_env" });
  const balance = { email: "a@b.co", credits: 3, checks_total: 97, created_at: "2026-09-09T00:00:00Z" };
  let r = await run(["balance", "--json"], env, { "GET /v1/balance": { body: balance } });
  assert.deepEqual(JSON.parse(r.stdout), balance);
  const checkout = { url: "https://checkout.stripe.com/c/pay/cs_1", credits: 30000, amount_usd: 27, packs: 3, session_id: "cs_1", message: "" };
  r = await run(["buy", "--packs", "3"], env, { "POST /v1/credits/checkout": { body: checkout } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls[0]?.body, { packs: 3 });
  assert.match(r.stdout, /^Pay 27 USD for 30000 checks here:\nhttps:\/\/checkout\.stripe\.com\/c\/pay\/cs_1\n/);
  r = await run(["buy", "--packs", "zero", "--json"], env, { "POST /v1/credits/checkout": { body: checkout } });
  assert.deepEqual(r.calls[0]?.body, { packs: 1 }, "a bad --packs falls back to 1");
  assert.deepEqual(JSON.parse(r.stdout), checkout);
});

test("cli: an API error prints status and message; a 402 adds the checkout hint", async () => {
  const env = freshEnv({ MXPROBE_API_KEY: "mxp_env" });
  const r = await run(["check", "--hosted", "a@good.test"], env, {
    "POST /v1/verify": { status: 402, body: { error: "insufficient_credits", message: "This call needs 1 credits and the key has 0.", checkout_hint: "POST /v1/credits/checkout returns a payment link" } },
  });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "402: This call needs 1 credits and the key has 0.\nPOST /v1/credits/checkout returns a payment link\n");
  const revoked = await run(["balance"], env, { "GET /v1/balance": { status: 403, body: { error: "key_revoked", message: "This key was revoked." } } });
  assert.equal(revoked.code, 1);
  assert.equal(revoked.stderr, "403: This key was revoked.\n");
});

test("cli: errors that are not API errors propagate", async () => {
  const env = freshEnv();
  await assert.rejects(main(["check", "--file", join(env["HOME"] ?? "", "missing.txt")], { ...capture(), env }), /ENOENT/);
});
