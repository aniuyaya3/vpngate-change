# vpngate-change · 免费住宅IP智能调度系统（Wrangler 版）

自旧版单文件 `_worker.js`（Pages 部署）重构为标准 Wrangler 项目，业务行为
（多服务器独立策略、Alpine/Debian 自适应 agent、节点调度）保持不变；
账号登录全面升级为 PBKDF2-SHA256 + 防爆破分级延迟 + 安全 Session +
管理员独立保护。

## 项目结构

```text
wrangler.toml            Wrangler 配置（D1 绑定 DB）
src/
  index.js               入口（仅导出 fetch）
  router.js              路由与三层鉴权分发
  auth.js                PBKDF2-SHA256 / 防爆破 / Session / CSRF
  db.js                  D1 建表与配置存取
  api.js                 配置 / 节点 / 上报 / 国家列表等业务接口
  dashboard.js           管理面板 HTML（自旧版拆分）
  login_page.js          管理员登录页
  scripts/
    proxy_server.py      由 proxy_server.js 模板生成（Python 引擎）
    lite_manager.py      由 lite_manager.js 模板生成（Python 引擎）
    agent.js             VPS 安装 / 卸载 bash 脚本模板
tools/hash-password.mjs  生成管理员密码哈希
tests/
  auth.test.mjs          单元测试（node --test）
  e2e.mjs                对 wrangler dev 实例的端到端测试
```

## 账号安全设计

| 机制 | 实现 |
| --- | --- |
| 密码存储 | PBKDF2-SHA256，210,000 次迭代（可调 `AUTH_PBKDF2_ITERATIONS`），16 字节随机盐，32 字节派生密钥；哈希串格式 `pbkdf2-sha256$迭代$盐$哈希`。服务端不存明文密码，校验为派生后常数时间比较；账号不存在时走等价虚拟哈希，防时序枚举 |
| 防爆破 | 失败计数按 `(来源 IP + 账号)` 与 `(账号)` 双维度记录在 D1。分级延迟：失败 1–2 次不延迟，3 次 2s、4 次 5s、5 次 15s、6 次 30s、7 次 60s、8 次 120s、9 次 300s；`(IP+账号)` 维度满 10 次锁定 15 分钟。等待期内请求在验密前直接返回 `429 + Retry-After`。账号全局维度只延迟不硬锁，防止攻击者用已知用户名把管理员锁死 |
| 安全 Session | 登录签发 256 位随机令牌，D1 只存其 SHA-256 哈希；Cookie 为 `__Host-session`（HttpOnly + Secure + SameSite=Strict），绝对过期 12 小时、空闲过期 30 分钟（滑动），绑定 User-Agent 指纹，登录即轮换，登出即注销 |
| CSRF / 点击劫持 | 管理员写操作必须带面板注入的 `X-CSRF-Token` 并校验 Origin；全站响应带 `no-store`、`nosniff`、`X-Frame-Options: DENY` |
| 管理员独立保护 | 管理员与 VPS agent 使用**两套完全独立的凭证**：agent 凭证（`AGENT_TOKEN`）只能访问拉配置 / 上报 / 下载脚本，不能进面板、不能调管理员 API；管理员 Session 也不能替代 agent 凭证。管理员被锁定不影响 agent 心跳，agent 凭证泄露不会交出面板 |
| 默认口令 | 已移除旧版 `admin888` 默认密码：未配置任何管理员凭证时登录直接返回 503 |

鉴权分层：

- 公开：`GET /api/countries`、`GET /health`、`/login`、`/setup`（仅在未配置任何管理员凭证时开放，设置后永久关闭）
- agent（Basic `agent:<AGENT_TOKEN>` 或 Bearer）：`GET /scripts/*.py`、`GET /agent`、`GET /uninstall`、`GET /api/config`、`POST /api/report`
- 管理员（Session，写操作加 CSRF）：`GET /`、`GET /api/nodes`、`GET /api/proxies`、`GET /api/config`、`POST /api/config`、`POST /api/switch`

## 部署

```bash
npm install
# D1 无需手工创建：wrangler.toml 只留 binding，走 Wrangler 自动置备，
# 首次 deploy 时按 Worker 名自动创建专属库并绑定（见下）

# 管理员密码哈希（明文不进任何配置）
node tools/hash-password.mjs '你的管理员密码'
npx wrangler secret put ADMIN_PASS_HASH     # 粘贴上一步输出
npx wrangler secret put AGENT_TOKEN         # 长随机串，如 openssl rand -hex 32
npx wrangler secret put PROXY_PASS          # 代理用户密码

npx wrangler deploy
```

### D1 自动置备（库名/ID 都不进仓库）

wrangler.toml 的 D1 绑定只写 `binding = "DB"`，不写 `database_name`、
不写 `database_id`。Wrangler（>= 4.45）的自动置备会在首次
`wrangler deploy` 时按 Worker 名字自动创建一个专属 D1 并绑定，
后续部署自动复用同一个库；换一个 Worker 名部署就是另一个实例、
另一个自动命名的库，互不干扰。不同仓库引用同一份代码同理，
不需要任何人填库 ID。

Cloudflare Workers Builds 设置（最简）：

- 构建命令：无
- 构建变量：无
- 部署命令：`npx wrangler deploy`
- 根目录：`/`

可选覆盖（`tools/deploy.mjs`，一般用不上）：

```bash
# 改实例名（库名随新 Worker 名自动生成）
WORKER_NAME=<name> npm run deploy:vars
# 手动指定一个现成的 D1 库（填了就不再自动置备）
DATABASE_ID=<uuid> npm run deploy:vars
```

### 首次部署设置向导（可代替手工生成哈希）

不想在本地生成哈希也可以：先只建好 D1 并部署（管理员 secret 可以先不设），
然后打开你的 Worker 域名——在没有任何管理员凭证时，根路径会自动弹出
「设置管理员密码」页面：

1. 在页面上设置密码（至少 8 位）并提交；
2. 密码立即生效（PBKDF2 哈希保存在 D1 中），并自动登录进面板；
3. 成功页会给出变量名 `ADMIN_PASS_HASH` 与对应的哈希值，复制到 CF 后台
   （Worker → 设置 → 变量和机密 → 添加机密）保存即可；机密变量优先级
   最高，保存后以它为准。

安全说明：向导只在「secret、旧变量、D1 哈希三者全为空」时开放，设置
完成后永久关闭；但在设置完成之前，第一个打开域名的人都能抢先设置，
所以部署后请立刻完成设置，不要把未设置的实例长时间暴露在公网。

找回/重置密码：删除 CF 后台的 `ADMIN_PASS_HASH` 机密，并删除 D1
`auth_config` 表中 `admin_pass_hash` 与 `admin_pass_fp` 两行，向导会
重新开放，可重新设定。

部署后已部署的旧版 agent 需重新运行面板中的接入命令（新版安装命令使用
agent 凭证）；未重装的旧 agent 以旧 `WEB_USER:WEB_PASS` 凭证继续兼容
（见下）。

## 同账号多实例部署（Worker 名字用变量）

wrangler.toml 里的 `name` 只是默认实例名。同一份代码可以在同一个
Cloudflare 账号下以任意名字反复部署（变量来自命令行 `--name`，
覆盖配置文件；注意 wrangler.toml 的字段本身不支持 `${VAR}` 插值）：

```bash
# 以 proxy-a 这个名字部署（等价于 npx wrangler deploy --name proxy-a）
WORKER_NAME=proxy-a npm run deploy:named

# 每个实例分别设置自己的 secret（--name 指到哪个 Worker 就设哪个）
npx wrangler secret put ADMIN_PASS_HASH --name proxy-a
npx wrangler secret put AGENT_TOKEN --name proxy-a
npx wrangler secret put PROXY_PASS --name proxy-a
```

注意数据隔离：`--name` 只改 Worker 名，各实例仍共用 wrangler.toml 里
`database_id` 指向的同一个 D1（配置、节点、Session 互通）。要连数据
也完全独立的实例，复制一份配置改名并换库：

```bash
npx wrangler d1 create vpngate-change-db-b   # 记下新的 database_id
cp wrangler.toml wrangler.proxy-b.toml       # 改 name 与 database_id
npx wrangler deploy -c wrangler.proxy-b.toml
```

## 从旧版迁移（兼容说明）

- 若线上只设置了旧版 `WEB_USER / WEB_PASS` secret 而没有 `ADMIN_PASS_HASH`：
  首次登录时系统自动把 `WEB_PASS` 引导为 D1 中的 PBKDF2 哈希（绑定指纹），
  之后校验只走哈希；日后修改 `WEB_PASS` 会自动重新引导。
  迁移完成后建议改用 `ADMIN_PASS_HASH` + 独立 `AGENT_TOKEN` 并删除 `WEB_PASS`。
- 存量 VPS 上的旧 agent 内嵌的是旧凭证组合，服务端继续接受
  `WEB_USER:WEB_PASS` 作为 agent 凭证，所以升级 Worker 不会让存量节点掉线；
  待各 VPS 重跑新版接入命令后，可删除 `WEB_PASS` 完成彻底分离。

## 本地开发与测试

```bash
# .dev.vars（不要提交）：ADMIN_PASS_HASH / AGENT_TOKEN / PROXY_PASS
npm run dev
node --test tests/auth.test.mjs
BASE_URL=http://127.0.0.1:8787 ADMIN_PASS='...' AGENT_TOKEN='...' node tests/e2e.mjs
```
