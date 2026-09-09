// The hosted API client. Also the package's main export, so a Node agent can
// `import { createClient } from "mxprobe"` without the CLI.
import { createVerifier, summarize } from "mxprobe-core";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function createClient({ apiUrl = "https://api.mxprobe.dev", apiKey = null, fetchImpl = fetch } = {}) {
  const base = apiUrl.replace(/\/$/, "");

  async function call(method, path, body, { auth = true } = {}) {
    const headers = { "content-type": "application/json", "user-agent": "mxprobe-cli" };
    if (auth) {
      if (!apiKey) throw new ApiError(401, { error: "no_api_key", message: "No API key. Run `mxprobe signup you@company.com` or set MXPROBE_API_KEY." });
      headers.authorization = `Bearer ${apiKey}`;
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: "bad_response", message: text.slice(0, 200) };
    }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }

  return {
    signup: (email) => call("POST", "/v1/signup", { email }, { auth: false }),
    verify: (emails) => call("POST", "/v1/verify", { emails }),
    balance: () => call("GET", "/v1/balance"),
    checkout: (packs = 1) => call("POST", "/v1/credits/checkout", { packs }),
  };
}

/**
 * The two-tier check the CLI and the MCP server share. The DNS tier runs
 * locally and is free; with `hosted` on, the survivors (send and hold) go to
 * the hosted SMTP probe, one credit each. A DNS kill never costs a credit.
 */
export async function checkEmails(emails, { hosted = false, client = null, smtp = false, verifierOptions = {} } = {}) {
  const local = createVerifier({ ...verifierOptions, smtp });
  const results = await local.verifyBatch(emails);
  let hostedCount = 0;
  let creditsLeft = null;
  if (hosted) {
    if (!client) throw new Error("hosted check needs an API client");
    const survivors = results.filter((r) => r.action !== "kill").map((r) => r.email);
    if (survivors.length) {
      const byEmail = new Map();
      for (let i = 0; i < survivors.length; i += 100) {
        const chunk = survivors.slice(i, i + 100);
        const res = await client.verify(chunk);
        for (const r of res.results) byEmail.set(r.email, r);
        creditsLeft = res.credits_left ?? creditsLeft;
      }
      for (let i = 0; i < results.length; i++) {
        const h = byEmail.get(results[i].email);
        if (h) {
          results[i] = h;
          hostedCount++;
        }
      }
    }
  }
  return { results, summary: summarize(results), hosted: hostedCount, credits_left: creditsLeft };
}
