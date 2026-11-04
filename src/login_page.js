// 首次部署设置向导：仅在「没有任何管理员凭证」时开放，设置成功即永久关闭
export function setupHtml({ username = "admin", error = "" } = {}) {
  const err = error ? `<div class="err">${error}</div>` : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>首次设置 · 住宅代理调度中心</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#020617; color:#e2e8f0; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { width:min(92vw,400px); background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1);
    border-radius:16px; padding:28px 24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 20px; font-size:12px; color:#64748b; }
  label { display:block; font-size:12px; color:#94a3b8; margin:14px 0 6px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.15);
    background:#0f172a; color:#e2e8f0; font-size:14px; }
  button, .btn { display:block; width:100%; box-sizing:border-box; text-align:center; margin-top:22px; padding:11px; border:0; border-radius:10px; cursor:pointer;
    background:linear-gradient(90deg,#06b6d4,#2563eb); color:#fff; font-size:14px; font-weight:700; text-decoration:none; }
  .err { background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.35); color:#fca5a5;
    border-radius:10px; padding:9px 12px; font-size:13px; margin-bottom:6px; }
  .warn { background:rgba(245,158,11,.1); border:1px solid rgba(245,158,11,.35); color:#fcd34d;
    border-radius:10px; padding:9px 12px; font-size:12px; line-height:1.6; margin-bottom:6px; }
  .note { margin-top:16px; font-size:11px; color:#475569; line-height:1.6; }
  code, textarea { font-family:ui-monospace,Menlo,Consolas,monospace; }
  textarea { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.15);
    background:#0f172a; color:#6ee7b7; font-size:12px; word-break:break-all; }
  .kv { font-size:13px; margin-top:14px; } .kv b { color:#67e8f9; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/setup">
    <h1>首次部署 · 设置管理员密码</h1>
    <p class="sub">本实例尚未设置任何管理员凭证，请先创建登录密码</p>
    <div class="warn">此页面只在未设置密码时出现，第一个完成设置的人即为管理员——部署后请立即设置，不要把未设置的实例长时间暴露在公网。</div>
    ${err}
    <label>管理员账号</label>
    <input value="${username}" readonly>
    <label for="p1">设置密码（至少 8 位）</label>
    <input id="p1" name="password" type="password" autocomplete="new-password" required autofocus>
    <label for="p2">再输一次</label>
    <input id="p2" name="password2" type="password" autocomplete="new-password" required>
    <button type="submit">设置密码并登录</button>
    <div class="note">设置成功后，密码会立即生效（哈希保存在数据库中），同时页面会给出变量名与哈希值，供你复制到 Cloudflare 后台保存为机密变量。</div>
  </form>
</body>
</html>`;
}

// 设置成功页：给出变量名 + 哈希，供用户到 CF 后台添加为机密变量
export function setupDoneHtml({ username = "admin", hash = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>设置完成 · 住宅代理调度中心</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#020617; color:#e2e8f0; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { width:min(92vw,460px); background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1);
    border-radius:16px; padding:28px 24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 14px; font-size:12px; color:#64748b; line-height:1.7; }
  .btn { display:block; width:100%; box-sizing:border-box; text-align:center; margin-top:22px; padding:11px; border:0; border-radius:10px;
    background:linear-gradient(90deg,#06b6d4,#2563eb); color:#fff; font-size:14px; font-weight:700; text-decoration:none; }
  textarea { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.15);
    background:#0f172a; color:#6ee7b7; font-size:12px; word-break:break-all; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .kv { font-size:13px; margin:14px 0 6px; } .kv b { color:#67e8f9; font-family:ui-monospace,Menlo,Consolas,monospace; }
  ol { font-size:12px; color:#94a3b8; line-height:1.8; padding-left:18px; margin:10px 0 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>管理员密码已设置 ✅</h1>
    <p class="sub">账号 <b>${username}</b> 现在就能用你刚设置的密码登录（哈希已保存在数据库中）。再把下面这组变量保存到 Cloudflare 后台，配置就完整了：后台机密变量的优先级最高，保存后以它为准。</p>
    <div class="kv">变量名：<b>ADMIN_PASS_HASH</b></div>
    <textarea rows="3" readonly onclick="this.select()">${hash}</textarea>
    <ol>
      <li>打开 Cloudflare 后台 → Workers 和 Pages → 本 Worker</li>
      <li>设置 → 变量和机密 → 添加：类型选「机密」，变量名填 ADMIN_PASS_HASH，值粘贴上面整行</li>
      <li>保存并部署后，此设置页面将永久关闭</li>
    </ol>
    <a class="btn" href="/">进入管理面板</a>
  </div>
</body>
</html>`;
}

// 管理员登录页（独立于面板，登录走 PBKDF2 校验 + Session 签发）
export function loginHtml({ error = "", retryAfterSec = 0 } = {}) {
  const err = error
    ? `<div class="err">${error}${retryAfterSec > 0 ? `（请 ${retryAfterSec} 秒后重试）` : ""}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 · 住宅代理调度中心</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#020617; color:#e2e8f0; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { width:min(92vw,360px); background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1);
    border-radius:16px; padding:28px 24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 20px; font-size:12px; color:#64748b; }
  label { display:block; font-size:12px; color:#94a3b8; margin:14px 0 6px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.15);
    background:#0f172a; color:#e2e8f0; font-size:14px; }
  button { width:100%; margin-top:22px; padding:11px; border:0; border-radius:10px; cursor:pointer;
    background:linear-gradient(90deg,#06b6d4,#2563eb); color:#fff; font-size:14px; font-weight:700; }
  .err { background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.35); color:#fca5a5;
    border-radius:10px; padding:9px 12px; font-size:13px; margin-bottom:6px; }
  .note { margin-top:16px; font-size:11px; color:#475569; line-height:1.6; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>住宅代理调度中心</h1>
    <p class="sub">管理员登录 · PBKDF2-SHA256 · 防爆破分级延迟</p>
    ${err}
    <label for="u">管理员账号</label>
    <input id="u" name="username" autocomplete="username" required autofocus>
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登录</button>
    <div class="note">连续失败将触发分级延迟，达到阈值后该来源锁定 15 分钟。VPS agent 使用独立凭证，心跳不受登录锁定影响。</div>
  </form>
</body>
</html>`;
}
