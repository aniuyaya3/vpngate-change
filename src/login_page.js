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
