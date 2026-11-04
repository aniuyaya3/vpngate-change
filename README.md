# vpngate-change · 免费住宅 IP 智能调度系统

基于 Cloudflare Workers + D1 的住宅代理调度：多台 VPS 各自独立策略，
agent 自适应 Alpine/Debian，节点自动调度。账号登录为 PBKDF2-SHA256
哈希校验 + 防爆破分级延迟 + 安全 Session，管理员与 VPS agent 两套凭证互不相通。

## 快速部署

Cloudflare Workers Builds（Git 连接）设置：

| 项 | 值 |
|---|---|
| 构建命令 | 无 |
| 构建变量 | 无 |
| 部署命令 | `npx wrangler deploy` |
| 根目录 | `/` |

部署完成后三步即可使用：

1. 打开 Worker 域名，未设置过密码时会自动进入 `/setup` 设置管理员密码
   （设置的密码立即生效，哈希保存在 D1 中）；
2. 按成功页提示，把 `ADMIN_PASS_HASH` 加入后台「设置 → 变量和机密」（类型选**机密**）；
3. 同处再添加 `AGENT_TOKEN` 与 `PROXY_PASS` 两个机密，VPS 即可接入。

各 VPS 部署后需重跑面板中的新版接入命令；未重装的旧 agent 继续兼容（见「从旧版迁移」）。

## 环境变量

| 变量名 | 说明 | 默认值/示例值 | 必填 |
|---|---|---|---|
| ADMIN_USER | 管理员登录账号名 | 默认 `admin` | 否 |
| ADMIN_PASS_HASH | 管理员密码的 PBKDF2 哈希 | 例 `pbkdf2-sha256$100000$<盐>$<哈希>`，/setup 成功页给出，或用 `node tools/hash-password.mjs '密码'` 生成 | 否（用 /setup 设密码就不用填） |
| AGENT_USER | VPS agent 的账号名 | 默认 `agent` | 否 |
| AGENT_TOKEN | VPS agent 与 Worker 的通信令牌 | 长随机串，如 `openssl rand -hex 32` 的输出 | 是（不设 agent 接口回 503） |
| PROXY_USER | 客户端连代理用的账号名 | `proxyuser`（已在 wrangler.toml 里） | 否 |
| PROXY_PASS | 客户端连 SOCKS5/HTTP 代理的密码 | 默认 `888888`，务必改掉 | 否（但强烈建议设） |
| AUTH_PBKDF2_ITERATIONS | 密码哈希迭代次数 | 默认 `100000`，可填 10000–100000（Workers 硬上限即 100000） | 否 |

- 密钥类（`ADMIN_PASS_HASH`、`AGENT_TOKEN`、`PROXY_PASS`）在后台以机密方式设置，不会被 Git 推送部署冲掉；
- 纯文本变量要长期生效须写进 wrangler.toml 的 `[vars]`，只在后台手加的会在下一次推送部署时被覆盖；
- `DB` 是 D1 绑定而非变量，走自动置备（见下），无需填写。

## 项目结构

```text
wrangler.toml            Wrangler 配置（D1 只留 binding，自动置备）
src/
  index.js               入口（仅导出 fetch）
  router.js              路由与三层鉴权分发
  auth.js                PBKDF2 / 防爆破 / Session / CSRF / 设置向导 nonce
  db.js                  D1 建表与配置存取
  api.js                 配置 / 节点 / 上报 / 国家列表等业务接口
  dashboard.js           管理面板 HTML
  login_page.js          登录页与首次设置向导页
  scripts/               下发给 VPS 的 proxy_server / lite_manager（Python）与安装脚本模板
tools/
  hash-password.mjs      生成管理员密码哈希
  deploy.mjs             可选的变量驱动部署（见「进阶」）
tests/
  auth.test.mjs          单元测试
  e2e.mjs                主流程端到端测试
  setup.e2e.mjs          首次设置向导端到端测试
```

## 账号安全

| 机制 | 实现 |
|---|---|
| 密码存储 | PBKDF2-SHA256，100,000 次迭代，16 字节随机盐；不存明文，校验为常数时间比较，不存在的账号走等价虚拟哈希防时序枚举 |
| 防爆破 | 按「来源 IP + 账号」与「账号」双维度计数：失败 3 次起分级延迟（2s → 300s），IP 维度满 10 次锁定 15 分钟；等待期直接回 `429 + Retry-After`；账号维度只延迟不硬锁，防管理员被锁死 |
| Session | 256 位随机令牌，D1 只存 SHA-256；Cookie `__Host-session`（HttpOnly / Secure / SameSite=Strict），绝对过期 12h、空闲过期 30min，绑定 UA 指纹，登录轮换、登出注销 |
| CSRF | 管理员写操作校验面板注入的 `X-CSRF-Token`；设置向导用无状态签名 nonce；全站响应带 `no-store`、`nosniff`、`X-Frame-Options: DENY` |
| 凭证分离 | 管理员与 agent 两套独立凭证：`AGENT_TOKEN` 只能拉配置、上报、下脚本，进不了面板与管理员 API；管理员被锁不影响 agent 心跳 |
| 默认口令 | 旧版 `admin888` 已移除；未配置任何管理员凭证时登录回 503 |

接口分层：

- **公开**：`GET /health`、`GET /api/countries`、`/login`、`/setup`（仅未设置密码时开放）
- **agent**（Basic `agent:<AGENT_TOKEN>` 或 Bearer）：`GET /api/config`、`POST /api/report`、`GET /scripts/*.py`、`GET /agent`、`GET /uninstall`
- **管理员**（Session，写操作加 CSRF）：`GET /`、`GET /api/nodes`、`GET /api/proxies`、`GET|POST /api/config`、`POST /api/switch`

## 进阶

### D1 自动置备

wrangler.toml 的 D1 绑定只写 `binding = "DB"`，不写库名与 ID。
Wrangler（≥ 4.45）首次部署时按 Worker 名自动创建专属 D1 并绑定，
后续部署自动复用；仓库里不出现任何固定库名或 ID。

### 同账号多实例

同一账号下可用不同 Worker 名部署多套实例，D1 会随实例名自动新建，
数据天然隔离；每个实例的机密需按实例分别设置：

```bash
WORKER_NAME=proxy-a npm run deploy:named        # 等价 wrangler deploy --name proxy-a
npx wrangler secret put AGENT_TOKEN --name proxy-a
```

可选覆盖（`tools/deploy.mjs`，一般用不上）：`WORKER_NAME=<name> npm run deploy:vars`
改实例名；`DATABASE_ID=<uuid> npm run deploy:vars` 手动指定现成的 D1（填了就不再自动置备）。

### 找回 / 重置管理员密码

删除后台的 `ADMIN_PASS_HASH` 机密，并删除 D1 `auth_config` 表中
`admin_pass_hash` 与 `admin_pass_fp` 两行，`/setup` 向导会重新开放。

### 从旧版迁移

- 只设了旧 `WEB_PASS` 时，首次登录会自动把它引导为 D1 中的 PBKDF2 哈希，
  之后只走哈希校验；迁移后建议改用 `ADMIN_PASS_HASH` + `AGENT_TOKEN` 并删除 `WEB_PASS`。
- 存量 VPS 的旧 agent 继续以 `WEB_USER:WEB_PASS` 作为 agent 凭证被接受，不会掉线。

## 本地开发与测试

```bash
# .dev.vars（不要提交）：ADMIN_PASS_HASH / AGENT_TOKEN / PROXY_PASS
npm run dev
npm test
BASE_URL=http://127.0.0.1:8787 ADMIN_PASS='...' AGENT_TOKEN='...' node tests/e2e.mjs
BASE_URL=http://127.0.0.1:8789 node tests/setup.e2e.mjs   # 对未设密码的实例运行
```
