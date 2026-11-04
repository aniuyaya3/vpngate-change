// ============================================================
// 账号安全模块
//  - 管理员密码：PBKDF2-SHA256 哈希校验（不存明文、不明文比对）
//  - 防爆破：按 (IP+账号) 与 (账号) 双维度计数，分级延迟 + 锁定
//  - 安全 Session：随机令牌、仅存哈希、HttpOnly/Secure/SameSite=Strict、
//    绝对过期 + 空闲过期 + UA 绑定 + CSRF Token + 登录后轮换
//  - 管理员独立保护：管理员 Session 与 VPS agent 凭证完全分离，
//    agent 凭证不能访问任何管理员接口，管理员锁定不影响 agent 心跳
// ============================================================

export const PBKDF2_ITERATIONS = 210000;
const DK_LEN = 32;
const SALT_LEN = 16;
// 用户不存在时也跑一次等价校验，避免按响应时间枚举账号
const DUMMY_HASH = "pbkdf2-sha256$210000$AQIDBAUGBwgJCgsMDQ4PEA==$6O6TvbCInAhWIwi4saTJMPkXqccoLEvFbuaQTIWL3fk=";

const enc = new TextEncoder();

export function iterationsOf(env) {
  const n = parseInt(env && env.AUTH_PBKDF2_ITERATIONS, 10);
  return Number.isInteger(n) && n >= 50000 && n <= 1000000 ? n : PBKDF2_ITERATIONS;
}

function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function timingSafeEqual(a, b) {
  const ba = typeof a === "string" ? enc.encode(a) : a;
  const bb = typeof b === "string" ? enc.encode(b) : b;
  let diff = ba.length ^ bb.length;
  const n = Math.max(ba.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ba[i % ba.length] || 0) ^ (bb[i % bb.length] || 0);
  return diff === 0 && ba.length === bb.length;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, DK_LEN * 8);
  return new Uint8Array(bits);
}

// 生成哈希串：pbkdf2-sha256$<iterations>$<salt_b64>$<hash_b64>
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const dk = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64encode(salt)}$${b64encode(dk)}`;
}

export function parseHash(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.trim().split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return null;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 2000000) return null;
  try {
    const salt = b64decode(parts[2]);
    const dk = b64decode(parts[3]);
    if (salt.length < 8 || dk.length !== DK_LEN) return null;
    return { iterations, salt, dk };
  } catch (e) { return null; }
}

export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored) || parseHash(DUMMY_HASH);
  const dk = await derive(String(password ?? ""), parsed.salt, parsed.iterations);
  return timingSafeEqual(dk, parsed.dk);
}

// ------------------------------------------------------------
// 客户端与 Basic 解析
// ------------------------------------------------------------
export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP")
    || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim()
    || "unknown";
}

export function parseBasicAuth(request) {
  const header = request.headers.get("Authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return null;
  try {
    const decoded = atob(encoded);
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch (e) { return null; }
}

export function parseBearer(request) {
  const header = request.headers.get("Authorization") || "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

// ------------------------------------------------------------
// 管理员凭证解析
// 优先：ADMIN_PASS_HASH / WEB_PASS_HASH（secret，明文从不落地）
// 其次：D1 中已引导的哈希（auth_config.admin_pass_hash）
// 过渡：仅设置了旧版 WEB_PASS 时，首次使用即在 D1 中生成其
//       PBKDF2 哈希并绑定指纹；之后校验只走哈希，WEB_PASS
//       指纹变化（改密）会自动重新引导。
// ------------------------------------------------------------
export function adminUsername(env) {
  return env.ADMIN_USER || env.WEB_USER || "admin";
}
export function agentUsername(env) {
  return env.AGENT_USER || "agent";
}
// agent 凭证：独立于管理员密码。未单独设置 AGENT_TOKEN 时
// 过渡回退到旧版 WEB_PASS（旧 agent 行为不变），但该凭证
// 永远只能访问 agent 接口，不能登录面板。
export function agentToken(env) {
  return env.AGENT_TOKEN || env.WEB_PASS || "";
}

export async function resolveAdminHash(env, db) {
  const fromSecret = (env.ADMIN_PASS_HASH || env.WEB_PASS_HASH || "").trim();
  if (fromSecret) {
    if (!parseHash(fromSecret)) throw new Error("ADMIN_PASS_HASH 格式不正确（应为 pbkdf2-sha256$迭代$salt$hash）");
    return fromSecret;
  }
  const legacy = env.WEB_PASS || "";
  if (!legacy) return null; // 未配置任何管理员凭证：登录关闭（不再有默认密碼）
  const fingerprint = (await sha256Hex(legacy)).slice(0, 32);
  const row = await db.prepare(`SELECT value FROM auth_config WHERE key = 'admin_pass_hash'`).first();
  const fpRow = await db.prepare(`SELECT value FROM auth_config WHERE key = 'admin_pass_fp'`).first();
  if (row && row.value && fpRow && fpRow.value === fingerprint && parseHash(row.value)) return row.value;
  const fresh = await hashPassword(legacy, iterationsOf(env));
  await db.prepare(`INSERT INTO auth_config (key, value) VALUES ('admin_pass_hash', ?1)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(fresh).run();
  await db.prepare(`INSERT INTO auth_config (key, value) VALUES ('admin_pass_fp', ?1)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(fingerprint).run();
  return fresh;
}

// agent 凭证校验（常数时间）。接受新凭证 agent:<AGENT_TOKEN>，
// 也接受旧 agent 的 <WEB_USER>:<WEB_PASS> 以便存量 VPS 不掉线。
export function verifyAgentCredential(env, cred) {
  if (!cred) return false;
  const token = agentToken(env);
  if (token && cred.user === agentUsername(env) && timingSafeEqual(cred.pass, token)) return true;
  const legacyUser = env.WEB_USER || "admin";
  if (env.WEB_PASS && cred.user === legacyUser && timingSafeEqual(cred.pass, env.WEB_PASS)) return true;
  return false;
}
export function verifyAgentRequest(env, request) {
  const bearer = parseBearer(request);
  if (bearer) return timingSafeEqual(bearer, agentToken(env)) && !!agentToken(env);
  return verifyAgentCredential(env, parseBasicAuth(request));
}

// ------------------------------------------------------------
// 防爆破：分级延迟与锁定（纯函数 delayForFails 便于测试）
//  失败次数: 1-2 不延迟, 3→2s, 4→5s, 5→15s, 6→30s,
//            7→60s, 8→120s, 9→300s, ≥10 锁定（IP 维度 15 分钟）
// ------------------------------------------------------------
const DELAY_TABLE_MS = [0, 0, 0, 2000, 5000, 15000, 30000, 60000, 120000, 300000];
export const LOCK_THRESHOLD = 10;
export const LOCK_MS = 15 * 60 * 1000;

export function delayForFails(fails) {
  if (fails < DELAY_TABLE_MS.length) return DELAY_TABLE_MS[fails] || 0;
  return DELAY_TABLE_MS[DELAY_TABLE_MS.length - 1];
}

const ipScope = (ip, user) => `ip:${ip}|user:${user}`;
const userScope = (user) => `user:${user}`;

// 返回 0 表示可尝试；>0 表示还需等待的毫秒数
export async function loginBlockedMs(db, ip, user, now = Date.now()) {
  let blocked = 0;
  for (const scope of [ipScope(ip, user), userScope(user)]) {
    const row = await db.prepare(`SELECT locked_until, next_allowed_at FROM login_attempts WHERE scope = ?1`).bind(scope).first();
    if (!row) continue;
    blocked = Math.max(blocked, (row.locked_until || 0) - now, (row.next_allowed_at || 0) - now);
  }
  return Math.max(0, blocked);
}

export async function recordLoginFailure(db, ip, user, now = Date.now()) {
  let retryAfterMs = 0;
  for (const scope of [ipScope(ip, user), userScope(user)]) {
    const row = await db.prepare(`SELECT fails FROM login_attempts WHERE scope = ?1`).bind(scope).first();
    const fails = (row ? row.fails : 0) + 1;
    const delay = delayForFails(fails);
    // 账号全局维度只做分级延迟、不做硬锁定，避免攻击者用已知用户名把管理员锁在外面；
    // (IP+账号) 维度达到阈值后硬锁定。
    const lockedUntil = scope.startsWith("ip:") && fails >= LOCK_THRESHOLD ? now + LOCK_MS : 0;
    await db.prepare(`INSERT INTO login_attempts (scope, fails, locked_until, next_allowed_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(scope) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until,
        next_allowed_at = excluded.next_allowed_at, updated_at = excluded.updated_at`)
      .bind(scope, fails, lockedUntil, now + delay, now).run();
    retryAfterMs = Math.max(retryAfterMs, lockedUntil ? LOCK_MS : delay);
  }
  return retryAfterMs;
}

export async function clearLoginFailures(db, ip, user) {
  await db.prepare(`DELETE FROM login_attempts WHERE scope IN (?1, ?2)`).bind(ipScope(ip, user), userScope(user)).run();
}

// ------------------------------------------------------------
// 安全 Session（D1 存储，仅存令牌哈希）
// ------------------------------------------------------------
export const SESSION_ABSOLUTE_MS = 12 * 3600 * 1000; // 绝对过期 12h
export const SESSION_IDLE_MS = 30 * 60 * 1000;       // 空闲过期 30min

function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return b64encode(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sessionCookieName(request) {
  return new URL(request.url).protocol === "https:" ? "__Host-session" : "session";
}

export function readSessionCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "__Host-session" || k === "session") return rest.join("=");
  }
  return null;
}

export async function createSession(db, request, username) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = Date.now();
  const uaHash = await sha256Hex(request.headers.get("User-Agent") || "");
  await db.prepare(`INSERT INTO auth_sessions (token_hash, username, csrf, created_at, last_seen, expires_at, ip, ua_hash)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(await sha256Hex(token), username, csrf, now, now, now + SESSION_ABSOLUTE_MS, clientIp(request), uaHash).run();
  const secure = new URL(request.url).protocol === "https:";
  const cookie = `${sessionCookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_ABSOLUTE_MS / 1000}`
    + (secure ? "; Secure" : "");
  return { token, csrf, cookie };
}

// 校验成功返回 session 行；失败返回 null。顺带做空闲滑动（节流写：>60s 才更新）
export async function validateSession(db, request, now = Date.now()) {
  const token = readSessionCookie(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?1`).bind(tokenHash).first();
  if (!row) return null;
  const uaHash = await sha256Hex(request.headers.get("User-Agent") || "");
  const expired = now > row.expires_at || now - row.last_seen > SESSION_IDLE_MS || row.ua_hash !== uaHash;
  if (expired) {
    await db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?1`).bind(tokenHash).run();
    return null;
  }
  if (now - row.last_seen > 60000) {
    await db.prepare(`UPDATE auth_sessions SET last_seen = ?1 WHERE token_hash = ?2`).bind(now, tokenHash).run();
  }
  return row;
}

export async function destroySession(db, request) {
  const token = readSessionCookie(request);
  if (token) await db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?1`).bind(await sha256Hex(token)).run();
  const secure = new URL(request.url).protocol === "https:";
  return `${sessionCookieName(request)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` + (secure ? "; Secure" : "");
}

// 管理员接口的 CSRF + Origin 校验（配合面板注入的 X-CSRF-Token）
export function checkCsrf(request, session) {
  const origin = request.headers.get("Origin");
  if (origin) {
    try { if (new URL(origin).host !== new URL(request.url).host) return false; } catch (e) { return false; }
  }
  const token = request.headers.get("X-CSRF-Token") || "";
  return !!session && timingSafeEqual(token, session.csrf || "");
}

export function securityHeaders(headers = {}) {
  return {
    ...headers,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}
