import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword, verifyPassword, parseHash, delayForFails,
  timingSafeEqual, LOCK_THRESHOLD,
} from "../src/auth.js";

test("PBKDF2-SHA256 哈希往返：正确密码通过、错误密码拒绝", async () => {
  const stored = await hashPassword("S3cure!pass", 50000);
  assert.ok(parseHash(stored));
  assert.match(stored, /^pbkdf2-sha256\$50000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword("S3cure!pass", stored), true);
  assert.equal(await verifyPassword("S3cure!pasS", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("同一密码两次哈希盐不同", async () => {
  const a = await hashPassword("same-password", 50000);
  const b = await hashPassword("same-password", 50000);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

test("非法哈希串被拒绝且不抛异常（走虚拟哈希等价耗时）", async () => {
  assert.equal(parseHash("plainpassword"), null);
  assert.equal(parseHash("pbkdf2-sha256$abc$x$y"), null);
  assert.equal(await verifyPassword("whatever", "not-a-hash"), false);
  assert.equal(await verifyPassword("whatever", null), false);
});

test("分级延迟表：前两次不延迟、随后递增", () => {
  assert.equal(delayForFails(0), 0);
  assert.equal(delayForFails(1), 0);
  assert.equal(delayForFails(2), 0);
  assert.equal(delayForFails(3), 2000);
  assert.equal(delayForFails(4), 5000);
  assert.equal(delayForFails(5), 15000);
  assert.equal(delayForFails(6), 30000);
  assert.equal(delayForFails(7), 60000);
  assert.equal(delayForFails(8), 120000);
  assert.equal(delayForFails(9), 300000);
  assert.equal(delayForFails(LOCK_THRESHOLD), 300000);
  assert.equal(delayForFails(99), 300000);
});

test("常数时间比较", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});
