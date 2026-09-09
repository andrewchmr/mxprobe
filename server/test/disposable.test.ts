import { test } from "node:test";
import assert from "node:assert/strict";
import { isDisposableDomain } from "../src/disposable.ts";

test("disposable list matches subdomains", () => {
  assert.equal(isDisposableDomain("mailinator.com"), true);
  assert.equal(isDisposableDomain("x.yopmail.com"), true);
  assert.equal(isDisposableDomain("a.b.c.guerrillamail.org"), true);
  assert.equal(isDisposableDomain("gmail.com"), false);
});

test("disposable list is case-insensitive and does not match look-alikes", () => {
  assert.equal(isDisposableDomain("MailInator.COM"), true);
  assert.equal(isDisposableDomain("notmailinator.com"), false, "a suffix match is not a subdomain");
  assert.equal(isDisposableDomain("mailinator.com.example"), false, "a listed name in the middle is not a match");
  assert.equal(isDisposableDomain("com"), false);
  assert.equal(isDisposableDomain(""), false);
});
