import { test } from "node:test";
import assert from "node:assert/strict";
import { createCheckoutSession, parseSignatureHeader, signPayload, StripeError, verifyStripeSignature } from "../src/stripe.ts";
import { fakeStripeFetch, jsonResponse } from "./helpers.ts";

test("stripe signature: tolerance and constant-time compare", () => {
  const raw = '{"id":"evt"}';
  const sig = signPayload(raw, "s", 1000);
  assert.equal(verifyStripeSignature(raw, sig, "s", { nowSec: 1100 }), true);
  assert.equal(verifyStripeSignature(raw, sig, "s", { nowSec: 1300 }), true, "at the edge of the 300 s tolerance");
  assert.equal(verifyStripeSignature(raw, sig, "s", { nowSec: 1301 }), false, "too old");
  assert.equal(verifyStripeSignature(raw, sig, "s", { nowSec: 600 }), false, "from the future");
  assert.equal(verifyStripeSignature(raw, sig, "s", { nowSec: 2000, toleranceSec: 1500 }), true, "custom tolerance");
  assert.equal(verifyStripeSignature(raw, sig, "other", { nowSec: 1100 }), false);
  assert.equal(verifyStripeSignature(raw + " ", sig, "s", { nowSec: 1100 }), false);
  assert.equal(verifyStripeSignature(raw, "", "s"), false);
  assert.equal(verifyStripeSignature(raw, undefined, "s"), false);
  assert.equal(verifyStripeSignature(raw, "t=1000", "s", { nowSec: 1100 }), false, "no v1");
  assert.equal(verifyStripeSignature(raw, "t=abc,v1=00", "s", { nowSec: 1100 }), false, "bad timestamp");
  assert.equal(verifyStripeSignature(raw, `t=1000,v1=deadbeef,${sig.split(",")[1]}`, "s", { nowSec: 1100 }), true, "any matching v1 among several");
  assert.equal(verifyStripeSignature(raw, sig.toUpperCase(), "s", { nowSec: 1100 }), false, "hex case matters, but T= is not t=");
});

test("stripe signature: signPayload defaults to now and verifies", () => {
  const raw = "body";
  assert.equal(verifyStripeSignature(raw, signPayload(raw, "whsec"), "whsec"), true);
});

test("parseSignatureHeader", () => {
  assert.deepEqual(parseSignatureHeader("t=1492774577,v1=5257a869e7,v0=6ffbb59b2300"), { t: 1492774577, signatures: ["5257a869e7"] });
  assert.deepEqual(parseSignatureHeader(" t = 5 , v1 = a , v1 = b "), { t: 5, signatures: ["a", "b"] });
  assert.deepEqual(parseSignatureHeader(""), { t: null, signatures: [] });
  assert.deepEqual(parseSignatureHeader(undefined), { t: null, signatures: [] });
  assert.deepEqual(parseSignatureHeader(["t=1,v1=x"]), { t: 1, signatures: ["x"] }, "an array header is stringified");
  assert.deepEqual(parseSignatureHeader("v1="), { t: null, signatures: [] });
});

test("createCheckoutSession: builds the form Stripe expects and returns id and url", async () => {
  const { fetchImpl, calls } = fakeStripeFetch();
  const s = await createCheckoutSession({ secretKey: "sk", priceId: "price_1", quantity: 3, keyId: 7, email: "a@b.co", successUrl: "https://s/paid", cancelUrl: "https://s/", description: "d", fetchImpl });
  assert.deepEqual(s, { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" });
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(call.headers["authorization"], "Bearer sk");
  assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(call.body), {
    mode: "payment",
    "line_items[0][price]": "price_1",
    "line_items[0][quantity]": "3",
    success_url: "https://s/paid",
    cancel_url: "https://s/",
    client_reference_id: "7",
    "metadata[key_id]": "7",
    "metadata[packs]": "3",
    "payment_intent_data[description]": "d",
    "payment_intent_data[statement_descriptor_suffix]": "MXPROBE",
    "payment_method_types[0]": "card",
    allow_promotion_codes: "true",
    customer_email: "a@b.co",
  });
  const anon = fakeStripeFetch();
  await createCheckoutSession({ secretKey: "sk", priceId: "p", quantity: 1, keyId: 1, email: null, successUrl: "s", cancelUrl: "c", description: "d", fetchImpl: anon.fetchImpl });
  assert.equal(anon.calls[0]?.body.has("customer_email"), false);
});

test("createCheckoutSession: a Stripe error becomes a StripeError with Stripe's message", async () => {
  const bad = fakeStripeFetch(jsonResponse(402, { error: { message: "Your card was declined.", type: "card_error" } }));
  const params = { secretKey: "sk", priceId: "p", quantity: 1, keyId: 1, successUrl: "s", cancelUrl: "c", description: "d" };
  await assert.rejects(createCheckoutSession({ ...params, fetchImpl: bad.fetchImpl }), (e: unknown) => e instanceof StripeError && e.status === 402 && e.message === "Your card was declined." && (e.stripe as { type: string }).type === "card_error");
  const opaque = fakeStripeFetch({ ok: false, status: 500, json: async () => Promise.reject(new Error("not json")), text: async () => "" });
  await assert.rejects(createCheckoutSession({ ...params, fetchImpl: opaque.fetchImpl }), /Stripe HTTP 500/);
  const odd = fakeStripeFetch(jsonResponse(200, { object: "checkout.session" }));
  await assert.rejects(createCheckoutSession({ ...params, fetchImpl: odd.fetchImpl }), /without id or url/);
});
