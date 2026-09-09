// Live DNS tier tests. Need the network. Run with: pnpm test:live
import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/index.ts";

const live = process.env["MXPROBE_LIVE"] === "1";

test("live: gmail.com is OK at the DNS tier", { skip: !live }, async () => {
  const v = await verify("someone@gmail.com");
  assert.equal(v.verdict, "OK");
  assert.match(v.checks.mx ?? "", /google\.com$/);
});

test("live: a domain that does not exist is DEAD", { skip: !live }, async () => {
  const v = await verify("a@this-domain-does-not-exist-2b7f1c.dev");
  assert.equal(v.action, "kill");
  assert.match(v.reason, /NXDOMAIN/);
});
