// 业务 API（行为与旧版 _worker.js 保持一致，仅鉴权层在 router 中前置）
import { readKV, writeKV, cleanEntry } from "./db.js";

// [开放] 国家列表
export async function handleCountries() {
  try {
    const requestedCountries = [
      "AE","AR","AT","AU","BE","BD","BG","BH","BR","CA","CH","CL","CN","CO",
      "CR","CY","CZ","DE","DK","EE","EG","ES","FI","FR","GB","GR","HK","HR",
      "HU","ID","IE","IL","IN","IQ","IR","IS","IT","JM","JO","JP","KE","KH",
      "KR","KW","KZ","LA","LB","LK","LT","LU","LV","MA","MD","MM","MN","MO",
      "MX","MY","NG","NL","NO","NP","NZ","OM","PA","PE","PH","PK","PL","PT",
      "QA","RO","RS","RU","SA","SE","SG","SI","SK","TH","TR","TW","UA","US",
      "UY","UZ","VE","VN","ZA"
    ];
    const response = await fetch("https://www.vpngate.net/api/iphone/");
    const text = await response.text();
    const lines = text.split("\n");
    const countries = new Set(requestedCountries);
    for (let i = 2; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length > 6) {
        const country = parts[6];
        if (country && country.length === 2 && country !== "xx" && country !== "--") countries.add(country);
      }
    }
    return new Response(JSON.stringify(Array.from(countries)), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    return new Response(JSON.stringify(["JP", "KR", "US", "GB", "TW"]), { headers: { "Content-Type": "application/json" } });
  }
}

// 配置读取：管理员与 agent 均可（鉴权在 router）
export async function handleConfigGet(db, proxyPort) {
  const kv = await readKV(db);
  let servers = {};
  let defaults = null;
  let force_switch = {};
  try { if (kv.servers_config) servers = JSON.parse(kv.servers_config) || {}; } catch (e) {}
  try { if (kv.default_config) defaults = JSON.parse(kv.default_config); } catch (e) {}
  try { if (kv.force_switch) { const fs = JSON.parse(kv.force_switch); if (fs && typeof fs === "object") force_switch = fs; } } catch (e) {}

  // 旧版单机配置自动迁移为默认策略
  if (!defaults) {
    defaults = { country: "JP", port: proxyPort, mode: "auto", manual_node_ip: "", youtube_check: false };
    try {
      if (kv.slot_map) {
        const m = JSON.parse(kv.slot_map);
        const c = m[0] || m["0"];
        if (c && /^[A-Za-z]{2}$/.test(String(c))) defaults.country = String(c).toUpperCase();
      }
    } catch (e) {}
    if (kv.proxy_port) {
      const p = parseInt(kv.proxy_port, 10);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) defaults.port = p;
    }
    if (kv.mode === "manual") defaults.mode = "manual";
    if (kv.manual_node_ip) defaults.manual_node_ip = kv.manual_node_ip;
    if (kv.youtube_check === "true") defaults.youtube_check = true;
  }

  const num = (v, lo, hi, dft) => {
    const n = parseInt(v, 10);
    return Number.isInteger(n) ? Math.max(lo, Math.min(hi, n)) : dft;
  };
  return new Response(JSON.stringify({
    servers, defaults, force_switch,
    config_fetch_interval: num(kv.config_fetch_interval, 5, 3600, 15),
    heartbeat_interval: num(kv.heartbeat_interval, 10, 3600, 30),
    frontend_poll_interval: num(kv.frontend_poll_interval, 5, 300, 5)
  }), { headers: { "Content-Type": "application/json" } });
}

// 配置写入：管理员专属（router 已校验 Session + CSRF）
export async function handleConfigPost(db, request) {
  let data;
  try { data = await request.json(); } catch (e) { return new Response("Invalid JSON", { status: 400 }); }
  try {
    const rawServers = (data.servers && typeof data.servers === "object") ? data.servers : {};
    const servers = {};
    for (const [ip, entry] of Object.entries(rawServers)) {
      const cleanIp = String(ip).trim();
      if (!cleanIp) continue;
      servers[cleanIp] = cleanEntry(entry);
    }
    const defaults = cleanEntry(data.defaults || {});
    await writeKV(db, "servers_config", JSON.stringify(servers));
    await writeKV(db, "default_config", JSON.stringify(defaults));
    const num = (v, lo, hi, dft) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) ? Math.max(lo, Math.min(hi, n)) : dft;
    };
    await writeKV(db, "config_fetch_interval", String(num(data.config_fetch_interval, 5, 3600, 15)));
    await writeKV(db, "heartbeat_interval", String(num(data.heartbeat_interval, 10, 3600, 30)));
    await writeKV(db, "frontend_poll_interval", String(num(data.frontend_poll_interval, 5, 300, 5)));
    return new Response("OK");
  } catch (err) {
    return new Response("Invalid server entry: port must be 1-65535, country must be a 2-letter code.", { status: 400 });
  }
}

// 强制切换：管理员专属
export async function handleSwitch(db, request) {
  let data;
  try { data = await request.json(); } catch (e) { return new Response("Invalid JSON", { status: 400 }); }
  const serverIp = String(data.server_ip || "").trim();
  const targetSlot = String(data.slot ?? 0);
  if (!serverIp) return new Response("missing server_ip", { status: 400 });
  const kv = await readKV(db);
  let force_switch = {};
  try { if (kv.force_switch) { const fs = JSON.parse(kv.force_switch); if (fs && typeof fs === "object") force_switch = fs; } } catch (e) {}
  if (!force_switch[serverIp] || typeof force_switch[serverIp] !== "object") force_switch[serverIp] = {};
  force_switch[serverIp][targetSlot] = Date.now();
  await writeKV(db, "force_switch", JSON.stringify(force_switch));
  return new Response("OK");
}

// agent 心跳上报：agent 专属
export async function handleReport(db, request) {
  try {
    const data = await request.json();
    await db.prepare(`
      INSERT INTO servers (ip, details, log, candidates, version, applied, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(ip) DO UPDATE SET details = excluded.details, log = excluded.log, candidates = excluded.candidates, version = excluded.version, applied = excluded.applied, last_seen = excluded.last_seen
    `).bind(data.ip, JSON.stringify(data.details || []), String(data.log || "").slice(-12000), JSON.stringify(data.candidates || []).slice(0, 100000), String(data.version || ""), JSON.stringify(data.applied || {}).slice(0, 2000), Date.now()).run();
    return new Response("OK", { status: 200 });
  } catch (err) { return new Response("Error", { status: 500 }); }
}

// 代理列表：管理员专属
export async function handleProxies(db, proxyUser, proxyPass) {
  const cutoff = Date.now() - 120000;
  await db.prepare(`DELETE FROM servers WHERE last_seen < ?1`).bind(cutoff).run();
  const { results } = await db.prepare(`SELECT ip, details FROM servers`).all();
  let proxyList = [];
  if (results) {
    for (let server of results) {
      for (let node of JSON.parse(server.details)) {
        proxyList.push(`socks5://${proxyUser}:${proxyPass}@${server.ip}:${node.port}#${node.country}_Port${node.port}_${node.node_ip || "IP"}`);
      }
    }
  }
  return new Response(proxyList.join("\n"), { headers: { "Content-Type": "text/plain;charset=UTF-8" } });
}

// 节点列表：管理员专属
export async function handleNodes(db) {
  const cutoff = Date.now() - 120000;
  await db.prepare(`DELETE FROM servers WHERE last_seen < ?1`).bind(cutoff).run();
  const { results } = await db.prepare(`SELECT * FROM servers ORDER BY last_seen DESC`).all();
  return new Response(JSON.stringify((results || []).map(server => {
    let candidates = [];
    try { candidates = JSON.parse(server.candidates || "[]"); } catch (e) {}
    return { ...server, candidates };
  })), { headers: { "Content-Type": "application/json" } });
}
