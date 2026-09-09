import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { readConfig, writeConfig, configPath, type Env } from "./config.ts";
import { createClient, checkEmails, ApiError, type FetchLike } from "./client.ts";
import type { VerifierOptions } from "mxprobe-core";
import { version } from "./version.ts";

const HELP = `mxprobe ${version}: email verification for AI agents. Verdicts: send, hold, kill.

Usage
  mxprobe check <email>...            DNS tier, local, free, no key
  mxprobe check --hosted <email>...   send the survivors to the hosted SMTP probe (1 credit each)
  mxprobe check --file list.txt       one address per line
  mxprobe check --json ...            print the verdict objects as JSON
  mxprobe signup <email>              get an API key by mail, with 100 free checks
  mxprobe balance                     credits left on the key
  mxprobe buy [--packs N]             a Stripe Checkout link: 9 USD per 10,000 checks
  mxprobe mcp                         start the MCP server on stdio

Options
  --smtp        run the SMTP probe locally too (needs outbound port 25; most laptops and clouds block it)
  --api-url     hosted API base (default https://api.mxprobe.dev)

Key: MXPROBE_API_KEY in the environment, else ${configPath()}
Docs: https://mxprobe.dev`;

/** Anything with a write(string): process.stdout, or a buffer in tests. */
export interface Sink {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout?: Sink;
  stderr?: Sink;
  env?: Env;
  /** For tests: the fetch the hosted client uses. */
  fetchImpl?: FetchLike;
  /** For tests: a fake resolver for the local DNS tier. */
  verifierOptions?: VerifierOptions;
}

/** Exit codes: 0 ok, 1 a kill (single address) or an API error, 2 usage. */
export async function main(argv: readonly string[], { stdout = process.stdout, stderr = process.stderr, env = process.env, fetchImpl, verifierOptions }: CliIo = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      hosted: { type: "boolean", default: false },
      smtp: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      file: { type: "string" },
      packs: { type: "string", default: "1" },
      "api-url": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.version) {
    stdout.write(`${version}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command || command === "help") {
    stdout.write(HELP + "\n");
    return 0;
  }

  const cfg = readConfig(env);
  if (values["api-url"]) cfg.apiUrl = values["api-url"].replace(/\/$/, "");
  const client = createClient({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, fetchImpl });

  try {
    switch (command) {
      case "check": {
        const emails = [...rest];
        if (values.file) {
          emails.push(
            ...readFileSync(values.file, "utf8")
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith("#")),
          );
        }
        if (emails.length === 0) {
          stderr.write("usage: mxprobe check [--hosted] [--json] <email>... | --file <list>\n");
          return 2;
        }
        const out = await checkEmails(emails, { hosted: values.hosted, client, smtp: values.smtp, verifierOptions });
        if (values.json) {
          stdout.write(JSON.stringify(out, null, 2) + "\n");
        } else {
          const width = Math.max(...out.results.map((r) => r.email.length));
          for (const r of out.results) stdout.write(`${r.action.padEnd(4)} ${r.verdict.padEnd(4)} ${r.email.padEnd(width)}  ${r.reason}\n`);
          const s = out.summary;
          stderr.write(`\n${s.total} checked: ${s.send} send, ${s.hold} hold, ${s.kill} kill`);
          if (values.hosted) stderr.write(`; ${out.hosted} probed on the hosted tier, ${out.credits_left ?? "?"} credits left`);
          else if (!values.smtp) stderr.write(`. DNS tier only: a send means the domain takes mail, not that the mailbox exists. Add --hosted to probe the mailbox.`);
          stderr.write("\n");
        }
        return out.summary.kill > 0 && emails.length === 1 ? 1 : 0;
      }
      case "signup": {
        const email = rest[0];
        if (!email) {
          stderr.write("usage: mxprobe signup <email>\n");
          return 2;
        }
        const res = await client.signup(email);
        const path = writeConfig({ api_key: res.api_key, api_url: cfg.apiUrl, email: res.email }, env);
        stdout.write(`Key saved to ${path}. ${res.credits} free checks on it. The key was also mailed to ${res.email}.\n`);
        return 0;
      }
      case "balance": {
        const res = await client.balance();
        stdout.write(values.json ? JSON.stringify(res) + "\n" : `${res.credits} credits left on the key for ${res.email} (${res.checks_total} checks so far)\n`);
        return 0;
      }
      case "buy": {
        const packs = Math.max(1, Number.parseInt(values.packs, 10) || 1);
        const res = await client.checkout(packs);
        stdout.write(values.json ? JSON.stringify(res) + "\n" : `Pay ${res.amount_usd} USD for ${res.credits} checks here:\n${res.url}\nCredits land on the key as soon as Stripe confirms the payment.\n`);
        return 0;
      }
      case "mcp": {
        const { startMcpServer } = await import("./mcp.ts");
        await startMcpServer({ env });
        return 0;
      }
      default:
        stderr.write(`unknown command "${command}"\n\n${HELP}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      stderr.write(`${err.status}: ${err.message}\n`);
      if (err.status === 402 && err.body.checkout_hint) stderr.write(`${err.body.checkout_hint}\n`);
      return 1;
    }
    throw err;
  }
}
