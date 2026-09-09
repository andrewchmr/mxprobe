// End-to-end over a real node:http server with an in-memory database, a
// canned verifier, fake Stripe, and a notifier that records what it sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashKey, newApiKey, HttpError, VERSION } from "../src/app.ts";
import { signPayload } from "../src/stripe.ts";
import { boot, canned, fakeVerifier, jsonResponse } from "./helpers.ts";

test("GET / lists the endpoints and the price", async () => {
  const t = await boot();
  try {
    const r = await t.api("GET", "/");
    assert.equal(r.status, 200);
    assert.match(r.body.pricing, /9 USD per 10,000/);
    assert.ok(r.body.endpoints["POST /v1/verify"]);
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal((await t.api("GET", "/v1")).status, 200, "/v1 is the index too");
    assert.equal((await t.api("GET", "/v1/")).status, 200, "trailing slashes are ignored");
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
    assert.match(r.body.message, /shown once and was mailed to you/);
    assert.equal(t.notifier.sent.emails.length, 1);
    assert.equal(t.notifier.sent.emails[0]?.to, "ops@good.test");
    assert.equal(t.notifier.sent.emails[0]?.replyTo, "hello@mxprobe.dev");
    assert.ok(t.notifier.sent.emails[0]?.text.includes(r.body.api_key));
    assert.match(t.notifier.sent.telegrams[0] ?? "", /signup ops@good.test/);
    // the key is stored hashed
    const row = t.db.keyByEmail("ops@good.test");
    assert.ok(row);
    assert.notEqual(row.key_hash, r.body.api_key);
    assert.equal(row.key_hash, hashKey(r.body.api_key));
    assert.equal(row.key_prefix, r.body.api_key.slice(0, 12));
    assert.equal(row.signup_ip, "127.0.0.1");

    const dup = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "already_registered");
    assert.equal((await t.api("POST", "/v1/signup", { email: "OPS@GOOD.TEST" })).status, 409, "case-insensitive");
  } finally {
    await t.close();
  }
});

test("signup: when the key email fails the response says so and Telegram is told", async () => {
  const t = await boot();
  t.notifier.email = async () => false;
  try {
    const r = await t.api("POST", "/v1/signup", { email: "ops@good.test" });
    assert.equal(r.status, 201);
    assert.equal(r.body.mailed, false);
    assert.match(r.body.message, /shown once\. Send it/);
    assert.match(t.notifier.sent.telegrams[0] ?? "", /key email FAILED/);
  } finally {
    await t.close();
  }
});

test("signup: refuses junk, disposable and undeliverable addresses", async () => {
  const t = await boot();
  try {
    assert.equal((await t.api("POST", "/v1/signup", { email: "nope" })).status, 400);
    assert.equal((await t.api("POST", "/v1/signup", {})).status, 400);
    const notJson = await t.api("POST", "/v1/signup", "not json");
    assert.equal(notJson.status, 400);
    assert.equal(notJson.body.error, "invalid_json");
    assert.equal((await t.api("POST", "/v1/signup", "[1]")).status, 400);
    const d = await t.api("POST", "/v1/signup", { email: "x@mailinator.com" });
    assert.equal(d.status, 422);
    assert.equal(d.body.error, "disposable_domain");
    const dead = await t.api("POST", "/v1/signup", { email: "x@dead.test" });
    assert.equal(dead.status, 422);
    assert.equal(dead.body.error, "undeliverable_email");
    assert.match(dead.body.message, /NXDOMAIN/);
    assert.equal(t.db.stats().keys, 0);
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

test("signup: behind a proxy the client IP comes from X-Forwarded-For only when trusted", async () => {
  const trusting = await boot({ signupsPerDayPerIp: 1, trustProxy: true });
  try {
    assert.equal((await trusting.api("POST", "/v1/signup", { email: "a@good.test" }, { "x-forwarded-for": "203.0.113.1, 10.0.0.1" })).status, 201);
    assert.equal((await trusting.api("POST", "/v1/signup", { email: "b@good.test" }, { "x-forwarded-for": "203.0.113.2" })).status, 201, "a different client");
    assert.equal((await trusting.api("POST", "/v1/signup", { email: "c@good.test" }, { "x-forwarded-for": "203.0.113.2" })).status, 429);
    assert.equal(trusting.db.keyByEmail("a@good.test")?.signup_ip, "203.0.113.1");
  } finally {
    await trusting.close();
  }
  const direct = await boot({ signupsPerDayPerIp: 1, trustProxy: false });
  try {
    assert.equal((await direct.api("POST", "/v1/signup", { email: "a@good.test" }, { "x-forwarded-for": "203.0.113.1" })).status, 201);
    assert.equal((await direct.api("POST", "/v1/signup", { email: "b@good.test" }, { "x-forwarded-for": "203.0.113.2" })).status, 429, "the header is ignored");
    assert.equal(direct.db.keyByEmail("a@good.test")?.signup_ip, "127.0.0.1");
  } finally {
    await direct.close();
  }
});

test("verify: auth, charging, refunds, balance", async () => {
  const verifier = fakeVerifier({
    "gone@good.test": canned("gone@good.test", "DEAD", { smtp: "rejected", catch_all: null }),
    "far@good.test": canned("far@good.test", "WEAK", { smtp: "unreachable", catch_all: null }),
  });
  const t = await boot({}, { verifier });
  try {
    const noAuth = await t.api("POST", "/v1/verify", { emails: ["a@good.test"] });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.error, "missing_api_key");
    const badKey = await t.api("POST", "/v1/verify", { emails: ["a@good.test"] }, t.bearer("mxp_nope"));
    assert.equal(badKey.status, 401);
    assert.equal(badKey.body.error, "invalid_api_key");

    const { headers: h, key } = await t.signup();

    const r = await t.api("POST", "/v1/verify", { emails: ["alice@good.test", "gone@good.test", "not-an-address", "far@good.test", " alice@good.test "] }, h);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results.length, 4, "deduped after trimming");
    assert.deepEqual(
      r.body.results.map((x: { action: string }) => x.action),
      ["send", "kill", "kill", "hold"],
    );
    assert.deepEqual(r.body.summary, { send: 1, hold: 1, kill: 2, total: 4 });
    // 3 valid addresses charged, 1 unreachable refunded
    assert.equal(r.body.credits_used, 2);
    assert.equal(r.body.credits_left, 98);

    const single = await t.api("POST", "/v1/verify", { email: "bob@good.test" }, h);
    assert.equal(single.status, 200);
    assert.equal(single.body.credits_left, 97);

    const viaHeader = await t.api("POST", "/v1/verify", { email: "bob@good.test" }, { "x-api-key": key });
    assert.equal(viaHeader.status, 200, "x-api-key works too");
    assert.equal(viaHeader.body.credits_left, 96);

    const b = await t.api("GET", "/v1/balance", undefined, h);
    assert.equal(b.status, 200);
    assert.equal(b.body.credits, 96);
    assert.equal(b.body.checks_total, 5);
    assert.equal(b.body.email, "ops@good.test");
    assert.ok(b.body.created_at);

    for (const [body, error] of [
      [{}, "no_emails"],
      [{ emails: [] }, "no_emails"],
      [{ emails: "a@good.test" }, "no_emails"],
      [{ emails: Array.from({ length: 101 }, (_, i) => `u${i}@good.test`) }, "too_many_emails"],
      [{ emails: [1] }, "invalid_emails"],
    ] as const) {
      const bad = await t.api("POST", "/v1/verify", body, h);
      assert.equal(bad.status, 400, error);
      assert.equal(bad.body.error, error);
    }
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 96, "bad requests cost nothing");

    // the log holds the addresses for 24 hours and no longer
    assert.equal(t.db.raw.prepare("SELECT COUNT(*) AS n FROM verify_log").get()?.["n"], 6);
    assert.equal(t.db.purgeLog(new Date(Date.now() + 1000).toISOString()), 6);
    assert.equal(t.db.stats().verdict_mix.checks, 6);
  } finally {
    await t.close();
  }
});

test("verify: 402 when the key runs dry, with the checkout hint", async () => {
  const t = await boot();
  try {
    const { headers: h } = await t.signup();
    t.db.raw.prepare("UPDATE keys SET credits = 1").run();
    const r = await t.api("POST", "/v1/verify", { emails: ["a@good.test", "b@good.test"] }, h);
    assert.equal(r.status, 402);
    assert.equal(r.body.error, "insufficient_credits");
    assert.equal(r.body.credits_left, 1);
    assert.equal(r.body.needed, 2);
    assert.match(r.body.checkout_hint, /credits\/checkout/);
    // the failed call charged nothing
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 1);
    // a call of only syntax kills is free and works with zero credits
    t.db.raw.prepare("UPDATE keys SET credits = 0").run();
    const free = await t.api("POST", "/v1/verify", { emails: ["junk"] }, h);
    assert.equal(free.status, 200);
    assert.equal(free.body.credits_used, 0);
  } finally {
    await t.close();
  }
});

test("verify: 60 checks a minute per key", async () => {
  const t = await boot({ checksPerMinute: 5 });
  try {
    const { headers: h } = await t.signup();
    assert.equal((await t.api("POST", "/v1/verify", { emails: ["a@good.test", "b@good.test", "c@good.test"] }, h)).status, 200);
    const r = await t.api("POST", "/v1/verify", { emails: ["d@good.test", "e@good.test", "f@good.test"] }, h);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "rate_limited");
    assert.ok(r.headers.get("retry-after"));
    assert.equal(r.body.retry_after_seconds, Number(r.headers.get("retry-after")));
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 97, "the refused call was not charged");
  } finally {
    await t.close();
  }
});

test("public routes: 10 calls an hour per IP", async () => {
  const t = await boot();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await t.api("POST", "/v1/feedback", { message: `m${i}` })).status, 200);
    const r = await t.api("POST", "/v1/feedback", { message: "one more" });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "rate_limited");
    assert.match(r.body.message, /feedback requests/);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await t.api("POST", "/v1/subscribe", { email: "a@good.test" })).status, 200, "each route has its own bucket");
  } finally {
    await t.close();
  }
});

test("revoked key is 403", async () => {
  const t = await boot();
  try {
    const { headers: h } = await t.signup();
    assert.equal(t.db.setRevoked("ops@good.test", true), true);
    const r = await t.api("GET", "/v1/balance", undefined, h);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "key_revoked");
    assert.equal(t.db.setRevoked("ops@good.test", false), true);
    assert.equal((await t.api("GET", "/v1/balance", undefined, h)).status, 200);
  } finally {
    await t.close();
  }
});

test("checkout: creates a Stripe session with the key in the metadata", async () => {
  const t = await boot();
  try {
    const { headers: h, id } = await t.signup();
    const r = await t.api("POST", "/v1/credits/checkout", { packs: 2 }, h);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_test_123");
    assert.equal(r.body.credits, 20000);
    assert.equal(r.body.amount_usd, 18);
    assert.equal(r.body.packs, 2);
    assert.equal(r.body.session_id, "cs_test_123");
    const call = t.stripe.calls[0];
    assert.ok(call);
    assert.equal(call.url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(call.headers["authorization"], "Bearer sk_test_x");
    assert.equal(call.body.get("mode"), "payment");
    assert.equal(call.body.get("line_items[0][price]"), "price_x");
    assert.equal(call.body.get("line_items[0][quantity]"), "2");
    assert.equal(call.body.get("metadata[key_id]"), String(id));
    assert.equal(call.body.get("client_reference_id"), String(id));
    assert.equal(call.body.get("metadata[packs]"), "2");
    assert.equal(call.body.get("customer_email"), "ops@good.test");
    assert.equal(call.body.get("payment_method_types[0]"), "card");
    assert.equal(call.body.get("success_url"), "https://mxprobe.dev/paid");
    assert.equal(call.body.get("cancel_url"), "https://mxprobe.dev/");
    assert.equal(call.body.get("payment_intent_data[description]"), "MX Probe: 20,000 email checks");

    assert.equal((await t.api("POST", "/v1/credits/checkout", { packs: 500 }, h)).body.packs, 100, "capped at 100 packs");
    assert.equal((await t.api("POST", "/v1/credits/checkout", { packs: "x" }, h)).body.packs, 1, "junk means 1");
    assert.equal((await t.api("POST", "/v1/credits/checkout", undefined, h)).body.packs, 1, "no body means 1");
  } finally {
    await t.close();
  }
});

test("checkout: 503 until Stripe is configured, 500 when Stripe fails", async () => {
  const t = await boot({ stripeSecretKey: null });
  try {
    const { headers: h } = await t.signup();
    const r = await t.api("POST", "/v1/credits/checkout", {}, h);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "payments_not_configured");
    assert.equal(t.stripe.calls.length, 0);
  } finally {
    await t.close();
  }
  const failing = await boot({}, { stripeReply: jsonResponse(400, { error: { message: "No such price: price_x" } }) });
  try {
    const { headers: h } = await failing.signup();
    const r = await failing.api("POST", "/v1/credits/checkout", {}, h);
    assert.equal(r.status, 500, "Stripe's failure is ours to log, not the customer's");
    assert.equal(r.body.error, "internal");
    assert.equal(failing.stripe.calls.length, 1);
  } finally {
    await failing.close();
  }
});

test("webhook: a signed paid session adds credits once", async () => {
  const t = await boot();
  try {
    const { id: keyId } = await t.signup();
    const event = {
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_status: "paid", amount_total: 1800, currency: "usd", client_reference_id: String(keyId), metadata: { key_id: String(keyId), packs: "2" } } },
    };
    const raw = JSON.stringify(event);
    const signed = (body: string) => ({ "stripe-signature": signPayload(body, "whsec_test") });

    const bad = await t.api("POST", "/v1/stripe/webhook", raw, { "stripe-signature": "t=1,v1=deadbeef" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_signature");
    const unsigned = await t.api("POST", "/v1/stripe/webhook", raw, {});
    assert.equal(unsigned.status, 400);
    const notJson = await t.api("POST", "/v1/stripe/webhook", "nope", signed("nope"));
    assert.equal(notJson.status, 400);
    assert.equal(notJson.body.error, "invalid_json");
    const noId = await t.api("POST", "/v1/stripe/webhook", "{}", signed("{}"));
    assert.equal(noId.status, 400);

    const ok = await t.api("POST", "/v1/stripe/webhook", raw, signed(raw));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { received: true });
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 20100);
    assert.match(t.notifier.sent.telegrams.at(-1) ?? "", /PAID 18.00 USD by ops@good.test: \+20,000 checks \(20,100 on the key\)/);
    assert.match(t.notifier.sent.emails.at(-1)?.subject ?? "", /20,000 checks added/);
    assert.match(t.notifier.sent.emails.at(-1)?.text ?? "", /now holds 20,100/);

    const again = await t.api("POST", "/v1/stripe/webhook", raw, signed(raw));
    assert.equal(again.body.duplicate, true);
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 20100, "no double credit");

    // a zero-total session (100% promotion) counts as paid
    const free = JSON.stringify({ ...event, id: "evt_free", data: { object: { ...event.data.object, id: "cs_free", payment_status: "no_payment_required", amount_total: 0, metadata: { key_id: String(keyId), packs: "1" } } } });
    assert.equal((await t.api("POST", "/v1/stripe/webhook", free, signed(free))).status, 200);
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 30100);
    assert.match(t.notifier.sent.telegrams.at(-1) ?? "", /PAID 0.00 USD/);

    // async payment success is the same as completed
    const later = JSON.stringify({ ...event, id: "evt_async", type: "checkout.session.async_payment_succeeded", data: { object: { ...event.data.object, id: "cs_async", amount_total: null, metadata: { key_id: String(keyId), packs: "1" } } } });
    assert.equal((await t.api("POST", "/v1/stripe/webhook", later, signed(later))).status, 200);
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 40100);
    assert.match(t.notifier.sent.telegrams.at(-1) ?? "", /PAID \? by/);

    // an unpaid session is acknowledged and ignored
    const unpaid = JSON.stringify({ ...event, id: "evt_2", data: { object: { ...event.data.object, payment_status: "unpaid" } } });
    assert.equal((await t.api("POST", "/v1/stripe/webhook", unpaid, signed(unpaid))).status, 200);
    assert.equal(t.db.keyByEmail("ops@good.test")?.credits, 40100);

    // other event types are acknowledged and ignored
    const other = JSON.stringify({ id: "evt_other", type: "payment_intent.created", data: { object: {} } });
    assert.deepEqual((await t.api("POST", "/v1/stripe/webhook", other, signed(other))).body, { received: true });

    // a paid session for an unknown key is a 500 and the event is released for Stripe's retry
    const ghost = JSON.stringify({ ...event, id: "evt_3", data: { object: { ...event.data.object, metadata: { key_id: "999", packs: "1" } } } });
    const g = await t.api("POST", "/v1/stripe/webhook", ghost, signed(ghost));
    assert.equal(g.status, 500);
    assert.equal(g.body.error, "internal");
    assert.equal(t.db.claimStripeEvent("evt_3", "x"), true, "released");

    const st = t.db.stats();
    assert.equal(st.paying_keys, 1);
    assert.equal(st.purchases, 3);
  } finally {
    await t.close();
  }
});

test("webhook: 503 without a webhook secret", async () => {
  const t = await boot({ stripeWebhookSecret: null });
  try {
    const r = await t.api("POST", "/v1/stripe/webhook", "{}", { "stripe-signature": "t=1,v1=x" });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "webhook_not_configured");
  } finally {
    await t.close();
  }
});

test("subscribe and feedback ping Telegram", async () => {
  const t = await boot();
  try {
    assert.equal((await t.api("POST", "/v1/subscribe", { email: "Fan@Good.test" })).status, 200);
    assert.equal((await t.api("POST", "/v1/subscribe", { email: "fan@good.test" })).status, 200);
    assert.equal((await t.api("POST", "/v1/subscribe", { email: "junk" })).status, 400);
    assert.equal(t.notifier.sent.telegrams.filter((x) => /subscriber/.test(x)).length, 1, "one ping per new subscriber");
    assert.equal((await t.api("POST", "/v1/feedback", { message: "  " })).status, 400);
    assert.equal((await t.api("POST", "/v1/feedback", { email: "fan@good.test", message: "add CSV" })).status, 200);
    assert.match(t.notifier.sent.telegrams.at(-1) ?? "", /feedback from fan@good.test:\nadd CSV/);
    assert.equal((await t.api("POST", "/v1/feedback", { email: "junk", message: "x".repeat(3000) })).status, 200);
    assert.match(t.notifier.sent.telegrams.at(-1) ?? "", /feedback from anonymous:\nx{2000}$/, "a bad email is anonymous and the message is capped");
    assert.equal(t.db.stats().subscribers, 1);
    assert.equal(t.db.stats().feedback, 2);
  } finally {
    await t.close();
  }
});

test("health, 404, CORS preflight, oversized body", async () => {
  const t = await boot();
  try {
    const h = await t.api("GET", "/v1/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.equal(h.body.payments, true);
    assert.equal(h.body.version, VERSION);
    assert.match(VERSION, /^\d+\.\d+\.\d+$/, "the version comes from package.json");
    assert.deepEqual(h.body.notifier, { telegram: true, email: true });
    assert.equal(typeof h.body.uptime_s, "number");
    const nf = await t.api("GET", "/nope");
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error, "not_found");
    assert.equal((await t.api("DELETE", "/v1/health")).status, 404, "wrong method is a 404 too");
    const pre = await fetch(`${t.base}/v1/subscribe`, { method: "OPTIONS", headers: { origin: "https://mxprobe.dev" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /x-api-key/);
    const big = await t.api("POST", "/v1/feedback", { message: "x".repeat(70 * 1024) });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, "body_too_large");
  } finally {
    await t.close();
  }
});

test("health without payments configured says so", async () => {
  const t = await boot({ stripePriceId: null });
  try {
    assert.equal((await t.api("GET", "/v1/health")).body.payments, false);
  } finally {
    await t.close();
  }
});

test("newApiKey and hashKey", () => {
  const k = newApiKey();
  assert.match(k.key, /^mxp_[0-9a-f]{32}$/);
  assert.equal(k.prefix, k.key.slice(0, 12));
  assert.equal(k.hash, hashKey(k.key));
  assert.match(k.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(newApiKey().key, k.key);
  assert.equal(hashKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("HttpError carries status and a JSON body", () => {
  const e = new HttpError(429, "rate_limited", "slow down", { retry_after_seconds: 3 });
  assert.ok(e instanceof Error);
  assert.equal(e.name, "HttpError");
  assert.equal(e.status, 429);
  assert.equal(e.message, "slow down");
  assert.deepEqual(e.body, { error: "rate_limited", message: "slow down", retry_after_seconds: 3 });
});
