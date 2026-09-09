// Offline tests: a fake resolver for the DNS tier and a fake SMTP server on
// localhost for the probe. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { parseAddress, checkDomain, probeMailbox, createVerifier, verify, summarize, ACTIONS } from "../src/index.mjs";

// ------------------------------------------------------------ fake resolver

const nx = (code) => Object.assign(new Error(code), { code });

function fakeResolver(table) {
  return {
    async resolveMx(domain) {
      const d = table[domain];
      if (!d) throw nx("ENOTFOUND");
      if (d.mx === undefined) throw nx("ENODATA");
      return d.mx;
    },
    async resolve4(host) {
      const d = table[host];
      if (!d || !d.a) throw nx("ENODATA");
      return d.a;
    },
    async resolve6() {
      throw nx("ENODATA");
    },
    async reverse(ip) {
      const ptr = Object.values(table).find((d) => d.a?.includes(ip))?.ptr;
      if (!ptr) throw nx("ENOTFOUND");
      return [ptr];
    },
  };
}

const TABLE = {
  "good.test": { mx: [{ exchange: "mx2.good.test", priority: 20 }, { exchange: "mx1.good.test", priority: 10 }] },
  "mx1.good.test": { a: ["127.0.0.1"] },
  "mx2.good.test": { a: ["127.0.0.1"] },
  "nomx.test": { mx: undefined, a: ["75.2.60.5"] },
  "nullmx.test": { mx: [{ exchange: "", priority: 0 }] },
  "parked.test": { mx: [{ exchange: "pixie.porkbun.com", priority: 10 }] },
  "forward.test": { mx: [{ exchange: "eforward1.registrar-servers.com", priority: 10 }] },
  "eforward1.registrar-servers.com": { a: ["127.0.0.1"] },
  "ghostmx.test": { mx: [{ exchange: "mx.ghostmx.test", priority: 10 }] },
  "empty.test": { mx: undefined },
};

// ------------------------------------------------------------ fake SMTP

// mode: "accept" | "catchall" | "nouser" | "greylist" | "blocked" | "badbanner"
function fakeSmtp(mode) {
  const server = net.createServer((sock) => {
    if (mode === "badbanner") return void sock.end("554 go away\r\n");
    sock.write("220 mx1.good.test ESMTP fake\r\n");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) sock.write("250-mx1.good.test\r\n250-SIZE 1000\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("MAIL FROM")) sock.write("250 2.1.0 OK\r\n");
        else if (cmd.startsWith("RCPT TO")) {
          const addr = line.match(/<([^>]+)>/)?.[1] ?? "";
          if (mode === "greylist") sock.write("451 4.7.1 try again later\r\n");
          else if (mode === "blocked") sock.write("550 5.7.1 our policy rejects your host\r\n");
          else if (mode === "catchall") sock.write("250 2.1.5 OK\r\n");
          else if (addr === "alice@good.test") sock.write("250 2.1.5 OK\r\n");
          else sock.write("550 5.1.1 The email account that you tried to reach does not exist\r\n");
        } else if (cmd.startsWith("QUIT")) {
          sock.end("221 bye\r\n");
        } else sock.write("500 unknown\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

// --------------------------------------------------------------- tests

test("parseAddress accepts a plain address and lowercases the domain", () => {
  assert.deepEqual(parseAddress(" Hello@Example.COM "), { email: "Hello@example.com", local: "Hello", domain: "example.com" });
});

test("parseAddress rejects junk", () => {
  assert.equal(parseAddress("nope").error, "not an email address");
  assert.equal(parseAddress("a@b").error, "not an email address");
  assert.equal(parseAddress("a@b..com").error, "malformed address");
  assert.equal(parseAddress("a@b_c.com").error, "malformed address");
  assert.equal(parseAddress("").error, "not an email address");
});

test("DNS tier: MX sorted by priority, primary resolved, secondary kept", async () => {
  const d = await checkDomain("good.test", { resolver: fakeResolver(TABLE) });
  assert.equal(d.verdict, "OK");
  assert.equal(d.mx, "mx1.good.test");
  assert.deepEqual(d.mxHosts.map((h) => h.host), ["mx1.good.test", "mx2.good.test"]);
  assert.equal(d.mxHosts[0].ip, "127.0.0.1");
});

test("DNS tier: the DEAD classes", async () => {
  const r = fakeResolver(TABLE);
  assert.match((await checkDomain("missing.test", { resolver: r })).reason, /NXDOMAIN/);
  assert.match((await checkDomain("nomx.test", { resolver: r })).reason, /no MX record; mail falls back to the A record 75.2.60.5 \(Netlify\)/);
  assert.match((await checkDomain("nullmx.test", { resolver: r })).reason, /null MX/);
  assert.match((await checkDomain("parked.test", { resolver: r })).reason, /parking host/);
  assert.match((await checkDomain("ghostmx.test", { resolver: r })).reason, /does not resolve/);
  assert.match((await checkDomain("empty.test", { resolver: r })).reason, /no MX and no A/);
  for (const d of ["missing.test", "nomx.test", "nullmx.test", "parked.test", "ghostmx.test", "empty.test"]) {
    assert.equal((await checkDomain(d, { resolver: r })).verdict, "DEAD", d);
  }
});

test("DNS tier: a forwarder MX is WEAK, not DEAD", async () => {
  const d = await checkDomain("forward.test", { resolver: fakeResolver(TABLE) });
  assert.equal(d.verdict, "WEAK");
  assert.match(d.reason, /forwarder/);
});

test("verify without SMTP: OK says the mailbox was not probed", async () => {
  const v = await verify("alice@good.test", { resolver: fakeResolver(TABLE) });
  assert.equal(v.action, "send");
  assert.equal(v.verdict, "OK");
  assert.equal(v.checks.smtp, "skipped");
  assert.equal(v.checks.mx, "mx1.good.test");
  assert.match(v.reason, /mailbox not probed/);
});

test("verify: bad syntax is kill with syntax false", async () => {
  const v = await verify("not-an-address", { resolver: fakeResolver(TABLE) });
  assert.deepEqual(v, {
    email: "not-an-address",
    action: "kill",
    verdict: "DEAD",
    reason: "not an email address",
    checks: { syntax: false, mx: null, smtp: "skipped", catch_all: null },
  });
});

test("SMTP probe: accepted mailbox is send, unknown mailbox is kill", async () => {
  const smtp = await fakeSmtp("accept");
  try {
    const opts = { resolver: fakeResolver(TABLE), smtp: true, port: smtp.port };
    const ok = await verify("alice@good.test", opts);
    assert.equal(ok.action, "send");
    assert.equal(ok.checks.smtp, "accepted");
    assert.equal(ok.checks.catch_all, false);
    assert.equal(ok.reason, "mailbox accepted by mx1.good.test");

    const gone = await verify("nobody@good.test", opts);
    assert.equal(gone.action, "kill");
    assert.equal(gone.verdict, "DEAD");
    assert.equal(gone.checks.smtp, "rejected");
    assert.match(gone.reason, /does not exist/);
  } finally {
    smtp.close();
  }
});

test("SMTP probe: catch-all is hold with catch_all true", async () => {
  const smtp = await fakeSmtp("catchall");
  try {
    const v = await verify("anyone@good.test", { resolver: fakeResolver(TABLE), smtp: true, port: smtp.port });
    assert.equal(v.action, "hold");
    assert.equal(v.checks.smtp, "accepted");
    assert.equal(v.checks.catch_all, true);
  } finally {
    smtp.close();
  }
});

test("SMTP probe: greylist and policy refusal are hold, never kill", async () => {
  for (const [mode, smtpCheck] of [["greylist", "deferred"], ["blocked", "refused"], ["badbanner", "refused"]]) {
    const smtp = await fakeSmtp(mode);
    try {
      const v = await verify("alice@good.test", { resolver: fakeResolver(TABLE), smtp: true, port: smtp.port });
      assert.equal(v.action, "hold", mode);
      assert.equal(v.checks.smtp, smtpCheck, mode);
    } finally {
      smtp.close();
    }
  }
});

test("SMTP probe: a closed port turns the tier off for the run when autoDisableSmtp is on", async () => {
  const dead = await fakeSmtp("accept");
  const port = dead.port;
  dead.close();
  await new Promise((r) => setTimeout(r, 20));
  const v = createVerifier({ resolver: fakeResolver(TABLE), smtp: true, port, smtpTimeoutMs: 2000 });
  const first = await v.verify("alice@good.test");
  assert.equal(first.action, "send");
  assert.equal(first.checks.smtp, "unreachable");
  assert.match(first.reason, /SMTP tier off for this run \(ECONNREFUSED\)/);
  assert.equal(v.state.smtpDown, true);
  const second = await v.verify("bob@good.test");
  assert.match(second.reason, /SMTP tier off/);
});

test("SMTP probe: with autoDisableSmtp off a closed port is hold for that address only", async () => {
  const dead = await fakeSmtp("accept");
  const port = dead.port;
  dead.close();
  await new Promise((r) => setTimeout(r, 20));
  const v = createVerifier({ resolver: fakeResolver(TABLE), smtp: true, port, smtpTimeoutMs: 2000, autoDisableSmtp: false });
  const r = await v.verify("alice@good.test");
  assert.equal(r.action, "hold");
  assert.equal(r.checks.smtp, "unreachable");
  assert.equal(v.state.smtpDown, false);
});

test("probeMailbox on its own returns the raw probe shape", async () => {
  const smtp = await fakeSmtp("accept");
  try {
    const p = await probeMailbox("alice@good.test", "good.test", "mx1.good.test", { hostOverride: "127.0.0.1", port: smtp.port });
    assert.deepEqual(p, { verdict: "OK", reason: "mailbox accepted by mx1.good.test", smtp: "accepted", catchAll: false });
  } finally {
    smtp.close();
  }
});

test("verifyBatch keeps order and summarize counts actions", async () => {
  const v = createVerifier({ resolver: fakeResolver(TABLE) });
  const rs = await v.verifyBatch(["a@good.test", "junk", "x@nomx.test", "y@forward.test"]);
  assert.deepEqual(rs.map((r) => r.action), ["send", "kill", "kill", "hold"]);
  assert.deepEqual(summarize(rs), { send: 1, hold: 1, kill: 2, total: 4 });
  assert.deepEqual(ACTIONS, { OK: "send", WEAK: "hold", DEAD: "kill" });
});
