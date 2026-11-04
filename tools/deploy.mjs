#!/usr/bin/env node
// 变量驱动部署：把环境变量注入 wrangler 配置后部署，
// 让同一份代码在不同仓库 / 不同 CF 项目里各自自定义。
//
// 支持的变量（在 Cloudflare Workers Builds 里填「构建变量」，本地用环境变量）：
//   DATABASE_ID  覆盖 wrangler.toml 中 D1 的 database_id
//   WORKER_NAME  覆盖 wrangler.toml 中的 Worker 名字（等价于 --name）
//
// 用法：
//   DATABASE_ID=<uuid> WORKER_NAME=<name> node tools/deploy.mjs [wrangler deploy 的其它参数]
// 未设置变量时不做替换，直接用 wrangler.toml 原样部署。
// 替换只发生在生成的 wrangler.deploy.toml（已 gitignore），不改源文件。
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SRC = "wrangler.toml";
const OUT = "wrangler.deploy.toml";
const { DATABASE_ID, WORKER_NAME } = process.env;

let args = ["deploy"];
if (DATABASE_ID || WORKER_NAME) {
  let toml = fs.readFileSync(SRC, "utf8");
  if (DATABASE_ID) {
    if (!/^[0-9a-fA-F-]{36}$/.test(DATABASE_ID)) {
      console.error(`DATABASE_ID 格式不对（应为 D1 的 UUID）：${DATABASE_ID}`);
      process.exit(1);
    }
    if (!/^database_id\s*=/m.test(toml)) { console.error("wrangler.toml 中没有 database_id 行"); process.exit(1); }
    toml = toml.replace(/^database_id\s*=.*$/m, `database_id = "${DATABASE_ID}"`);
    console.log(`[deploy] DATABASE_ID 已注入：${DATABASE_ID}`);
  }
  if (WORKER_NAME) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(WORKER_NAME)) {
      console.error(`WORKER_NAME 格式不对（小写字母/数字/连字符）：${WORKER_NAME}`);
      process.exit(1);
    }
    if (!/^name\s*=/m.test(toml)) { console.error("wrangler.toml 中没有 name 行"); process.exit(1); }
    toml = toml.replace(/^name\s*=.*$/m, `name = "${WORKER_NAME}"`);
    console.log(`[deploy] WORKER_NAME 已注入：${WORKER_NAME}`);
  }
  fs.writeFileSync(OUT, toml);
  args = ["deploy", "-c", OUT];
} else {
  console.log("[deploy] 未设置 DATABASE_ID / WORKER_NAME，使用 wrangler.toml 原样部署");
}

const extra = process.argv.slice(2);
const result = spawnSync("npx", ["wrangler", ...args, ...extra], { stdio: "inherit" });
process.exit(result.status ?? 1);
