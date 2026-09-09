import { test } from "node:test";
import assert from "node:assert/strict";
import type { VerifyResponse } from "mxprobe-core";
import { checkEmails, createClient, ApiError, HOSTED_BATCH, type Client } from "../src/client.ts";
import { fakeFetch, hostedResult, resolver } from "./helpers.ts";

const verifyOnly = (verify: Client["verify"]): Pick<Client, "verify"> => ({ verify });

test("checkEmails: DNS kills stay local, survivors go to the hosted probe", async () => {
  const sent: string[][] = [];
  const client = verifyOnly(async (emails) => {
    sent.push([...emails]);
    return { results: emails.map((email) => hostedResult(email, "DEAD")), summary: { send: 0, hold: 0, kill: emails.length, total: emails.length }, credits_used: emails.length, credits_left: 42 };
  });
  const out = await checkEmails(["a@good.test", "x@dead.test", "junk"], { hosted: true, client, verifierOptions: { resolver } });
  assert.deepEqual(sent, [["a@good.test"]]);
  assert.deepEqual(
    out.results.map((r) => r.reason),
    ["hosted says DEAD", "domain does not exist (NXDOMAIN)", "not an email address"],
  );
  assert.equal(out.hosted, 1);
  assert.equal(out.credits_left, 42);
  assert.deepEqual(out.summary, { send: 0, hold: 0, kill: 3, total: 3 });
});

test("checkEmails: without hosted nothing leaves the machine", async () => {
  const out = await checkEmails(["a@good.test"], { hosted: false, client: null, verifierOptions: { resolver } });
  assert.equal(out.results[0]?.action, "send");
  assert.equal(out.results[0]?.checks.smtp, "skipped");
  assert.equal(out.hosted, 0);
  assert.equal(out.credits_left, null);
});

test("checkEmails: hosted without a client is a programming error", async () => {
  await assert.rejects(checkEmails(["a@good.test"], { hosted: true, verifierOptions: { resolver } }), /hosted check needs an API client/);
});

test("checkEmails: no survivors means no hosted call at all", async () => {
  let calls = 0;
  const client = verifyOnly(async () => {
    calls++;
    throw new Error("must not be called");
  });
  const out = await checkEmails(["x@dead.test", "junk"], { hosted: true, client, verifierOptions: { resolver } });
  assert.equal(calls, 0);
  assert.equal(out.hosted, 0);
  assert.equal(out.credits_left, null);
});

test("checkEmails: survivors go up in chunks of 100, the last credits_left wins, order is kept", async () => {
  const emails = Array.from({ length: 205 }, (_, i) => `u${i}@good.test`);
  const sizes: number[] = [];
  let left = 1000;
  const client = verifyOnly(async (chunk): Promise<VerifyResponse> => {
    sizes.push(chunk.length);
    left -= chunk.length;
    // the server never answers for u7: its local verdict must survive
    const answered = chunk.filter((e) => e !== "u7@good.test");
    return { results: answered.map((e) => hostedResult(e, "WEAK")), summary: { send: 0, hold: answered.length, kill: 0, total: answered.length }, credits_used: answered.length, credits_left: left };
  });
  const out = await checkEmails(emails, { hosted: true, client, verifierOptions: { resolver } });
  assert.deepEqual(sizes, [HOSTED_BATCH, HOSTED_BATCH, 5]);
  assert.equal(out.credits_left, 1000 - 205);
  assert.equal(out.hosted, 204);
  assert.deepEqual(
    out.results.map((r) => r.email),
    emails,
  );
  assert.equal(out.results[7]?.reason.includes("not probed"), true, "u7 kept its DNS-tier verdict");
  assert.equal(out.results[8]?.action, "hold");
});

test("createClient: bearer header, JSON errors become ApiError, no key is 401 before any request", async () => {
  const { fetchImpl, calls } = fakeFetch({ "POST /v1/verify": { status: 402, body: { error: "insufficient_credits", message: "dry" } } });
  const c = createClient({ apiUrl: "https://api.test/", apiKey: "mxp_k", fetchImpl });
  await assert.rejects(c.verify(["a@b.co"]), (e: unknown) => e instanceof ApiError && e.status === 402 && e.message === "dry" && e.body.error === "insufficient_credits");
  assert.equal(calls[0]?.url, "https://api.test/v1/verify", "the trailing slash is stripped");
  assert.equal(calls[0]?.headers["authorization"], "Bearer mxp_k");
  assert.equal(calls[0]?.headers["content-type"], "application/json");
  assert.deepEqual(calls[0]?.body, { emails: ["a@b.co"] });
  const noKey = createClient({ apiUrl: "https://api.test", apiKey: null, fetchImpl });
  await assert.rejects(noKey.balance(), (e: unknown) => e instanceof ApiError && e.status === 401 && e.body.error === "no_api_key");
  assert.equal(calls.length, 1, "no request without a key");
});

test("createClient: signup needs no key and sends no authorization header", async () => {
  const { fetchImpl, calls } = fakeFetch({ "POST /v1/signup": { status: 201, body: { api_key: "mxp_new", email: "a@b.co", credits: 100, mailed: true, message: "m" } } });
  const res = await createClient({ apiUrl: "https://api.test", fetchImpl }).signup("a@b.co");
  assert.equal(res.api_key, "mxp_new");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers["authorization"], undefined);
  assert.deepEqual(calls[0]?.body, { email: "a@b.co" });
});

test("createClient: balance is a GET without a body; checkout defaults to one pack", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "GET /v1/balance": { body: { email: "a@b.co", credits: 5, checks_total: 95, created_at: "2026-09-09T00:00:00Z" } },
    "POST /v1/credits/checkout": { body: { url: "https://checkout.test/x", credits: 10000, amount_usd: 9, packs: 1, session_id: "cs_1", message: "" } },
  });
  const c = createClient({ apiUrl: "https://api.test", apiKey: "mxp_k", fetchImpl });
  assert.equal((await c.balance()).credits, 5);
  assert.equal(calls[0]?.body, undefined);
  assert.equal((await c.checkout()).url, "https://checkout.test/x");
  assert.deepEqual(calls[1]?.body, { packs: 1 });
  await c.checkout(3);
  assert.deepEqual(calls[2]?.body, { packs: 3 });
});

test("createClient: a non-JSON error body becomes bad_response with the text; an empty 200 is {}", async () => {
  const { fetchImpl } = fakeFetch({
    "GET /v1/balance": { status: 502, body: "<html>Bad Gateway</html>" },
    "POST /v1/credits/checkout": { body: "" },
  });
  const c = createClient({ apiUrl: "https://api.test", apiKey: "mxp_k", fetchImpl });
  await assert.rejects(c.balance(), (e: unknown) => e instanceof ApiError && e.status === 502 && e.body.error === "bad_response" && e.message === "<html>Bad Gateway</html>");
  assert.deepEqual(await c.checkout(), {});
});

test("ApiError: the message falls back from message to error to the status", () => {
  assert.equal(new ApiError(500, { message: "m", error: "e" }).message, "m");
  assert.equal(new ApiError(500, { error: "e" }).message, "e");
  assert.equal(new ApiError(500).message, "HTTP 500");
  assert.equal(new ApiError(500).name, "ApiError");
  assert.ok(new ApiError(500) instanceof Error);
});
