import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotifier, purchaseEmail, signupEmail } from "../src/notify.ts";
import type { FetchLike, FetchResponseLike } from "../src/types.ts";
import { jsonResponse } from "./helpers.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(reply: FetchResponseLike | Error = jsonResponse(200, { ok: true })) {
  const calls: Call[] = [];
  const logged: unknown[][] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body ?? "null") });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const log = { info: () => {}, error: (...args: unknown[]) => void logged.push(args) };
  return { fetchImpl, calls, log, logged };
}

const configured = { TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42", RESEND_API_KEY: "re_x" };

test("notifier: unconfigured channels are silent no-ops", async () => {
  const r = recorder();
  const n = createNotifier({}, { fetchImpl: r.fetchImpl, log: r.log });
  assert.deepEqual(n.configured, { telegram: false, email: false });
  assert.equal(await n.telegram("hi"), false);
  assert.equal(await n.email({ to: "a@b.co", subject: "s", text: "t" }), false);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(createNotifier({ TELEGRAM_BOT_TOKEN: "tok" }).configured, { telegram: false, email: false }, "a token without a chat id is not configured");
});

test("notifier: telegram posts to the bot API with the prefix", async () => {
  const r = recorder();
  const n = createNotifier(configured, { fetchImpl: r.fetchImpl, log: r.log });
  assert.deepEqual(n.configured, { telegram: true, email: true });
  assert.equal(await n.telegram("signup a@b.co"), true);
  assert.equal(r.calls[0]?.url, "https://api.telegram.org/bottok/sendMessage");
  assert.deepEqual(r.calls[0]?.body, { chat_id: "42", text: "[mxprobe] signup a@b.co", disable_web_page_preview: true });
  const custom = createNotifier({ ...configured, TELEGRAM_PREFIX: "[dev]" }, { fetchImpl: r.fetchImpl, log: r.log });
  await custom.telegram("x");
  assert.equal((r.calls[1]?.body as { text: string }).text, "[dev] x");
});

test("notifier: email posts to Resend with from, to, subject, text and reply_to", async () => {
  const r = recorder();
  const n = createNotifier({ ...configured, EMAIL_FROM: "Me <me@mxprobe.dev>" }, { fetchImpl: r.fetchImpl, log: r.log });
  assert.equal(await n.email({ to: "a@b.co", subject: "s", text: "t", replyTo: "hello@mxprobe.dev" }), true);
  assert.equal(r.calls[0]?.url, "https://api.resend.com/emails");
  assert.equal(r.calls[0]?.headers["authorization"], "Bearer re_x");
  assert.deepEqual(r.calls[0]?.body, { from: "Me <me@mxprobe.dev>", to: ["a@b.co"], subject: "s", text: "t", reply_to: "hello@mxprobe.dev" });
  await n.email({ to: "a@b.co", subject: "s", text: "t" });
  assert.equal("reply_to" in (r.calls[1]?.body as object), false);
  const defaultFrom = recorder();
  await createNotifier(configured, { fetchImpl: defaultFrom.fetchImpl, log: defaultFrom.log }).email({ to: "a@b.co", subject: "s", text: "t" });
  assert.equal((defaultFrom.calls[0]?.body as { from: string }).from, "MX Probe <hello@mxprobe.dev>");
});

test("notifier: an HTTP failure or a thrown fetch returns false and is logged, never thrown", async () => {
  const http = recorder(jsonResponse(500, { message: "boom" }));
  const n1 = createNotifier(configured, { fetchImpl: http.fetchImpl, log: http.log });
  assert.equal(await n1.telegram("x"), false);
  assert.equal(await n1.email({ to: "a@b.co", subject: "s", text: "t" }), false);
  assert.equal(http.logged.length, 2);
  assert.deepEqual(http.logged[0], ["[notify] telegram", 500, '{"message":"boom"}']);
  assert.deepEqual(http.logged[1], ["[notify] resend", 500, '{"message":"boom"}']);

  const thrown = recorder(new Error("ECONNRESET"));
  const n2 = createNotifier(configured, { fetchImpl: thrown.fetchImpl, log: thrown.log });
  assert.equal(await n2.telegram("x"), false);
  assert.equal(await n2.email({ to: "a@b.co", subject: "s", text: "t" }), false);
  assert.deepEqual(thrown.logged, [
    ["[notify] telegram failed:", "ECONNRESET"],
    ["[notify] resend failed:", "ECONNRESET"],
  ]);
});

test("signupEmail and purchaseEmail carry the key, the numbers and the URLs", () => {
  const s = signupEmail({ key: "mxp_abc", credits: 100, apiUrl: "https://api.test", siteUrl: "https://site.test" });
  assert.equal(s.subject, "Your MX Probe API key");
  assert.match(s.text, /\n {2}mxp_abc\n/);
  assert.match(s.text, /100 free checks/);
  assert.match(s.text, /curl https:\/\/api\.test\/v1\/verify/);
  assert.match(s.text, /Bearer mxp_abc/);
  assert.match(s.text, /Docs: https:\/\/site\.test/);
  const p = purchaseEmail({ credits: 20000, total: 20100, apiUrl: "https://api.test" });
  assert.equal(p.subject, "MX Probe: 20,000 checks added");
  assert.match(p.text, /20,000 checks were added to your key; it now holds 20,100/);
  assert.match(p.text, /GET https:\/\/api\.test\/v1\/balance/);
});
