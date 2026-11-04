#!/usr/bin/env node
// 变量驱动部署（可选）：默认什么变量都不用设——
// D1 走 Wrangler 自动置备（wrangler.toml 只留 binding，部署时按 Worker 名
// 自动创建并绑定专属库），Worker 名用 wrangler.toml 里的默认值。
//
// 需要时可用环境变量覆盖（Cloudflare Workers Builds 里填「构建变量」，
// 或本地用环境变量）：
//   WORKER_NAME  覆盖 Worker 名字（D1 自动置备的库名随之按新名字生成）
//   DATABASE_ID  手动指定一个现成的 D1 库（填写后不再自动置备）
//
// 用法：
//   node tools/deploy.mjs [wrangler deploy 的其它参数]
// 替换只发生在生成的 wrangler.deploy.toml（已 gitignore），不改源文件。
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SRC = "wrangler.toml";
const OUT = "wrangler.deploy.toml";
const { DATABASE_ID, WORKER_NAME } = process.env;

let args = ["deploy"];
if (DATABASE_ID || WORKER_NAME) {
  let toml = fs.readFileSync(SRC, "utf8");
  if (WORKER_NAME) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(WORKER_NAME)) {
      console.error(`WORKER_NAME 格式不对（小写字母/数字/连字符）：${WORKER_NAME}`);
      process.exit(1);
    }
    if (!/^name\s*=/m.test(toml)) { console.error("wrangler.toml 中没有 name 行"); process.exit(1); }
    toml = toml.replace(/^name\s*=.*$/m, `name = "${WORKER_NAME}"`);
    console.log(`[deploy] WORKER_NAME 已注入：${WORKER_NAME}`);
  }
  if (DATABASE_ID) {
    if (!/^[0-9a-fA-F-]{36}$/.test(DATABASE_ID)) {
      console.error(`DATABASE_ID 格式不对（应为 D1 的 UUID）：${DATABASE_ID}`);
      process.exit(1);
    }
    if (/^database_id\s*=/m.test(toml)) {
      toml = toml.replace(/^database_id\s*=.*$/m, `database_id = "${DATABASE_ID}"`);
    } else if (/^binding\s*=\s*"DB"/m.test(toml)) {
      toml = toml.replace(/^(binding\s*=\s*"DB".*)$/m, `$1\ndatabase_id = "${DATABASE_ID}"`);
    } else {
      console.error("wrangler.toml 中没有找到 D1 的 binding = \"DB\" 行");
      process.exit(1);
    }
    console.log(`[deploy] DATABASE_ID 已注入：${DATABASE_ID}（手动指定，覆盖自动置备）`);
  }
  fs.writeFileSync(OUT, toml);
  args = ["deploy", "-c", OUT];
} else {
  console.log("[deploy] 未设置 WORKER_NAME / DATABASE_ID：默认部署，D1 由 Wrangler 自动置备");
}

const extra = process.argv.slice(2);
const result = spawnSync("npx", ["wrangler", ...args, ...extra], { stdio: "inherit" });
process.exit(result.status ?? 1);
