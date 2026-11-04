// 路由与鉴权分层
//  公开：/api/countries、/login、/health
//  agent（独立凭证）：/scripts/*.py、/agent、/uninstall、GET /api/config、POST /api/report
//  管理员（Session + CSRF）：/、/api/nodes、/api/proxies、POST /api/config、POST /api/switch
//  管理员凭证与 agent 凭证互不通用 —— 管理员独立保护。
import {
  adminUsername, agentUsername, agentToken, resolveAdminHash, verifyPassword,
  verifyAgentRequest, loginBlockedMs, recordLoginFailure, clearLoginFailures,
  createSession, validateSession, destroySession, checkCsrf, clientIp, securityHeaders,
  hasAdminCredential, storeSetupAdminHash, hashPassword, iterationsOf,
} from "./auth.js";
import { initDb, shq } from "./db.js";
import { loginHtml, setupHtml, setupDoneHtml } from "./login_page.js";
import { dashboardHtml } from "./dashboard.js";
import { proxyServerPy } from "./scripts/proxy_server.js";
import { liteManagerPy } from "./scripts/lite_manager.js";
import { agentScript, uninstallScript } from "./scripts/agent.js";
import {
  handleCountries, handleConfigGet, handleConfigPost, handleSwitch,
  handleReport, handleProxies, handleNodes,
} from "./api.js";

const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: securityHeaders({ "Content-Type": "text/plain;charset=UTF-8", ...headers }) });

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}

// 未登录访问：页面跳登录，API 回 401
function adminDenied(request, url) {
  if (url.pathname === "/" ) return redirect("/login");
  return text("Unauthorized", 401);
}

// 首次部署设置向导：没有任何管理员凭证时开放，设置后永久关闭。
// 设置的哈希立即写入 D1 生效，同时把变量名+哈希展示给用户，
// 供其到 CF 后台添加为机密变量（secret 优先级最高，保存后以它为准）。
async function handleSetup(request, env) {
  if (await hasAdminCredential(env, env.DB)) return redirect("/login");
  const username = adminUsername(env);
  if (request.method === "GET") {
    return new Response(setupHtml({ username }), { headers: securityHeaders({ "Content-Type": "text/html;charset=UTF-8" }) });
  }
  if (request.method !== "POST") return text("Method Not Allowed", 405);
  const origin = request.headers.get("Origin");
  if (origin) {
    try { if (new URL(origin).host !== new URL(request.url).host) return text("Bad Origin", 403); } catch (e) { return text("Bad Origin", 403); }
  }
  let password = "", password2 = "";
  try {
    const form = await request.formData();
    password = String(form.get("password") || "");
    password2 = String(form.get("password2") || "");
  } catch (e) { return text("Bad Request", 400); }
  const fail = (msg) => new Response(setupHtml({ username, error: msg }),
    { status: 400, headers: securityHeaders({ "Content-Type": "text/html;charset=UTF-8" }) });
  if (password.length < 8) return fail("密码至少 8 位");
  if (password !== password2) return fail("两次输入的密码不一致");
  // 提交瞬间再查一次，防止并发下重复设置
  if (await hasAdminCredential(env, env.DB)) return redirect("/login");
  const hash = await hashPassword(password, iterationsOf(env));
  await storeSetupAdminHash(env.DB, hash);
  const { cookie } = await createSession(env.DB, request, username);
  return new Response(setupDoneHtml({ username, hash }), {
    headers: securityHeaders({ "Content-Type": "text/html;charset=UTF-8", "Set-Cookie": cookie }),
  });
}

async function handleLogin(request, env, url) {
  if (request.method === "GET") {
    const session = await validateSession(env.DB, request);
    if (session) return redirect("/");
    if (!(await hasAdminCredential(env, env.DB))) return redirect("/setup");
    return new Response(loginHtml({}), { headers: securityHeaders({ "Content-Type": "text/html;charset=UTF-8" }) });
  }
  if (request.method !== "POST") return text("Method Not Allowed", 405);

  let username = "", password = "";
  const ctype = request.headers.get("Content-Type") || "";
  try {
    if (ctype.includes("application/json")) {
      const data = await request.json();
      username = String(data.username || ""); password = String(data.password || "");
    } else {
      const form = await request.formData();
      username = String(form.get("username") || ""); password = String(form.get("password") || "");
    }
  } catch (e) { return text("Bad Request", 400); }

  const ip = clientIp(request);
  const adminUser = adminUsername(env);

  // 1) 防爆破闸门：在校验密码之前检查分级延迟/锁定，等待期内一律 429
  const blockedMs = await loginBlockedMs(env.DB, ip, username);
  if (blockedMs > 0) {
    const sec = Math.ceil(blockedMs / 1000);
    if (ctype.includes("application/json")) {
      return text(JSON.stringify({ error: "too_many_attempts", retry_after: sec }), 429,
        { "Content-Type": "application/json", "Retry-After": String(sec) });
    }
    return new Response(loginHtml({ error: "登录尝试过多", retryAfterSec: sec }), {
      status: 429, headers: securityHeaders({ "Content-Type": "text/html;charset=UTF-8", "Retry-After": String(sec) }),
    });
  }

  // 2) PBKDF2-SHA256 校验；账号不存在时 verifyPassword 内部走等价虚拟哈希
  let expectedHash = null;
  try { expectedHash = await resolveAdminHash(env, env.DB); }
  catch (e) { return text("管理员密码哈希配置错误，请检查 ADMIN_PASS_HASH", 500); }
  if (!expectedHash) return text("管理员凭证未配置：请设置 ADMIN_PASS_HASH（或过渡期 WEB_PASS）secret 后重试", 503);

  const userOk = username === adminUser;
  const passOk = await verifyPassword(password, userOk ? expectedHash : null);
  if (!userOk || !passOk) {
    const retryMs = await recordLoginFailure(env.DB, ip, username);
    const sec = Math.ceil(retryMs / 1000);
    if (ctype.includes("application/json")) {
      return text(JSON.stringify({ error: "invalid_credentials", retry_after: sec }), 401,
        { "Content-Type": "application/json", ...(sec > 0 ? { "Retry-After": String(sec) } : {}) });
    }
    return new Response(loginHtml({ error: "用户名或密码错误", retryAfterSec: sec }), {
      status: 401, headers: securityHeaders({ "Content-Type": "text/html;charset=UTF-8" }),
    });
  }

  // 3) 成功：清零失败计数，签发新 Session（令牌轮换，旧会话不复用）
  await clearLoginFailures(env.DB, ip, username);
  const { cookie } = await createSession(env.DB, request, username);
  if (ctype.includes("application/json")) {
    return text(JSON.stringify({ ok: true }), 200, { "Content-Type": "application/json", "Set-Cookie": cookie });
  }
  return redirect("/", { "Set-Cookie": cookie });
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const domain = url.origin;
  const path = url.pathname;

  const PROXY_USER = env.PROXY_USER || "proxyuser";
  const PROXY_PASS = env.PROXY_PASS || "888888";
  const configuredProxyPort = env.PROXY_PORT ? parseInt(env.PROXY_PORT, 10) : 10001;
  const PROXY_PORT = Number.isInteger(configuredProxyPort) && configuredProxyPort >= 1 && configuredProxyPort <= 65535 ? configuredProxyPort : 10001;

  await initDb(env.DB);

  // ---------- 公开 ----------
  if (path === "/health") return text("OK");
  if (path === "/api/countries") return handleCountries();
  if (path === "/setup") return handleSetup(request, env);
  if (path === "/login") return handleLogin(request, env, url);
  if (path === "/logout") {
    const clearCookie = await destroySession(env.DB, request);
    return redirect("/login", { "Set-Cookie": clearCookie });
  }

  const agentUser = agentUsername(env);
  const aToken = agentToken(env);

  // ---------- agent 专用（独立凭证；管理员 Session 在此不通用） ----------
  const AGENT_GET = ["/scripts/proxy_server.py", "/scripts/lite_manager.py", "/agent", "/uninstall"];
  if (AGENT_GET.includes(path) || (path === "/api/config" && request.method === "GET") || (path === "/api/report" && request.method === "POST")) {
    // /api/config GET 同时服务面板（管理员 Session）与 agent
    let authed = verifyAgentRequest(env, request);
    if (!authed && path === "/api/config") {
      authed = !!(await validateSession(env.DB, request));
    }
    if (!authed) return text("Unauthorized Access. Scanner Blocked.", 401);
    if (!aToken && path !== "/api/config") return text("AGENT_TOKEN 未配置", 503);
    switch (path) {
      case "/scripts/proxy_server.py":
        return text(proxyServerPy({ proxyUser: PROXY_USER, proxyPass: PROXY_PASS }));
      case "/scripts/lite_manager.py":
        return text(liteManagerPy({ domain, proxyPort: PROXY_PORT, agentUser, agentToken: aToken }));
      case "/agent":
        return text(agentScript({ domain, agentUser, agentToken: aToken, shq }));
      case "/uninstall":
        return text(uninstallScript());
      case "/api/config":
        return handleConfigGet(env.DB, PROXY_PORT);
      case "/api/report":
        return handleReport(env.DB, request);
    }
  }

  // ---------- 管理员专属（Session；写操作额外 CSRF） ----------
  const ADMIN_PATHS = ["/", "/api/nodes", "/api/proxies", "/api/switch"];
  if (ADMIN_PATHS.includes(path) || (path === "/api/config" && request.method === "POST")) {
    const session = await validateSession(env.DB, request);
    if (!session) {
      // 未配置任何管理员凭证时，根路径直接弹首次设置向导
      if (path === "/" && !(await hasAdminCredential(env, env.DB))) return redirect("/setup");
      return adminDenied(request, url);
    }
    if (request.method !== "GET" && request.method !== "HEAD" && !checkCsrf(request, session)) {
      return text("CSRF validation failed", 403);
    }
    switch (path) {
      case "/": {
        const html = dashboardHtml({
          domain, adminUser: adminUsername(env), agentUser, agentToken: aToken,
          proxyUser: PROXY_USER, proxyPass: PROXY_PASS, proxyPort: PROXY_PORT,
          csrfToken: session.csrf, shq,
        });
        return new Response(html, { headers: securityHeaders({ "Content-Type": "text/html;charset=UTF-8" }) });
      }
      case "/api/nodes": return handleNodes(env.DB);
      case "/api/proxies": return handleProxies(env.DB, PROXY_USER, PROXY_PASS);
      case "/api/config": return handleConfigPost(env.DB, request);
      case "/api/switch": return handleSwitch(env.DB, request);
    }
  }

  return text("Not Found", 404);
}
