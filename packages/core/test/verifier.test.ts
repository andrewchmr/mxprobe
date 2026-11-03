import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { ACTIONS, DEFAULTS, VERDICTS, createVerifier, mailProvider, resolveOptions, summarize, verify, verifyBatch, type Resolver } from "../src/index.ts";
import { closedPort, fakeResolver, fakeSmtp, NO_USER, OK_RCPT, TABLE } from "./helpers.ts";

const resolver = fakeResolver(TABLE);

test("verify without SMTP: OK says the mailbox was not probed", async () => {
  const v = await verify("alice@good.test", { resolver });
  assert.equal(v.action, "send");
  assert.equal(v.verdict, "OK");
  assert.equal(v.checks.smtp, "skipped");
  assert.equal(v.checks.mx, "mx1.good.test");
  assert.match(v.reason, /mailbox not probed/);
});

test("verify without SMTP: a forwarder is hold and a DNS-dead domain is kill", async () => {
  const fwd = await verify("x@forward.test", { resolver });
  assert.equal(fwd.action, "hold");
  assert.equal(fwd.checks.mx, "eforward1.registrar-servers.com");
  assert.doesNotMatch(fwd.reason, /not probed/);
  const dead = await verify("x@nomx.test", { resolver });
  assert.equal(dead.action, "kill");
  assert.deepEqual(dead.checks, { syntax: true, mx: null, provider: null, smtp: "skipped", catch_all: null });
});

test("verify: bad syntax is kill with syntax false", async () => {
  const v = await verify("not-an-address", { resolver });
  assert.deepEqual(v, {
    email: "not-an-address",
    action: "kill",
    verdict: "DEAD",
    reason: "not an email address",
    checks: { syntax: false, mx: null, provider: null, smtp: "skipped", catch_all: null },
  });
});

test("verify: the result carries the normalised address", async () => {
  const v = await verify("  Alice@GOOD.test ", { resolver });
  assert.equal(v.email, "Alice@good.test");
});

test("verify: a DNS step that hangs is hold with 'check did not finish'", async () => {
  const hanging: Resolver = { ...resolver, resolve4: () => new Promise(() => {}), resolve6: () => new Promise(() => {}) };
  const v = await verify("a@empty.test", { resolver: hanging, dnsTimeoutMs: 30 });
  assert.equal(v.action, "hold");
  assert.match(v.reason, /check did not finish \(A\/AAAA: timed out after 30 ms\)/);
});

test("SMTP probe: accepted mailbox is send, unknown mailbox is kill", async () => {
  const smtp = await fakeSmtp("accept");
  try {
    const opts = { resolver, smtp: true, port: smtp.port };
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
    const v = await verify("anyone@good.test", { resolver, smtp: true, port: smtp.port });
    assert.equal(v.action, "hold");
    assert.equal(v.checks.smtp, "accepted");
    assert.equal(v.checks.catch_all, true);
  } finally {
    smtp.close();
  }
});

test("SMTP probe: greylist and policy refusal are hold, never kill", async () => {
  for (const [mode, smtpCheck] of [
    ["greylist", "deferred"],
    ["blocked", "refused"],
    ["badbanner", "refused"],
  ] as const) {
    const smtp = await fakeSmtp(mode);
    try {
      const v = await verify("alice@good.test", { resolver, smtp: true, port: smtp.port });
      assert.equal(v.action, "hold", mode);
      assert.equal(v.checks.smtp, smtpCheck, mode);
    } finally {
      smtp.close();
    }
  }
});

test("SMTP probe: a forwarder that accepts stays hold and the reason keeps both findings", async () => {
  const smtp = await fakeSmtp({ rcpt: (addr) => (addr === "x@forward.test" ? OK_RCPT : "550 5.1.1 no\r\n") });
  try {
    const v = await verify("x@forward.test", { resolver, smtp: true, port: smtp.port });
    assert.equal(v.action, "hold", "DNS WEAK outranks SMTP OK");
    assert.equal(v.checks.smtp, "accepted");
    assert.match(v.reason, /^mailbox accepted by eforward1\.registrar-servers\.com; MX .* is a forwarder/);
  } finally {
    smtp.close();
  }
});

test("SMTP probe: a forwarder that rejects the mailbox is kill", async () => {
  const smtp = await fakeSmtp({ rcpt: () => "550 5.1.1 no such user\r\n" });
  try {
    const v = await verify("x@forward.test", { resolver, smtp: true, port: smtp.port });
    assert.equal(v.action, "kill");
    assert.equal(v.checks.smtp, "rejected");
  } finally {
    smtp.close();
  }
});

test("SMTP probe: a closed port turns the tier off for the run when autoDisableSmtp is on", async () => {
  const port = await closedPort();
  const v = createVerifier({ resolver, smtp: true, port, smtpTimeoutMs: 2000 });
  const first = await v.verify("alice@good.test");
  assert.equal(first.action, "send");
  assert.equal(first.checks.smtp, "unreachable");
  assert.match(first.reason, /SMTP tier off for this run \(ECONNREFUSED\)/);
  assert.deepEqual(v.state, { smtpDown: true, smtpDownWhy: `ECONNREFUSED on mx1.good.test:${port}` });
  const second = await v.verify("bob@good.test");
  assert.match(second.reason, /SMTP tier off for this run \(ECONNREFUSED on mx1\.good\.test:\d+\)/);
  assert.equal(second.checks.smtp, "unreachable");
});

test("SMTP probe: with autoDisableSmtp off a closed port is hold for that address only", async () => {
  const port = await closedPort();
  const v = createVerifier({ resolver, smtp: true, port, smtpTimeoutMs: 2000, autoDisableSmtp: false });
  const r = await v.verify("alice@good.test");
  assert.equal(r.action, "hold");
  assert.equal(r.checks.smtp, "unreachable");
  assert.equal(v.state.smtpDown, false);
});

test("SMTP probe: the concurrency cap holds across a batch", async () => {
  const smtp = await fakeSmtp("catchall");
  try {
    const v = createVerifier({ resolver, smtp: true, port: smtp.port, smtpConcurrency: 2 });
    const rs = await v.verifyBatch(Array.from({ length: 6 }, (_, i) => `u${i}@good.test`));
    assert.ok(rs.every((r) => r.checks.smtp === "accepted"));
    assert.equal(smtp.maxActive, 2);
  } finally {
    smtp.close();
  }
});

test("verifyBatch keeps order and summarize counts actions", async () => {
  const v = createVerifier({ resolver });
  const rs = await v.verifyBatch(["a@good.test", "junk", "x@nomx.test", "y@forward.test"]);
  assert.deepEqual(
    rs.map((r) => r.action),
    ["send", "kill", "kill", "hold"],
  );
  assert.deepEqual(summarize(rs), { send: 1, hold: 1, kill: 2, total: 4 });
  assert.deepEqual(summarize([]), { send: 0, hold: 0, kill: 0, total: 0 });
  assert.deepEqual(ACTIONS, { OK: "send", WEAK: "hold", DEAD: "kill" });
  assert.deepEqual(VERDICTS, ["OK", "WEAK", "DEAD"]);
});

test("one-shot verifyBatch matches createVerifier().verifyBatch", async () => {
  const a = await verifyBatch(["a@good.test", "junk"], { resolver });
  const b = await createVerifier({ resolver }).verifyBatch(["a@good.test", "junk"]);
  assert.deepEqual(a, b);
});

test("every result has the full checks shape", async () => {
  const rs = await verifyBatch(["a@good.test", "junk", "x@nomx.test"], { resolver });
  for (const r of rs) {
    assert.deepEqual(Object.keys(r), ["email", "action", "verdict", "reason", "checks"]);
    assert.deepEqual(Object.keys(r.checks), ["syntax", "mx", "provider", "smtp", "catch_all"]);
    assert.equal(r.action, ACTIONS[r.verdict]);
  }
});

test("resolveOptions: defaults under the caller's options, undefined keeps the default", () => {
  assert.equal(DEFAULTS.smtp, false);
  assert.equal(DEFAULTS.port, 25);
  const o = resolveOptions({ smtp: true, port: undefined, helo: "h.test" });
  assert.equal(o.smtp, true);
  assert.equal(o.port, 25);
  assert.equal(o.helo, "h.test");
  assert.equal(o.resolver, DEFAULTS.resolver);
  assert.equal(createVerifier({ dnsConcurrency: 7 }).options.dnsConcurrency, 7);
});

test("defaults: the local probe names this machine in EHLO and sends the null sender", async () => {
  assert.equal(DEFAULTS.helo, hostname() || "localhost");
  assert.equal(DEFAULTS.from, "");
  const smtp = await fakeSmtp("accept");
  try {
    await verify("alice@good.test", { resolver, smtp: true, port: smtp.port });
    assert.equal(smtp.commands[0], `EHLO ${DEFAULTS.helo}`);
    assert.equal(smtp.commands[1], "MAIL FROM:<>");
  } finally {
    smtp.close();
  }
});

test("mailProvider: named from the MX host; Google's MX is Gmail only for the Gmail domains", () => {
  const cases: Array<[string, string, string | null]> = [
    ["gmail-smtp-in.l.google.com", "gmail.com", "gmail"],
    ["gmail-smtp-in.l.google.com", "GoogleMail.com", "gmail"],
    ["aspmx.l.google.com", "acme.com", "google_workspace"],
    ["smtp.google.com", "acme.com", "google_workspace"],
    ["aspmx2.googlemail.com", "acme.com", "google_workspace"],
    ["acme-com.mail.protection.outlook.com", "acme.com", "microsoft_365"],
    ["acme-com.o-v1.mx.microsoft", "acme.com", "microsoft_365"],
    ["outlook-com.olc.protection.outlook.com", "outlook.com", "outlook"],
    ["mta6.am0.yahoodns.net", "yahoo.com", "yahoo"],
    ["mx01.mail.icloud.com", "icloud.com", "icloud"],
    ["mxs.mail.ru", "mail.ru", "mailru"],
    ["mx.yandex.net", "acme.ru", "yandex"],
    ["mx.zoho.eu", "acme.eu", "zoho"],
    ["mail.protonmail.ch", "proton.me", "proton"],
    ["in1-smtp.messagingengine.com", "fastmail.com", "fastmail"],
    ["mx1.privateemail.com", "acme.com", "privateemail"],
    ["smtp.secureserver.net", "acme.com", "godaddy"],
    ["mx0a-001b2d01.pphosted.com", "acme.com", "proofpoint"],
    ["mx1-us1.ppe-hosted.com", "acme.com", "proofpoint"],
    ["us-smtp-inbound-1.mimecast.com", "acme.com", "mimecast"],
    ["d123456a.ess.barracudanetworks.com", "acme.com", "barracuda"],
    ["mx1.hc1234-56.iphmx.com", "acme.com", "cisco"],
    ["mail.acme.com", "acme.com", null],
    ["mx.notgoogle.com", "acme.com", null],
  ];
  for (const [mx, domain, want] of cases) assert.equal(mailProvider(mx, domain), want, `${mx} for ${domain}`);
});

test("verify: checks.provider comes from the primary MX, on the DNS tier too", async () => {
  const r = fakeResolver({ "acme.test": { mx: [{ exchange: "ASPMX.L.GOOGLE.COM.", priority: 1 }] }, "aspmx.l.google.com": { a: ["192.0.2.25"] } });
  const v = await verify("x@acme.test", { resolver: r });
  assert.equal(v.checks.mx, "aspmx.l.google.com");
  assert.equal(v.checks.provider, "google_workspace");
  assert.equal((await verify("a@good.test", { resolver })).checks.provider, null, "an MX that is not a known provider");
});

test("verifyBatch: one DNS lookup per domain; verify() calls share nothing", async () => {
  const lookups: string[] = [];
  const counting: Resolver = { ...resolver, resolveMx: (d) => (lookups.push(d), resolver.resolveMx(d)) };
  const v = createVerifier({ resolver: counting });
  const rs = await v.verifyBatch(["a@good.test", "b@good.test", "c@GOOD.test", "x@nomx.test", "y@nomx.test"]);
  assert.deepEqual(rs.map((r) => r.action), ["send", "send", "send", "kill", "kill"]);
  assert.deepEqual(lookups.sort(), ["good.test", "nomx.test"]);
  lookups.length = 0;
  await v.verify("a@good.test");
  await v.verify("b@good.test");
  assert.deepEqual(lookups, ["good.test", "good.test"]);
});

test("verifyBatch: the catch-all test runs once per domain", async () => {
  const real = new Set(["a@good.test", "b@good.test", "c@good.test"]);
  const smtp = await fakeSmtp({ rcpt: (addr) => (real.has(addr) ? OK_RCPT : NO_USER) });
  try {
    const v = createVerifier({ resolver, smtp: true, port: smtp.port, smtpConcurrency: 1 });
    const rs = await v.verifyBatch([...real]);
    assert.ok(rs.every((r) => r.action === "send" && r.checks.catch_all === false));
    assert.equal(smtp.commands.filter((c) => /-probe@good\.test>$/.test(c)).length, 1);
  } finally {
    smtp.close();
  }
  const all = await fakeSmtp("catchall");
  try {
    const v = createVerifier({ resolver, smtp: true, port: all.port, smtpConcurrency: 1 });
    const rs = await v.verifyBatch(["a@good.test", "b@good.test"]);
    assert.ok(rs.every((r) => r.action === "hold" && r.checks.catch_all === true));
    assert.equal(all.commands.filter((c) => /-probe@good\.test>$/.test(c)).length, 1);
  } finally {
    all.close();
  }
});

test("verifyBatch: an MX that times out is not asked again in the same batch", async () => {
  const slowTable = fakeResolver({ "slow.test": { mx: [{ exchange: "mx.slow.test", priority: 10 }] }, "mx.slow.test": { a: ["127.0.0.1"] } });
  const smtp = await fakeSmtp({ banner: null });
  try {
    const v = createVerifier({ resolver: slowTable, smtp: true, port: smtp.port, smtpTimeoutMs: 300, smtpConcurrency: 1 });
    const rs = await v.verifyBatch(["a@slow.test", "b@slow.test", "c@slow.test"]);
    assert.deepEqual(rs.map((r) => r.action), ["hold", "hold", "hold"]);
    assert.equal(rs[0]?.checks.smtp, "dropped");
    assert.match(rs[0]?.reason ?? "", /ETIMEDOUT/);
    for (const r of rs.slice(1)) {
      assert.equal(r.checks.smtp, "unreachable");
      assert.equal(r.reason, "mx.slow.test timed out earlier in this batch, so it was not asked again");
    }
    assert.equal(smtp.connections, 1);
    await v.verifyBatch(["d@slow.test"]);
    assert.equal(smtp.connections, 2, "the next batch asks again");
  } finally {
    smtp.close();
  }
});
