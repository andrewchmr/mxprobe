import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress } from "../src/index.ts";

test("parseAddress accepts a plain address and lowercases the domain", () => {
  assert.deepEqual(parseAddress(" Hello@Example.COM "), { email: "Hello@example.com", local: "Hello", domain: "example.com" });
});

test("parseAddress keeps the local part's case and strips a trailing dot", () => {
  const p = parseAddress("First.Last+tag@Sub.Example.org.");
  assert.equal(p.error, undefined);
  assert.equal(p.email, "First.Last+tag@sub.example.org");
  assert.equal(p.local, "First.Last+tag");
  assert.equal(p.domain, "sub.example.org");
});

test("parseAddress rejects junk", () => {
  assert.equal(parseAddress("nope").error, "not an email address");
  assert.equal(parseAddress("a@b").error, "not an email address");
  assert.equal(parseAddress("a@b..com").error, "malformed address");
  assert.equal(parseAddress("a@b_c.com").error, "malformed address");
  assert.equal(parseAddress("").error, "not an email address");
  assert.equal(parseAddress("two@at@b.com").error, "not an email address");
  assert.equal(parseAddress("has space@b.com").error, "not an email address");
});

test("parseAddress enforces the length limits", () => {
  assert.equal(parseAddress(`${"a".repeat(64)}@b.com`).error, undefined);
  assert.equal(parseAddress(`${"a".repeat(65)}@b.com`).error, "malformed address");
  const label = "b".repeat(63);
  const longDomain = `${label}.${label}.${label}.${label}.com`;
  assert.ok(longDomain.length > 253);
  assert.equal(parseAddress(`a@${longDomain}`).error, "malformed address");
});

test("parseAddress takes anything and echoes it back as the email", () => {
  assert.deepEqual(parseAddress(undefined), { email: "", error: "not an email address" });
  assert.deepEqual(parseAddress(null), { email: "", error: "not an email address" });
  assert.deepEqual(parseAddress(42), { email: "42", error: "not an email address" });
});
