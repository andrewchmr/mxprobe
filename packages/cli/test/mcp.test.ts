// The MCP server over an in-memory transport: the tool list and the calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "../src/mcp.ts";
import { configPath, readConfig } from "../src/config.ts";
import { fakeFetch, freshEnv, hostedResult, resolver, type Canned } from "./helpers.ts";

async function connect(env: NodeJS.ProcessEnv, canned: Canned = {}) {
  const f = fakeFetch(canned);
  const server = buildMcpServer({ env, fetchImpl: f.fetchImpl, verifierOptions: { resolver } });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = r.content[0];
    const text = first?.type === "text" ? first.text : "";
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text }; // the SDK's own validation errors are plain text
    }
    return { r, json, isError: r.isError === true };
  };
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { client, call, close, calls: f.calls };
}

test("mcp: five tools, verify_email returns the verdict contract", async () => {
  const t = await connect(freshEnv());
  try {
    const { tools } = await t.client.listTools();
    assert.deepEqual(
      tools.map((x) => x.name).sort(),
      ["balance", "buy_credits", "signup", "verify_batch", "verify_email"],
    );
    for (const tool of tools) assert.ok(tool.description && tool.description.length > 40, `${tool.name} is documented`);
    const v = await t.call("verify_email", { email: "junk" });
    assert.equal(v.json["action"], "kill");
    assert.equal(v.json["hosted"], false, "no key configured, so the free tier");
    assert.equal(v.r.structuredContent?.["verdict"], "DEAD");
    const bal = await t.call("balance");
    assert.equal(bal.isError, true);
    assert.equal(bal.json["status"], 401);
    assert.equal(bal.json["error"], "no_api_key");
    assert.equal(t.calls.length, 0, "nothing went to the network");
  } finally {
    await t.close();
  }
});

test("mcp: verify_batch runs the DNS tier locally without a key and keeps order", async () => {
  const t = await connect(freshEnv());
  try {
    const { json } = await t.call("verify_batch", { emails: ["a@good.test", "x@dead.test", "junk"] });
    const results = json["results"] as { email: string; action: string }[];
    assert.deepEqual(
      results.map((r) => [r.email, r.action]),
      [
        ["a@good.test", "send"],
        ["x@dead.test", "kill"],
        ["junk", "kill"],
      ],
    );
    assert.deepEqual(json["summary"], { send: 1, hold: 0, kill: 2, total: 3 });
    assert.equal(json["hosted"], false);
    assert.equal(json["credits_left"], null);
  } finally {
    await t.close();
  }
});

test("mcp: with a key the survivors go hosted by default; hosted:false keeps it local", async () => {
  const t = await connect(freshEnv({ MXPROBE_API_KEY: "mxp_env" }), {
    "POST /v1/verify": (call) => {
      const emails = (call.body as { emails: string[] }).emails;
      return { body: { results: emails.map((e) => hostedResult(e, "WEAK")), summary: {}, credits_used: emails.length, credits_left: 9 } };
    },
  });
  try {
    const one = await t.call("verify_email", { email: "a@good.test" });
    assert.equal(one.json["hosted"], true);
    assert.equal(one.json["action"], "hold");
    assert.equal(one.json["credits_left"], 9);
    assert.equal(t.calls[0]?.headers["authorization"], "Bearer mxp_env");

    const local = await t.call("verify_email", { email: "a@good.test", hosted: false });
    assert.equal(local.json["hosted"], false);
    assert.equal(local.json["action"], "send");
    assert.equal(t.calls.length, 1, "hosted:false made no request");

    const batch = await t.call("verify_batch", { emails: ["a@good.test", "x@dead.test"] });
    assert.equal(batch.json["hosted"], true);
    assert.deepEqual(t.calls[1]?.body, { emails: ["a@good.test"] }, "the DNS kill never went up");
  } finally {
    await t.close();
  }
});

test("mcp: signup saves the key, and the next call uses it", async () => {
  const env = freshEnv();
  const t = await connect(env, {
    "POST /v1/signup": { status: 201, body: { api_key: "mxp_new", email: "ops@good.test", credits: 100, mailed: true, message: "keep it" } },
    "GET /v1/balance": { body: { email: "ops@good.test", credits: 100, checks_total: 0, created_at: "" } },
  });
  try {
    const s = await t.call("signup", { email: "ops@good.test" });
    assert.equal(s.isError, false);
    assert.equal(s.json["ok"], true);
    assert.equal(s.json["api_key"], "mxp_new");
    assert.equal(s.json["saved_to"], configPath(env));
    assert.equal(readConfig(env).apiKey, "mxp_new");
    const b = await t.call("balance");
    assert.equal(b.json["credits"], 100);
    assert.equal(t.calls[1]?.headers["authorization"], "Bearer mxp_new", "the config is re-read on every call");
  } finally {
    await t.close();
  }
});

test("mcp: API errors come back as isError with status, error and the checkout hint", async () => {
  const t = await connect(freshEnv({ MXPROBE_API_KEY: "mxp_env" }), {
    "POST /v1/credits/checkout": { body: { url: "https://checkout.test/x", credits: 20000, amount_usd: 18, packs: 2, session_id: "cs", message: "" } },
    "POST /v1/verify": { status: 402, body: { error: "insufficient_credits", message: "dry", checkout_hint: "buy more" } },
  });
  try {
    const buy = await t.call("buy_credits", { packs: 2 });
    assert.equal(buy.isError, false);
    assert.equal(buy.json["credits"], 20000);
    assert.deepEqual(t.calls[0]?.body, { packs: 2 });
    const dry = await t.call("verify_email", { email: "a@good.test" });
    assert.equal(dry.isError, true);
    assert.deepEqual(dry.json, { error: "insufficient_credits", status: 402, message: "dry", checkout_hint: "buy more" });
    const bad = await t.call("buy_credits", { packs: 0 });
    assert.equal(bad.isError, true, "the schema rejects packs < 1");
    assert.match(String(bad.json["raw"]), /packs/);
    assert.equal(t.calls.length, 2, "nothing was sent for the rejected call");
  } finally {
    await t.close();
  }
});
