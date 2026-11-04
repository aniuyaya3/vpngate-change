// D1 初始化与配置存取（表结构与旧版兼容，新增三张 auth 表）
export async function initDb(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS servers (
      ip TEXT PRIMARY KEY,
      details TEXT,
      log TEXT DEFAULT '',
      candidates TEXT DEFAULT '[]',
      last_seen INTEGER
    )
  `).run();
  try { await db.prepare(`ALTER TABLE servers ADD COLUMN log TEXT DEFAULT ''`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE servers ADD COLUMN candidates TEXT DEFAULT '[]'`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE servers ADD COLUMN version TEXT DEFAULT ''`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE servers ADD COLUMN applied TEXT DEFAULT ''`).run(); } catch (e) {}

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS global_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();

  // ---- 账号安全 ----
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS auth_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT,
      csrf TEXT,
      created_at INTEGER,
      last_seen INTEGER,
      expires_at INTEGER,
      ip TEXT,
      ua_hash TEXT
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      scope TEXT PRIMARY KEY,
      fails INTEGER,
      locked_until INTEGER,
      next_allowed_at INTEGER,
      updated_at INTEGER
    )
  `).run();
}

export async function readKV(db) {
  const kv = {};
  try {
    const { results } = await db.prepare(`SELECT key, value FROM global_config`).all();
    if (results) for (const row of results) kv[row.key] = row.value;
  } catch (e) {}
  return kv;
}

export async function writeKV(db, key, value) {
  await db.prepare(`
    INSERT INTO global_config (key, value) VALUES (?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, value).run();
}

// 单条服务器策略清洗（与旧版规则一致）
export function cleanEntry(e) {
  const entry = (e && typeof e === "object") ? e : {};
  const port = Number.parseInt(entry.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port");
  const country = String(entry.country || "JP").toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("country");
  return {
    country,
    port,
    mode: entry.mode === "manual" ? "manual" : "auto",
    manual_node_ip: typeof entry.manual_node_ip === "string" ? entry.manual_node_ip.trim() : "",
    youtube_check: entry.youtube_check === true
  };
}

export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
