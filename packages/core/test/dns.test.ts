import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDomain, labelWebHost, type Resolver } from "../src/index.ts";
import { fakeResolver, nx, TABLE } from "./helpers.ts";

test("DNS tier: MX sorted by priority, primary resolved, secondary kept", async () => {
  const d = await checkDomain("good.test", { resolver: fakeResolver(TABLE) });
  assert.equal(d.verdict, "OK");
  assert.equal(d.reason, "MX mx1.good.test");
  assert.equal(d.mx, "mx1.good.test");
  assert.deepEqual(d.mxHosts, [
    { host: "mx1.good.test", ip: "127.0.0.1" },
    { host: "mx2.good.test", ip: null },
  ]);
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
    const c = await checkDomain(d, { resolver: r });
    assert.equal(c.verdict, "DEAD", d);
    assert.equal(c.mx, null, d);
    assert.deepEqual(c.mxHosts, [], d);
  }
});

test("DNS tier: a forwarder MX is WEAK, not DEAD", async () => {
  const d = await checkDomain("forward.test", { resolver: fakeResolver(TABLE) });
  assert.equal(d.verdict, "WEAK");
  assert.match(d.reason, /forwarder/);
  assert.equal(d.mx, "eforward1.registrar-servers.com");
});

test("DNS tier: MX names are lowercased and lose the trailing dot; a duplicate secondary is dropped", async () => {
  const r = fakeResolver({
    "x.test": { mx: [{ exchange: "MX.X.TEST.", priority: 10 }, { exchange: "mx.x.test", priority: 20 }] },
    "mx.x.test": { a: ["192.0.2.9"] },
  });
  const d = await checkDomain("x.test", { resolver: r });
  assert.equal(d.mx, "mx.x.test");
  assert.deepEqual(d.mxHosts, [{ host: "mx.x.test", ip: "192.0.2.9" }]);
});

test("DNS tier: an IPv6-only MX host resolves through AAAA", async () => {
  const r = fakeResolver({ "six.test": { mx: [{ exchange: "mx.six.test", priority: 0 }] }, "mx.six.test": { aaaa: ["2001:db8::25"] } });
  const d = await checkDomain("six.test", { resolver: r });
  assert.equal(d.verdict, "OK");
  assert.deepEqual(d.mxHosts, [{ host: "mx.six.test", ip: "2001:db8::25" }]);
});

test("DNS tier: a web host behind the A record is named from the reverse name", async () => {
  const r = fakeResolver({ "site.test": { mx: undefined, a: ["203.0.113.7"], ptr: "lb-3.vercel-dns.example" } });
  const d = await checkDomain("site.test", { resolver: r });
  assert.equal(d.verdict, "DEAD");
  assert.match(d.reason, /203\.0\.113\.7 \(Vercel\)/);
});

test("DNS tier: a resolver failure other than NXDOMAIN or ENODATA is DEAD with the code", async () => {
  const r: Resolver = { ...fakeResolver(TABLE), resolveMx: async () => Promise.reject(nx("ESERVFAIL")) };
  const d = await checkDomain("good.test", { resolver: r });
  assert.equal(d.verdict, "DEAD");
  assert.equal(d.reason, "MX lookup failed (ESERVFAIL)");
});

test("DNS tier: an MX lookup that times out is treated as no MX", async () => {
  const r: Resolver = { ...fakeResolver(TABLE), resolveMx: () => new Promise(() => {}) };
  const d = await checkDomain("empty.test", { resolver: r, dnsTimeoutMs: 30 });
  assert.equal(d.verdict, "DEAD");
  assert.equal(d.reason, "no MX and no A/AAAA record");
});

test("DNS tier: a reverse lookup that hangs does not block the verdict", async () => {
  const r: Resolver = { ...fakeResolver(TABLE), reverse: () => new Promise(() => {}) };
  const d = await checkDomain("nomx.test", { resolver: r, dnsTimeoutMs: 30 });
  assert.match(d.reason, /\(Netlify\)/, "the IP alone names Netlify");
});

test("DNS tier: an A lookup that hangs rejects, so the driver can report it", async () => {
  const r: Resolver = { ...fakeResolver(TABLE), resolve4: () => new Promise(() => {}), resolve6: () => new Promise(() => {}) };
  await assert.rejects(checkDomain("empty.test", { resolver: r, dnsTimeoutMs: 30 }), /A\/AAAA: timed out after 30 ms/);
});

test("labelWebHost knows the big hosts by IP and by reverse name", () => {
  assert.equal(labelWebHost("75.2.60.5", null), "Netlify");
  assert.equal(labelWebHost("1.2.3.4", "x.netlify.com"), "Netlify");
  assert.equal(labelWebHost("76.76.21.21", null), "Vercel");
  assert.equal(labelWebHost("104.21.5.5", null), "Cloudflare");
  assert.equal(labelWebHost("1.2.3.4", "ec2-1-2-3-4.compute.amazonaws.com"), "AWS");
  assert.equal(labelWebHost("1.2.3.4", "pages.github.io"), "GitHub Pages");
  assert.equal(labelWebHost("1.2.3.4", "proxy.webflow.com"), "site builder");
  assert.equal(labelWebHost("1.2.3.4", "some.host.example"), "some.host.example");
  assert.equal(labelWebHost("1.2.3.4", null), "unknown host");
});
