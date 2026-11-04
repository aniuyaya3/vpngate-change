#!/usr/bin/env node
// 生成管理员密码的 PBKDF2-SHA256 哈希串，用于 wrangler secret：
//   node tools/hash-password.mjs '你的密码'
//   npx wrangler secret put ADMIN_PASS_HASH   # 粘贴输出
// 可选环境变量 PBKDF2_ITERATIONS（50000–1000000，默认 210000）
const password = process.argv[2];
if (!password) {
  console.error("用法: node tools/hash-password.mjs '<密码>'");
  process.exit(1);
}
const iterations = (() => {
  const n = parseInt(process.env.PBKDF2_ITERATIONS, 10);
  return Number.isInteger(n) && n >= 50000 && n <= 1000000 ? n : 210000;
})();
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
const b64 = (u) => Buffer.from(u).toString("base64");
console.log(`pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
