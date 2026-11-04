// 端到端测试：对 wrangler dev 起的本地实例跑完整登录/鉴权链路
// 用法：BASE_URL=http://127.0.0.1:8787 ADMIN_PASS=... AGENT_TOKEN=... node tests/e2e.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "AdminTest!234";
const AGENT_USER = process.env.AGENT_USER || "agent";
const AGENT_TOKEN = process.env.AGENT_TOKEN || "agent-token-test-0123456789";
const UA = { "User-Agent": "e2e-test/1.0" };

let passed = 0;
function check(name, cond, extra = "") {
  if (!cond) { console.error(`FAIL: ${name} ${extra}`); process.exit(1); }
  passed++; console.log(`ok: ${name}`);
}
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginJson(user, pass, headers = {}) {
  return fetch(`${BASE}/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", ...UA, ...headers },
    body: JSON.stringify({ username: user, password: pass }),
  });
}

// 1. 未登录：面板跳转登录页，管理员 API 401
{
  const r = await fetch(`${BASE}/`, { redirect: "manual", headers: UA });
  check("未登录访问 / 跳转 /login", r.status === 302 && (r.headers.get("location") || "").includes("/login"), `got ${r.status}`);
  const n = await fetch(`${BASE}/api/nodes`, { headers: UA });
  check("未登录 /api/nodes 返回 401", n.status === 401, `got ${n.status}`);
}

// 2. agent 凭证不能登录管理员（管理员独立保护）
{
  const r = await loginJson(ADMIN_USER, AGENT_TOKEN);
  check("agent 凭证登录管理员被拒 401", r.status === 401, `got ${r.status}`);
}

// 3. 连续失败触发分级延迟闸门：累计 3 次失败后立即重试（哪怕密码正确）回 429
{
  check("错误密码 401 (#2)", (await loginJson(ADMIN_USER, "wrong-2")).status === 401);
  check("错误密码 401 (#3)", (await loginJson(ADMIN_USER, "wrong-3")).status === 401);
  const blocked = await loginJson(ADMIN_USER, ADMIN_PASS);
  check("延迟窗口内正确密码也被 429 拦截", blocked.status === 429, `got ${blocked.status}`);
  check("429 带 Retry-After", parseInt(blocked.headers.get("retry-after") || "0", 10) >= 1);
}

// 4. 等过延迟后正确登录成功，拿到 Session Cookie
let cookie = "";
{
  await sleep(2300);
  const r = await loginJson(ADMIN_USER, ADMIN_PASS);
  check("正确登录 200", r.status === 200, `got ${r.status}`);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  check("签发 session cookie", cookie.includes("session="), cookie);
}
const auth = { Cookie: cookie, ...UA };

// 5. 面板：含 CSRF、不泄露管理员密码、接入命令使用 agent 凭证
let csrf = "";
{
  const r = await fetch(`${BASE}/`, { headers: auth });
  const html = await r.text();
  check("已登录面板 200", r.status === 200, `got ${r.status}`);
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  check("面板注入 CSRF token", !!m);
  csrf = m[1];
  check("面板不含管理员密码", !html.includes(ADMIN_PASS));
  check("接入命令使用 agent 凭证", html.includes(`${AGENT_USER}:${AGENT_TOKEN}`) || html.includes(AGENT_TOKEN));
}

// 6. 管理员 API：Session 可用；写操作缺 CSRF 回 403，带 CSRF 成功
{
  check("session 访问 /api/nodes 200", (await fetch(`${BASE}/api/nodes`, { headers: auth })).status === 200);
  const payload = JSON.stringify({ servers: {}, defaults: { country: "JP", port: 10001, mode: "auto", manual_node_ip: "", youtube_check: false } });
  const noCsrf = await fetch(`${BASE}/api/config`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: payload });
  check("POST /api/config 缺 CSRF 返回 403", noCsrf.status === 403, `got ${noCsrf.status}`);
  const withCsrf = await fetch(`${BASE}/api/config`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: payload });
  check("POST /api/config 带 CSRF 返回 200", withCsrf.status === 200, `got ${withCsrf.status}`);
  const sw = await fetch(`${BASE}/api/switch`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ server_ip: "203.0.113.7", slot: 0 }) });
  check("POST /api/switch 带 CSRF 返回 200", sw.status === 200, `got ${sw.status}`);
}

// 7. UA 绑定：换 User-Agent 后 Session 失效
{
  const r = await fetch(`${BASE}/api/nodes`, { headers: { Cookie: cookie, "User-Agent": "evil-clone/9.9" } });
  check("UA 变化后 session 失效 401", r.status === 401, `got ${r.status}`);
}

// 8. agent 链路：拉配置、上报、下载脚本（内嵌 agent 凭证而非管理员密码）
{
  const h = { Authorization: basic(AGENT_USER, AGENT_TOKEN), ...UA };
  check("agent GET /api/config 200", (await fetch(`${BASE}/api/config`, { headers: h })).status === 200);
  const rep = await fetch(`${BASE}/api/report`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ ip: "203.0.113.7", details: [], log: "", candidates: [], version: "2.4.1", applied: {} }) });
  check("agent POST /api/report 200", rep.status === 200, `got ${rep.status}`);
  const lite = await (await fetch(`${BASE}/scripts/lite_manager.py`, { headers: h })).text();
  check("lite_manager 内嵌 agent 凭证", lite.includes(`WEB_PASS = "${AGENT_TOKEN}"`));
  check("lite_manager 不含管理员密码", !lite.includes(ADMIN_PASS));
  check("agent 访问 /api/nodes 被拒 401", (await fetch(`${BASE}/api/nodes`, { headers: h })).status === 401);
  const post = await fetch(`${BASE}/api/config`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{}" });
  check("agent POST /api/config 被拒 401", post.status === 401, `got ${post.status}`);
  const dash = await fetch(`${BASE}/`, { headers: h, redirect: "manual" });
  check("agent 访问面板被拒（跳转登录）", dash.status === 302, `got ${dash.status}`);
}

// 9. 登出后 Session 注销（需重新登录拿新 cookie 再登出验证）
{
  const r = await loginJson(ADMIN_USER, ADMIN_PASS);
  const c2 = (r.headers.get("set-cookie") || "").split(";")[0];
  check("再次登录 200", r.status === 200);
  const out = await fetch(`${BASE}/logout`, { headers: { Cookie: c2, ...UA }, redirect: "manual" });
  check("/logout 跳转登录页", out.status === 302, `got ${out.status}`);
  const after = await fetch(`${BASE}/api/nodes`, { headers: { Cookie: c2, ...UA } });
  check("登出后旧 session 失效 401", after.status === 401, `got ${after.status}`);
}

console.log(`\nE2E 全部通过：${passed} 项`);
