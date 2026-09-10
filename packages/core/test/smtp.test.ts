import { test } from "node:test";
import assert from "node:assert/strict";
import { probeMailbox, type ProbeOptions } from "../src/index.ts";
import { closedPort, fakeSmtp, NO_USER, OK_RCPT, type FakeSmtpOptions } from "./helpers.ts";

const local = (port: number, extra: ProbeOptions = {}): ProbeOptions => ({ hostOverride: "127.0.0.1", port, smtpTimeoutMs: 2000, helo: "probe.test", from: "probe@probe.test", ...extra });

async function probe(opts: FakeSmtpOptions | "accept" | "catchall" | "greylist" | "blocked" | "badbanner", email = "alice@good.test", extra: ProbeOptions = {}) {
  const smtp = await fakeSmtp(opts);
  try {
    const result = await probeMailbox(email, "good.test", "mx1.good.test", local(smtp.port, extra));
    return { result, commands: smtp.commands };
  } finally {
    smtp.close();
  }
}

test("probeMailbox: an accepted mailbox is OK and the session is EHLO, MAIL, RCPT, RCPT, QUIT", async () => {
  const { result, commands } = await probe("accept");
  assert.deepEqual(result, { verdict: "OK", reason: "mailbox accepted by mx1.good.test", smtp: "accepted", catchAll: false });
  assert.deepEqual(
    commands.map((c) => c.split(":")[0]),
    ["EHLO probe.test", "MAIL FROM", "RCPT TO", "RCPT TO", "QUIT"],
  );
  assert.equal(commands[1], "MAIL FROM:<probe@probe.test>");
  assert.equal(commands[2], "RCPT TO:<alice@good.test>");
  assert.match(commands[3] ?? "", /^RCPT TO:<[0-9a-f]{12}-probe@good\.test>$/, "the catch-all test uses a random local part");
});

test("probeMailbox: an unknown mailbox is DEAD only when the 5xx names the mailbox", async () => {
  const gone = await probe("accept", "nobody@good.test");
  assert.equal(gone.result.verdict, "DEAD");
  assert.equal(gone.result.smtp, "rejected");
  assert.match(gone.result.reason, /does not exist \(550 5\.1\.1/);

  const policy = await probe("blocked");
  assert.equal(policy.result.verdict, "WEAK");
  assert.equal(policy.result.smtp, "refused");
  assert.match(policy.result.reason, /refused the probe, not the mailbox/);
});

test("probeMailbox: every no-such-mailbox phrasing kills, an unrelated 5xx does not", async () => {
  const phrasings = ["550 User unknown", "550 5.1.1 no such user here", "550 Recipient address rejected: unknown", "550 mailbox unavailable", "554 5.4.1 Recipient address rejected: Access denied"];
  for (const line of phrasings) {
    const { result } = await probe({ rcpt: () => `${line}\r\n` });
    assert.equal(result.smtp, "rejected", line);
  }
  const { result } = await probe({ rcpt: () => "550 5.7.606 Access denied, banned sending IP\r\n" });
  assert.equal(result.smtp, "refused");
});

test("probeMailbox: a catch-all server is WEAK with catchAll true", async () => {
  const { result } = await probe("catchall", "anyone@good.test");
  assert.deepEqual(result, { verdict: "WEAK", reason: "good.test is catch-all: mx1.good.test accepts any local part, so the mailbox cannot be proven", smtp: "accepted", catchAll: true });
});

test("probeMailbox: 251 (will forward) counts as accepted", async () => {
  const { result } = await probe({ rcpt: (addr) => (addr === "alice@good.test" ? "251 2.1.5 User not local; will forward\r\n" : NO_USER) });
  assert.equal(result.smtp, "accepted");
  assert.equal(result.catchAll, false);
});

test("probeMailbox: a 4xx on RCPT is deferred, a 4xx on MAIL FROM too", async () => {
  const grey = await probe("greylist");
  assert.equal(grey.result.smtp, "deferred");
  assert.match(grey.result.reason, /deferred \(451 4\.7\.1 try again later\)/);

  const sender = await probe({ mailFrom: "450 4.1.8 sender address rejected: domain not found\r\n" });
  assert.equal(sender.result.smtp, "deferred");
  assert.match(sender.result.reason, /deferred the sender/);
  assert.ok(!sender.commands.some((c) => c.startsWith("RCPT")), "no RCPT after a refused sender");
});

test("probeMailbox: a 5xx on MAIL FROM or a bad banner is refused", async () => {
  const sender = await probe({ mailFrom: "550 5.7.1 sender blocked\r\n" });
  assert.equal(sender.result.smtp, "refused");
  assert.match(sender.result.reason, /refused the sender/);

  const banner = await probe("badbanner");
  assert.equal(banner.result.smtp, "refused");
  assert.match(banner.result.reason, /greeted with 554 go away/);
});

test("probeMailbox: falls back to HELO when EHLO is refused; refused HELO is refused", async () => {
  const fallback = await probe({ ehlo: "502 5.5.2 command not implemented\r\n" });
  assert.equal(fallback.result.smtp, "accepted");
  assert.deepEqual(fallback.commands.slice(0, 2), ["EHLO probe.test", "HELO probe.test"]);

  const none = await probe({ ehlo: "502 nope\r\n", helo: "502 nope\r\n" });
  assert.equal(none.result.smtp, "refused");
  assert.match(none.result.reason, /refused HELO/);
});

test("probeMailbox: a multi-line reply is one reply and the reason quotes its first line", async () => {
  const { result } = await probe({ rcpt: () => "550-5.1.1 The email account\r\n550-5.1.1 that you tried to reach\r\n550 5.1.1 does not exist\r\n" }, "nobody@good.test");
  assert.equal(result.smtp, "rejected");
  assert.match(result.reason, /\(550-5\.1\.1 The email account\)$/);
});

test("probeMailbox: a server that hangs up mid-session is dropped, not DEAD", async () => {
  const { result } = await probe({ dropAfter: "RCPT TO" });
  assert.equal(result.verdict, "WEAK");
  assert.equal(result.smtp, "dropped");
  assert.match(result.reason, /dropped the session \(ECLOSED\)/);
});

test("probeMailbox: a server that never sends a banner times out as dropped", async () => {
  // The budget also covers the connect, which can be slow on a loaded machine; keep it generous.
  const { result } = await probe({ banner: null }, "alice@good.test", { smtpTimeoutMs: 400 });
  assert.equal(result.smtp, "dropped");
  assert.match(result.reason, /ETIMEDOUT/);
});

test("probeMailbox: a closed port is unreachable with the connect error code", async () => {
  const port = await closedPort();
  const result = await probeMailbox("alice@good.test", "good.test", "mx1.good.test", local(port));
  assert.deepEqual(result, { verdict: "WEAK", reason: `cannot connect to mx1.good.test:${port} (ECONNREFUSED)`, smtp: "unreachable", catchAll: null, connectError: "ECONNREFUSED" });
});

test("probeMailbox: hostOverride wins over connectHost, which wins over the MX name", async () => {
  const smtp = await fakeSmtp({ rcpt: () => OK_RCPT });
  try {
    const viaOverride = await probeMailbox("a@good.test", "good.test", "mx.nowhere.invalid", { hostOverride: "127.0.0.1", connectHost: "also.nowhere.invalid", port: smtp.port, smtpTimeoutMs: 2000 });
    assert.equal(viaOverride.smtp, "accepted");
    const viaConnect = await probeMailbox("a@good.test", "good.test", "mx.nowhere.invalid", { connectHost: "127.0.0.1", port: smtp.port, smtpTimeoutMs: 2000 });
    assert.equal(viaConnect.smtp, "accepted");
    assert.match(viaConnect.reason, /catch-all: mx\.nowhere\.invalid accepts/, "the reason names the MX, not the IP");
  } finally {
    smtp.close();
  }
});
