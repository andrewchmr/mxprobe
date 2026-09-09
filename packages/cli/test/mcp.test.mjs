// The MCP server over an in-memory transport: the tool list and one call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp.mjs";

test("mcp: five tools, verify_email returns the verdict contract", async () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "mxprobe-")) };
  const server = buildMcpServer({ env });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["balance", "buy_credits", "signup", "verify_batch", "verify_email"]);
    const r = await client.callTool({ name: "verify_email", arguments: { email: "junk" } });
    const v = JSON.parse(r.content[0].text);
    assert.equal(v.action, "kill");
    assert.equal(v.hosted, false, "no key configured, so the free tier");
    assert.equal(r.structuredContent.verdict, "DEAD");
    const bal = await client.callTool({ name: "balance", arguments: {} });
    assert.equal(bal.isError, true);
    assert.equal(JSON.parse(bal.content[0].text).status, 401);
  } finally {
    await client.close();
    await server.close();
  }
});
