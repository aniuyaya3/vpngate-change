// 首次部署设置向导端到端测试：对「未配置任何管理员凭证」的实例运行
// 用法：BASE_URL=http://127.0.0.1:8789 node tests/setup.e2e.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:8789";
const SETUP_PASS = process.env.SETUP_PASS || "SetupTest!456";
const UA = { "User-Agent": "setup-e2e/1.0" };

let passed = 0;
function check(name, cond, extra = "") {
  if (!cond) { console.error(`FAIL: ${name} ${extra}`); process.exit(1); }
  passed++; console.log(`ok: ${name}`);
}
const form = (obj) => new URLSearchParams(obj).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded", ...UA };

async function freshNonce() {
  const s = await fetch(`${BASE}/setup`, { headers: UA });
  const html = await s.text();
  const m = html.match(/name="nonce" value="([^"]+)"/);
  if (!m) { console.error("FAIL: 设置页未找到 nonce"); process.exit(1); }
  return m[1];
}
const postSetup = (fields, headers = FORM) =>
  fetch(`${BASE}/setup`, { method: "POST", headers, body: form(fields) });

// 1. 未配置：根路径与登录页都跳转设置向导
{
  const r = await fetch(`${BASE}/`, { redirect: "manual", headers: UA });
  check("未配置时 / 跳转 /setup", r.status === 302 && (r.headers.get("location") || "").includes("/setup"), `got ${r.status} ${r.headers.get("location")}`);
  const l = await fetch(`${BASE}/login`, { redirect: "manual", headers: UA });
  check("未配置时 /login 跳转 /setup", l.status === 302 && (l.headers.get("location") || "").includes("/setup"), `got ${l.status}`);
  const s = await fetch(`${BASE}/setup`, { headers: UA });
  const html = await s.text();
  check("设置向导页 200 且含表单与 nonce", s.status === 200 && html.includes("设置管理员密码") && html.includes('name="nonce"'), `got ${s.status}`);
}

// 2. 校验：无 nonce / 两次不一致 / 太短都拒绝
{
  const noNonce = await postSetup({ password: SETUP_PASS, password2: SETUP_PASS });
  check("无 nonce 提交返回 400", noNonce.status === 400, `got ${noNonce.status}`);
  // 无状态 nonce 回归：连续打开两次设置页，用第一次的 nonce 提交仍应有效
  //（旧版单槽存储会被第二次打开冲掉，误报「页面已过期」）
  const nonceA = await freshNonce();
  await freshNonce();
  const bad1 = await postSetup({ password: SETUP_PASS, password2: SETUP_PASS + "x", nonce: nonceA });
  const bad1Text = await bad1.text();
  check("两次密码不一致返回 400", bad1.status === 400, `got ${bad1.status}`);
  check("旧 nonce 不被后一次打开冲掉（报不一致而非已过期）", bad1Text.includes("两次输入的密码不一致"), bad1Text.slice(0, 80));
  const bad2 = await postSetup({ password: "short7", password2: "short7", nonce: await freshNonce() });
  check("密码少于 8 位返回 400", bad2.status === 400, `got ${bad2.status}`);
}

// 3. 正确设置（特意带一个与 Host 不一致的 Origin，模拟自定义域名/反代访问）：
//    不应再返回 Bad Origin；成功页给出变量名与哈希，并自动登录
let cookie = "";
{
  const r = await postSetup(
    { password: SETUP_PASS, password2: SETUP_PASS, nonce: await freshNonce() },
    { ...FORM, Origin: "https://public-domain.example" });
  const html = await r.text();
  check("Origin 与 Host 不一致时设置成功 200（无 Bad Origin）", r.status === 200, `got ${r.status}`);
  check("成功页给出变量名 ADMIN_PASS_HASH", html.includes("ADMIN_PASS_HASH"));
  check("成功页给出 pbkdf2-sha256 哈希", /pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+/.test(html));
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  check("设置后自动签发 session", cookie.includes("session="), cookie);
  const dash = await fetch(`${BASE}/`, { headers: { Cookie: cookie, ...UA } });
  check("设置后可直接进入面板", dash.status === 200, `got ${dash.status}`);
}

// 4. 设置后向导永久关闭
{
  const s = await fetch(`${BASE}/setup`, { redirect: "manual", headers: UA });
  check("设置后 /setup 跳转 /login", s.status === 302 && (s.headers.get("location") || "").includes("/login"), `got ${s.status} ${s.headers.get("location")}`);
  const root = await fetch(`${BASE}/`, { redirect: "manual", headers: UA });
  check("设置后 / 跳转 /login 而非 /setup", root.status === 302 && (root.headers.get("location") || "").includes("/login"), `got ${root.status} ${root.headers.get("location")}`);
}

// 5. 无任何 secret 时，仅靠向导存入 D1 的哈希即可登录（登出后重登）
{
  const out = await fetch(`${BASE}/logout`, { headers: { Cookie: cookie, ...UA }, redirect: "manual" });
  check("登出 302", out.status === 302, `got ${out.status}`);
  const bad = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json", ...UA }, body: JSON.stringify({ username: "admin", password: "wrong-password" }) });
  check("错误密码 401", bad.status === 401, `got ${bad.status}`);
  const good = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json", ...UA }, body: JSON.stringify({ username: "admin", password: SETUP_PASS }) });
  check("向导密码可正常登录 200", good.status === 200, `got ${good.status}`);
}

console.log(`\n设置向导 E2E 全部通过：${passed} 项`);
