// The MCP server: the same five things the API does, as tools an agent can
// call. verify_email and verify_batch run the free DNS tier locally and, when
// a key is configured, send the survivors to the hosted SMTP probe.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { readConfig, writeConfig } from "./config.mjs";
import { createClient, checkEmails, ApiError } from "./client.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const VERDICT_DOC =
  "Each result is { email, action, verdict, reason, checks }. action is send | hold | kill: send means go ahead, hold means send only with a fallback in hand (catch-all, forwarder, greylisted or refused probe), kill means never send (no mail server, or the mailbox does not exist). checks.smtp is skipped on the free DNS tier; the hosted tier probes the mailbox.";

function text(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

function failure(err) {
  const body = err instanceof ApiError ? { error: err.body?.error ?? "api_error", status: err.status, message: err.message, ...(err.body?.checkout_hint ? { checkout_hint: err.body.checkout_hint } : {}) } : { error: "failed", message: err.message };
  return { ...text(body), isError: true };
}

export function buildMcpServer({ env = process.env } = {}) {
  const server = new McpServer({ name: "mxprobe", version });

  // Re-read the config on every call so a signup made through the server is
  // picked up without a restart.
  const state = () => {
    const cfg = readConfig(env);
    return { cfg, client: createClient({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey }) };
  };

  server.registerTool(
    "verify_email",
    {
      title: "Verify one email address",
      description: `Check whether an email address can receive mail before sending to it. ${VERDICT_DOC} Uses the hosted SMTP probe (1 credit) when an API key is configured and hosted is not false; otherwise the free local DNS tier.`,
      inputSchema: { email: z.string().describe("The address to check"), hosted: z.boolean().optional().describe("Probe the mailbox on the hosted tier (default: yes when a key is configured)") },
    },
    async ({ email, hosted }) => {
      try {
        const { cfg, client } = state();
        const useHosted = hosted ?? !!cfg.apiKey;
        const out = await checkEmails([email], { hosted: useHosted, client });
        return text({ ...out.results[0], hosted: useHosted, credits_left: out.credits_left });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "verify_batch",
    {
      title: "Verify a list of email addresses",
      description: `Check up to 500 addresses in one call. ${VERDICT_DOC} DNS kills cost nothing; with a key the survivors go to the hosted probe at 1 credit each.`,
      inputSchema: { emails: z.array(z.string()).min(1).max(500).describe("The addresses to check"), hosted: z.boolean().optional().describe("Probe mailboxes on the hosted tier (default: yes when a key is configured)") },
    },
    async ({ emails, hosted }) => {
      try {
        const { cfg, client } = state();
        const useHosted = hosted ?? !!cfg.apiKey;
        const out = await checkEmails(emails, { hosted: useHosted, client });
        return text({ results: out.results, summary: out.summary, hosted: useHosted, credits_left: out.credits_left });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "signup",
    {
      title: "Create an MX Probe API key",
      description: "Sign up with an email address. Returns an API key with 100 free checks and saves it locally for the other tools. The key is also mailed to the address. One key per address.",
      inputSchema: { email: z.string().describe("The operator's email address, where the key is mailed") },
    },
    async ({ email }) => {
      try {
        const { cfg, client } = state();
        const res = await client.signup(email);
        const path = writeConfig({ api_key: res.api_key, api_url: cfg.apiUrl, email: res.email }, env);
        return text({ ok: true, email: res.email, credits: res.credits, api_key: res.api_key, saved_to: path, message: res.message });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "balance",
    { title: "Credits left", description: "How many hosted checks are left on the configured API key.", inputSchema: {} },
    async () => {
      try {
        return text(await state().client.balance());
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "buy_credits",
    {
      title: "Buy credits",
      description: "Get a Stripe Checkout link for more hosted checks: 9 USD per 10,000, one payment, credits never expire. Open the link to pay; credits land on the key when Stripe confirms.",
      inputSchema: { packs: z.number().int().min(1).max(100).optional().describe("How many packs of 10,000 (default 1)") },
    },
    async ({ packs }) => {
      try {
        return text(await state().client.checkout(packs ?? 1));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export async function startMcpServer(opts = {}) {
  const server = buildMcpServer(opts);
  await server.connect(new StdioServerTransport());
  // The transport keeps the process alive while stdin is open; when the
  // client closes it, in-flight calls finish and the loop drains on its own.
  return server;
}
