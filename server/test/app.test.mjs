// End-to-end over a real node:http server with an in-memory database, a
// canned verifier, fake Stripe, and a notifier that records what it sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db.mjs";
import { createApp } from "../src/app.mjs";
import { signPayload, verifyStripeSignature } from "../src/stripe.mjs";
import { createBuckets } from "../src/ratelimit.mjs";
import { isDisposableDomain } from "../src/disposable.mjs";
import { parseAddress } from "mxprobe-core";

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

const canned = (email, verdict = "OK", extra = {}) => ({
  email,
  action: { OK: "send", WEAK: "hold", DEAD: "kill" }[verdict],
  verdict,
  reason: `canned ${verdict}`,
  checks: { syntax: true, mx: "mx.good.test", smtp: "accepted", catch_all: false, ...extra },
});
const syntaxKill = (email, error) => ({ email, action: "kill", verdict: "DEAD", reason: error, checks: { syntax: false, mx: null, smtp: "skipped", catch_all: null } });
const fakeVerifier = (map = {}) => ({
  verifyBatch: async (emails) =>
    emails.map((e) => {
      const p = parseAddress(e);
      return p.error ? syntaxKill(e, p.error) : (map[e] ?? canned(e));
    }),
});

function fakeNotifier() {
  const sent = { emails: [], telegrams: [] };
  return {
    configured: { telegram: true, email: true },
    sent,
    email: async (m) => (sent.emails.push(m), true),
    telegram: async (t) => (sent.telegrams.push(t), true),
  };
}

function fakeStripeFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" }) };
  };
  return { fetchImpl, calls };
}

const quiet = { info() {}, error() {} };

async function boot(config = {}, deps = {}) {
  const db = openDb(":memory:");
  const notifier = fakeNotifier();
  const stripe = fakeStripeFetch();
  const app = createApp({
    db,
    verifier: deps.verifier ?? fakeVerifier(),
    notifier,
    fetchImpl: stripe.fetchImpl,
    log: quiet,
    config: { resolver, signupsPerDayPerIp: 10, stripeSecretKey: "sk_test_x", stripePriceId: "price_x", stripeWebhookSecret: "whsec_test", ...config },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const bearer = (key) => ({ authorization: `Bearer ${key}` });
  const close = () => new Promise((r) => server.close(r));
  return { db, notifier, stripe, api, bearer, close, base };
}

test("GET / lists the endpoints and the price", async () => {
  const t = await boot();
  try {
    const r = await t.api("GET", "/");
    assert.equal(r.status, 200);
    assert.match(r.body.pricing, /9 USD per 10,000/);
    assert.ok(r.body.endpoints["POST /v1/verify"]);
  } finally {
    await t.close();
  }
});

test("signup: the happy path mails the key and grants 100 credits", async () => {
  const t = await boot();
  try {
    const r = await t.api("POST", "/v1/signup", { email: "Ops@Good.test" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.api_key, /^mxp_[0-9a-f]{32}$/);
    assert.equal(r.body.credits, 100);
    assert.equal(r.body.email, "ops@good.test");
    assert.equal(r.body.mailed, true);
    assert.equal(t.notifier.sent.emails.length, 1);
    assert.equal(t.notifier.sent.emails[0].to, "ops@good.test");
    assert.ok(t.notifier.sent.emails[0].text.includes(r.body.api_key));
    assert.match(t.notifier.sent.telegrams[0], /signup ops@good.test/);
    // the key is stored hashed
    const row = t.db.keyByEmail("ops@good.test");
    assert.notEqual(row.key_hash, r.body.api_key);
    assert.equal(row.key_prefix, r.body.api_key.slice(0, 12));

    const dup = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "already_registered");
  } finally {
    await t.close();
  }
});

test("signup: refuses junk, disposable and undeliverable addresses", async () => {
  const t = await boot();
  try {
    assert.equal((await t.api("POST", "/v1/signup", { email: "nope" })).status, 400);
    assert.equal((await t.api("POST", "/v1/signup", "not json")).status, 400);
    const d = await t.api("POST", "/v1/signup", { email: "x@mailinator.com" });
    assert.equal(d.status, 422);
    assert.equal(d.body.error, "disposable_domain");
    const dead = await t.api("POST", "/v1/signup", { email: "x@dead.test" });
    assert.equal(dead.status, 422);
    assert.equal(dead.body.error, "undeliverable_email");
    assert.match(dead.body.message, /NXDOMAIN/);
  } finally {
    await t.close();
  }
});

test("signup: at most N a day per IP", async () => {
  const t = await boot({ signupsPerDayPerIp: 2 });
  try {
    assert.equal((await t.api("POST", "/v1/signup", { email: "a@good.test" })).status, 201);
    assert.equal((await t.api("POST", "/v1/signup", { email: "b@good.test" })).status, 201);
    const third = await t.api("POST", "/v1/signup", { email: "c@good.test" });
    assert.equal(third.status, 429);
    assert.equal(third.body.error, "too_many_signups");
  } finally {
    await t.close();
  }
});

test("verify: auth, charging, refunds, balance", async () => {
  const verifier = fakeVerifier({
    "gone@good.test": canned("gone@good.test", "DEAD", { smtp: "rejected", catch_all: null }),
    "far@good.test": canned("far@good.test", "WEAK", { smtp: "unreachable", catch_all: null }),
  });
  const t = await boot({}, { verifier });
  try {
    assert.equal((await t.api("POST", "/v1/verify", { emails: ["a@good.test"] })).status, 401);
    assert.equal((await t.api("POST", "/v1/verify", { emails: ["a@good.test"] }, t.bearer("mxp_nope"))).status, 401);

    const { body: s } = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    const h = t.bearer(s.api_key);

    const r = await t.api("POST", "/v1/verify", { emails: ["alice@good.test", "gone@good.test", "not-an-address", "far@good.test", "alice@good.test"] }, h);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results.length, 4, "deduped");
    assert.deepEqual(r.body.results.map((x) => x.action), ["send", "kill", "kill", "hold"]);
    assert.deepEqual(r.body.summary, { send: 1, hold: 1, kill: 2, total: 4 });
    // 3 valid addresses charged, 1 unreachable refunded
    assert.equal(r.body.credits_used, 2);
    assert.equal(r.body.credits_left, 98);

    const single = await t.api("POST", "/v1/verify", { email: "bob@good.test" }, h);
    assert.equal(single.status, 200);
    assert.equal(single.body.credits_left, 97);

    const b = await t.api("GET", "/v1/balance", undefined, h);
    assert.equal(b.status, 200);
    assert.equal(b.body.credits, 97);
    assert.equal(b.body.checks_total, 4);
    assert.equal(b.body.email, "ops@good.test");

    assert.equal((await t.api("POST", "/v1/verify", {}, h)).status, 400);
    assert.equal((await t.api("POST", "/v1/verify", { emails: Array.from({ length: 101 }, (_, i) => `u${i}@good.test`) }, h)).status, 400);
    assert.equal((await t.api("POST", "/v1/verify", { emails: [1] }, h)).status, 400);

    // the log holds the addresses for 24 hours and no longer
    assert.equal(t.db.raw.prepare("SELECT COUNT(*) AS n FROM verify_log").get().n, 5);
    assert.equal(t.db.purgeLog(new Date(Date.now() + 1000).toISOString()), 5);
    const mix = t.db.stats().verdict_mix;
    assert.equal(mix.checks, 5);
  } finally {
    await t.close();
  }
});

test("verify: 402 when the key runs dry, with the checkout hint", async () => {
  const t = await boot();
  try {
    const { body: s } = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    const h = t.bearer(s.api_key);
    t.db.raw.prepare("UPDATE keys SET credits = 1").run();
    const r = await t.api("POST", "/v1/verify", { emails: ["a@good.test", "b@good.test"] }, h);
    assert.equal(r.status, 402);
    assert.equal(r.body.error, "insufficient_credits");
    assert.equal(r.body.credits_left, 1);
    assert.equal(r.body.needed, 2);
    assert.match(r.body.checkout_hint, /credits\/checkout/);
    // the failed call charged nothing
    assert.equal(t.db.keyByEmail("ops@good.test").credits, 1);
  } finally {
    await t.close();
  }
});

test("verify: 60 checks a minute per key", async () => {
  const t = await boot({ checksPerMinute: 5 });
  try {
    const { body: s } = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    const h = t.bearer(s.api_key);
    assert.equal((await t.api("POST", "/v1/verify", { emails: ["a@good.test", "b@good.test", "c@good.test"] }, h)).status, 200);
    const r = await t.api("POST", "/v1/verify", { emails: ["d@good.test", "e@good.test", "f@good.test"] }, h);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "rate_limited");
    assert.ok(r.headers.get("retry-after"));
    assert.equal(t.db.keyByEmail("ops@good.test").credits, 97, "the refused call was not charged");
  } finally {
    await t.close();
  }
});

test("revoked key is 403", async () => {
  const t = await boot();
  try {
    const { body: s } = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    assert.equal(t.db.setRevoked("ops@good.test", true), true);
    const r = await t.api("GET", "/v1/balance", undefined, t.bearer(s.api_key));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "key_revoked");
  } finally {
    await t.close();
  }
});

test("checkout: creates a Stripe session with the key in the metadata", async () => {
  const t = await boot();
  try {
    const { body: s } = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    const h = t.bearer(s.api_key);
    const r = await t.api("POST", "/v1/credits/checkout", { packs: 2 }, h);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_test_123");
    assert.equal(r.body.credits, 20000);
    assert.equal(r.body.amount_usd, 18);
    const form = t.stripe.calls[0].body;
    assert.equal(t.stripe.calls[0].url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(form.get("mode"), "payment");
    assert.equal(form.get("line_items[0][price]"), "price_x");
    assert.equal(form.get("line_items[0][quantity]"), "2");
    assert.equal(form.get("metadata[key_id]"), String(t.db.keyByEmail("ops@good.test").id));
    assert.equal(form.get("metadata[packs]"), "2");
    assert.equal(form.get("customer_email"), "ops@good.test");
    assert.equal(form.get("payment_method_types[0]"), "card");
    assert.equal(form.get("success_url"), "https://mxprobe.dev/paid");
  } finally {
    await t.close();
  }
});

test("checkout: 503 until Stripe is configured", async () => {
  const t = await boot({ stripeSecretKey: null });
  try {
    const { body: s } = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    const r = await t.api("POST", "/v1/credits/checkout", {}, t.bearer(s.api_key));
    assert.equal(r.status, 503);
  } finally {
    await t.close();
  }
});

test("webhook: a signed paid session adds credits once", async () => {
  const t = await boot();
  try {
    const { body: s } = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    const keyId = t.db.keyByEmail("ops@good.test").id;
    const event = {
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_status: "paid", amount_total: 1800, currency: "usd", client_reference_id: String(keyId), metadata: { key_id: String(keyId), packs: "2" } } },
    };
    const raw = JSON.stringify(event);

    const bad = await t.api("POST", "/v1/stripe/webhook", raw, { "stripe-signature": "t=1,v1=deadbeef" });
    assert.equal(bad.status, 400);
    const unsigned = await t.api("POST", "/v1/stripe/webhook", raw, {});
    assert.equal(unsigned.status, 400);

    const ok = await t.api("POST", "/v1/stripe/webhook", raw, { "stripe-signature": signPayload(raw, "whsec_test") });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(t.db.keyByEmail("ops@good.test").credits, 20100);
    assert.match(t.notifier.sent.telegrams.at(-1), /PAID 18.00 USD by ops@good.test: \+20,000/);
    assert.match(t.notifier.sent.emails.at(-1).subject, /20,000 checks added/);

    const again = await t.api("POST", "/v1/stripe/webhook", raw, { "stripe-signature": signPayload(raw, "whsec_test") });
    assert.equal(again.body.duplicate, true);
    assert.equal(t.db.keyByEmail("ops@good.test").credits, 20100, "no double credit");

    // a zero-total session (100% promotion) counts as paid
    const free = JSON.stringify({ ...event, id: "evt_free", data: { object: { ...event.data.object, id: "cs_free", payment_status: "no_payment_required", amount_total: 0, metadata: { key_id: String(keyId), packs: "1" } } } });
    assert.equal((await t.api("POST", "/v1/stripe/webhook", free, { "stripe-signature": signPayload(free, "whsec_test") })).status, 200);
    assert.equal(t.db.keyByEmail("ops@good.test").credits, 30100);

    // an unpaid session is acknowledged and ignored
    const unpaid = JSON.stringify({ ...event, id: "evt_2", data: { object: { ...event.data.object, payment_status: "unpaid" } } });
    assert.equal((await t.api("POST", "/v1/stripe/webhook", unpaid, { "stripe-signature": signPayload(unpaid, "whsec_test") })).status, 200);
    assert.equal(t.db.keyByEmail("ops@good.test").credits, 30100);

    // a paid session for an unknown key is a 500 and the event is released for Stripe's retry
    const ghost = JSON.stringify({ ...event, id: "evt_3", data: { object: { ...event.data.object, metadata: { key_id: "999", packs: "1" } } } });
    assert.equal((await t.api("POST", "/v1/stripe/webhook", ghost, { "stripe-signature": signPayload(ghost, "whsec_test") })).status, 500);
    assert.equal(t.db.claimStripeEvent("evt_3", "x"), true, "released");

    const st = t.db.stats();
    assert.equal(st.paying_keys, 1);
    assert.equal(st.purchases, 2);
    assert.equal(s.credits, 100);
  } finally {
    await t.close();
  }
});

test("subscribe and feedback ping Telegram", async () => {
  const t = await boot();
  try {
    assert.equal((await t.api("POST", "/v1/subscribe", { email: "fan@good.test" })).status, 200);
    assert.equal((await t.api("POST", "/v1/subscribe", { email: "fan@good.test" })).status, 200);
    assert.equal((await t.api("POST", "/v1/subscribe", { email: "junk" })).status, 400);
    assert.equal(t.notifier.sent.telegrams.filter((x) => /subscriber/.test(x)).length, 1, "one ping per new subscriber");
    assert.equal((await t.api("POST", "/v1/feedback", { message: "  " })).status, 400);
    assert.equal((await t.api("POST", "/v1/feedback", { email: "fan@good.test", message: "add CSV" })).status, 200);
    assert.match(t.notifier.sent.telegrams.at(-1), /feedback from fan@good.test:\nadd CSV/);
    assert.equal(t.db.stats().subscribers, 1);
    assert.equal(t.db.stats().feedback, 1);
  } finally {
    await t.close();
  }
});

test("health, 404, CORS preflight", async () => {
  const t = await boot();
  try {
    const h = await t.api("GET", "/v1/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.equal(h.body.payments, true);
    assert.equal((await t.api("GET", "/nope")).status, 404);
    const pre = await fetch(`${t.base}/v1/subscribe`, { method: "OPTIONS", headers: { origin: "https://mxprobe.dev" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  } finally {
    await t.close();
  }
});

test("stripe signature: tolerance and constant-time compare", () => {
  const raw = '{"id":"evt"}';
  const sig = signPayload(raw, "s", 1000);
  assert.equal(verifyStripeSignature(raw, sig, "s", { nowSec: 1100 }), true);
  assert.equal(verifyStripeSignature(raw, sig, "s", { nowSec: 2000 }), false, "too old");
  assert.equal(verifyStripeSignature(raw, sig, "other", { nowSec: 1100 }), false);
  assert.equal(verifyStripeSignature(raw + " ", sig, "s", { nowSec: 1100 }), false);
  assert.equal(verifyStripeSignature(raw, "", "s"), false);
});

test("token bucket refills", () => {
  let t = 0;
  const b = createBuckets({ capacity: 3, refillPerSec: 1, now: () => t });
  assert.equal(b.take("k", 3).ok, true);
  assert.equal(b.take("k", 1).ok, false);
  t = 2000;
  assert.equal(b.take("k", 2).ok, true);
  assert.equal(b.take("k", 1).ok, false);
});

test("disposable list matches subdomains", () => {
  assert.equal(isDisposableDomain("mailinator.com"), true);
  assert.equal(isDisposableDomain("x.yopmail.com"), true);
  assert.equal(isDisposableDomain("gmail.com"), false);
});
