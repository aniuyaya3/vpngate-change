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

// 1. 未配置：根路径与登录页都跳转设置向导
{
  const r = await fetch(`${BASE}/`, { redirect: "manual", headers: UA });
  check("未配置时 / 跳转 /setup", r.status === 302 && (r.headers.get("location") || "").includes("/setup"), `got ${r.status} ${r.headers.get("location")}`);
  const l = await fetch(`${BASE}/login`, { redirect: "manual", headers: UA });
  check("未配置时 /login 跳转 /setup", l.status === 302 && (l.headers.get("location") || "").includes("/setup"), `got ${l.status}`);
  const s = await fetch(`${BASE}/setup`, { headers: UA });
  const html = await s.text();
  check("设置向导页 200 且含表单", s.status === 200 && html.includes("设置管理员密码"), `got ${s.status}`);
}

// 2. 校验：两次不一致 / 太短都拒绝
{
  const bad1 = await fetch(`${BASE}/setup`, { method: "POST", headers: FORM, body: form({ password: SETUP_PASS, password2: SETUP_PASS + "x" }) });
  check("两次密码不一致返回 400", bad1.status === 400, `got ${bad1.status}`);
  const bad2 = await fetch(`${BASE}/setup`, { method: "POST", headers: FORM, body: form({ password: "short7", password2: "short7" }) });
  check("密码少于 8 位返回 400", bad2.status === 400, `got ${bad2.status}`);
}

// 3. 正确设置：成功页给出变量名与 PBKDF2 哈希，并自动登录
let cookie = "";
{
  const r = await fetch(`${BASE}/setup`, { method: "POST", headers: FORM, body: form({ password: SETUP_PASS, password2: SETUP_PASS }) });
  const html = await r.text();
  check("设置成功返回 200", r.status === 200, `got ${r.status}`);
  check("成功页给出变量名 ADMIN_PASS_HASH", html.includes("ADMIN_PASS_HASH"));
  check("成功页给出 pbkdf2-sha256 哈希", /pbkdf2-sha256\$210000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+/.test(html));
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
