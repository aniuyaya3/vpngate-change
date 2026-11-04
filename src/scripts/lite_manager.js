// Lite Manager 调度引擎源码（Python），自旧版 _worker.js 原样拆分。
// 内嵌的 C2 凭证改为独立的 agent 凭证（agentUser/agentToken），不再是管理员密码。
export function liteManagerPy({ domain, proxyPort, agentUser, agentToken }) {
  return `#!/usr/bin/env python3
import base64, csv, os, subprocess, threading, time, urllib.request, json, sys
from pathlib import Path

MAX_CONCURRENT_NODES = 1
API_URL = "https://www.vpngate.net/api/iphone/"
C2_URL = "${domain}"
AGENT_VERSION = "2.4.1"

WORKSPACE = Path("/opt/proxy_lite")
CONFIG_DIR = WORKSPACE / "configs"
AUTH_FILE = WORKSPACE / "auth.txt"
_PORT_FILE = WORKSPACE / ".port"


def _load_saved_port(default):
    """启动时读取上次持久化的监听端口，避免配置变更触发 os._exit 重启后归零导致无限重启。"""
    try:
        p = int(_PORT_FILE.read_text().strip())
        if 1 <= p <= 65535:
            return p
    except Exception:
        pass
    return default


BASE_PROXY_PORT = _load_saved_port(${proxyPort})
LOG_MAX_BYTES = 256 * 1024
REPORT_LOG_BYTES = 12 * 1024
MANAGER_LOG_FILE = WORKSPACE / "manager.log"

GOLDEN_NODES_FILE = WORKSPACE / "golden_nodes.json"
golden_nodes = {}
golden_lock = threading.Lock()
# 金库（极品保留库）容量机制：容量上限 + 淘汰到半（FIFO by added_at）
GOLDEN_MAX = 50        # 金库节点数上限
GOLDEN_TRIM_TO = 25    # 超上限时保留最新的 25 个，淘汰其余最旧
# 金库永久禁用名单：节点一旦失效立即移出金库并记入此名单，永不重新回收
GOLDEN_BANNED_FILE = WORKSPACE / "golden_banned.json"
golden_banned = set()
AUTO_DNS_HEAL = True   # 隧道存活但 DNS 异常时，是否自动把 /etc/resolv.conf 补为公共 DNS（仅在无公共解析器时动作）
RELEASED_AVOID_SEC = 120  # 应急释放的节点在多少秒内被“回避再次当选”（避免刚失败节点立刻回池重复踩坑）
# “掉线→上线”延迟优化参数
PROBE_TIMEOUT = 5         # 单次隧道 HTTP 探测超时（并行后，最坏耗时≈此值，替代原串行 4×8=32s）
HEALTHY_INTERVAL = 20     # 健康节点的检查间隔（原 60s：掉线后最坏要等 60s 才被发现）
SOFT_INTERVAL = 10        # 曾重试过（软失败）的节点收紧到此间隔，更早发现异常

WEB_USER = "${agentUser}"
WEB_PASS = "${agentToken}"

dynamic_slot_map = {0: "JP"}
control_mode = "auto"
manual_node_ip = ""
manual_status = ""
youtube_check_enabled = False
config_fetch_interval = 15
heartbeat_interval = 30
pool = {0: {"process": None, "ip": "", "country": "", "connected_at": 0, "connecting": False}}
pool_lock = threading.Lock()
public_ip = ""
_first_config_applied = False
_port_lock = threading.Lock()

# ---------- 模式隔离：连接代际与手动退避 ----------
_connect_epoch = 0            # 连接代际：任何使旧连接/在途拨号失效的策略变更都会递增
_epoch_lock = threading.Lock()
_manual_fail_count = 0        # 手动模式连续失败计数（退避计时用，不进自动黑名单）
_manual_next_retry_at = 0.0   # 手动模式下次允许重拨的时间戳
_manual_last_printed = ""     # 手动状态日志去重


def _bump_epoch():
    """递增连接代际。模式切换、手动节点变更、掐线等使旧连接失效的策略变更必须调用；
    旧代际的拨号线程检测到后静默退出，不触碰 pool/黑名单/状态（模式隔离的核心机制）。"""
    global _connect_epoch
    with _epoch_lock:
        _connect_epoch += 1
        return _connect_epoch


def _current_epoch():
    with _epoch_lock:
        return _connect_epoch


def _set_manual_status(s):
    """更新手动状态；日志只在状态变迁时打印（retry 倒计时每轮都变，只在进入时打印一次）。"""
    global manual_status, _manual_last_printed
    manual_status = s
    if s == _manual_last_printed:
        return
    if s.startswith("retrying:") and _manual_last_printed.startswith("retrying:"):
        return
    _manual_last_printed = s
    if "connecting" not in s and "connected" not in s:
        print(f"[-] 手动模式: {s} ({manual_node_ip or '(未选择)'})", flush=True)


def append_bounded_log(log_file, stream):
    try:
        with open(log_file, "a", buffering=1) as output:
            for line in iter(stream.readline, b""):
                output.write(line.decode("utf-8", errors="replace"))
                output.flush()
                if log_file.stat().st_size > LOG_MAX_BYTES:
                    content = log_file.read_bytes()[-LOG_MAX_BYTES // 2:]
                    log_file.write_bytes(b"[log truncated]\\n" + content)
    except:
        pass


def read_recent_log(log_file):
    try:
        return log_file.read_text(errors="replace")[-REPORT_LOG_BYTES:]
    except:
        return ""


def read_recent_logs():
    """面板实时日志：只返回 manager.log 最新 50 行，不再混入 journalctl / openvpn 日志。"""
    try:
        if MANAGER_LOG_FILE.exists():
            lines = MANAGER_LOG_FILE.read_text(errors="replace").splitlines()
            return "\\n".join(lines[-50:])
    except:
        pass
    return ""


class BoundedTee:
    def __init__(self, console, log_file):
        self.console = console
        self.log_file = log_file

    def write(self, value):
        try:
            self.console.write(value)
        except UnicodeEncodeError:
            try:
                if hasattr(self.console, "buffer"):
                    self.console.buffer.write(value.encode("utf-8", errors="replace"))
                else:
                    self.console.write(value.encode("ascii", errors="replace").decode("ascii"))
            except:
                pass
        try:
            self.console.flush()
        except:
            pass
        try:
            with open(self.log_file, "a", buffering=1) as output:
                output.write(value)
            if self.log_file.stat().st_size > LOG_MAX_BYTES:
                content = self.log_file.read_bytes()[-LOG_MAX_BYTES // 2:]
                self.log_file.write_bytes(b"[log truncated]\\n" + content)
        except:
            pass

    def flush(self):
        self.console.flush()


dead_ips = {}
# 失败计数与黑名单解耦：应急释放只弹出 dead_ips（解除冷却），保留计数，
# 使“释放→再失败”的节点冷却继续指数上升，最终达到上限彻底出局，避免无限慢循环。
failure_counts = {}

last_switch_timestamps = {0: 0}
global_node_reservoir = {}
reservoir_lock = threading.Lock()

_cached_snapshot = []
_last_harvest_time = 0

# 优化：国别退避与日志节流（减少空转与刷屏）
_country_exhausted = {}   # country -> 退避到期时间戳；该国别无候选时短时跳过该槽位，避免每 5s 空转刷屏
_last_reservoir_log = 0.0 # 蓄水池日志节流（原每 5s 打印一次，现约 60s 一次）
_recent_released = {}     # ip -> 应急释放时间戳；用于“刚释放节点 120s 回避”，防止失败节点立刻回池


def get_public_ip():
    global public_ip
    try:
        req = urllib.request.Request("https://api.ipify.org", headers={"User-Agent": "curl/7.68.0"})
        with urllib.request.urlopen(req, timeout=5) as res:
            public_ip = res.read().decode("utf-8").strip()
    except:
        public_ip = "Unknown_IP"


def get_c2_headers():
    auth_ptr = base64.b64encode(f"{WEB_USER}:{WEB_PASS}".encode()).decode()
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Authorization": f"Basic {auth_ptr}"
    }


# 失效换IP唤醒事件：health_check 掐线后立即唤醒 maintain_pool，无需等满 5s 循环
_wakeup = threading.Event()

# 分级冷却基准（秒）。同一节点连续失败会指数退避，避免坏节点被反复捞回。
_COOL_BASE = {"fault": 60, "datacenter": 7200, "verify": 120, "manual": 60}


def is_ip_blacklisted(ip):
    if ip in dead_ips:
        if time.time() < dead_ips[ip]["expire_at"]:
            return True
        else:
            del dead_ips[ip]
    return False


def add_to_blacklist(ip, country, reason="fault", duration=60):
    # 分级冷却：同一节点连续失败的次数越高，冷却越长（指数退避，上限 1 小时）。
    # 计数存于独立的 failure_counts，应急释放解除冷却时不清零，防止“释放→失败”慢循环。
    # 成功连接后请调用 clear_failure(ip) 清除计数，避免好节点被长期边缘化。
    base = _COOL_BASE.get(reason, duration)
    count = failure_counts.get(ip, 0) + 1
    failure_counts[ip] = count
    # 修正：上限取 max(3600, base)。原写死 3600 会把 datacenter 的 7200s(2h) 基准“吃掉”，
    # 导致“日志说冷却 2 小时、实际只冷却 1 小时”的不一致；现在 datacenter 稳定 2h，其余仍以 1h 封顶。
    cap = max(3600, base)
    cool = min(base * (2 ** (count - 1)), cap)
    dead_ips[ip] = {
        "country": country,
        "expire_at": time.time() + cool,
        "reason": reason,
        "count": count,
        "total_duration": cool,
    }


def clear_failure(ip):
    """连接成功后清除失败冷却计数，防止偶尔失败一次的好节点被长期边缘化。"""
    dead_ips.pop(ip, None)
    failure_counts.pop(ip, None)


def load_golden_nodes():
    global golden_nodes
    try:
        if GOLDEN_NODES_FILE.exists():
            with open(GOLDEN_NODES_FILE, 'r') as f:
                golden_nodes = json.load(f)
            print(f"[*] 成功加载，当前储备历史高质节点数: {len(golden_nodes)}", flush=True)
    except:
        pass
    global golden_banned
    try:
        if GOLDEN_BANNED_FILE.exists():
            with open(GOLDEN_BANNED_FILE, 'r') as f:
                golden_banned = set(json.load(f))
            print(f"[*] 成功加载金库永久禁用名单: {len(golden_banned)} 个", flush=True)
    except:
        pass


def save_golden_nodes():
    try:
        with open(GOLDEN_NODES_FILE, 'w') as f:
            json.dump(golden_nodes, f)
    except:
        pass


def save_golden_banned():
    try:
        with open(GOLDEN_BANNED_FILE, 'w') as f:
            json.dump(sorted(golden_banned), f)
    except:
        pass


def add_golden_node(node):
    with golden_lock:
        # 永久禁用名单中的节点绝不重新回收进金库（失效即永久淘汰）
        if node["ip"] in golden_banned:
            print(f"[-] 节点 {node['ip']} 已在金库永久禁用名单，跳过回收", flush=True)
            return
        # 记录“近期成功次数”作为质量权重：同一节点被反复验证可用则权重更高，
        # 选点时优先于仅凭 ping 排序的新节点（ping 低但常掉线的节点不再抢占先手）。
        prev = golden_nodes.get(node["ip"]) or {}
        golden_nodes[node["ip"]] = {
            "ip": node["ip"], "country": node["country"], "config": node["config"],
            "ping": node.get("ping", 9999), "added_at": time.time(),
            "succ": int(prev.get("succ", 0)) + 1,
            "fail": int(prev.get("fail", 0)),
            "last_used": time.time(),
        }
        # 金库保鲜：超过上限则按 added_at 保留最新的 GOLDEN_TRIM_TO 个，淘汰其余最旧
        if len(golden_nodes) > GOLDEN_MAX:
            by_time = sorted(golden_nodes.values(), key=lambda x: x.get("added_at", 0), reverse=True)
            keep_ips = {n["ip"] for n in by_time[:GOLDEN_TRIM_TO]}
            trimmed = [ip for ip in golden_nodes if ip not in keep_ips]
            for ip in trimmed:
                del golden_nodes[ip]
            print(f"[*] 金库已达上限({GOLDEN_MAX})，已淘汰 {len(trimmed)} 个最旧节点，保留最新 {GOLDEN_TRIM_TO} 个", flush=True)
    save_golden_nodes()


def remove_golden_node(ip, reason="fault"):
    """金库节点失效处理：立即移出金库并记入失效排除名单。
    被排除的节点不再参与金库回收，也不进入蓄水池竞选；但不进 dead_ips 黑名单。"""
    with golden_lock:
        if ip in golden_nodes:
            del golden_nodes[ip]
        golden_banned.add(ip)
    save_golden_nodes()
    save_golden_banned()
    print(f"[*] 金库节点 {ip} 失效({reason})，已移出金库并排除出蓄水池竞选，不再回收", flush=True)


def ensure_public_dns():
    """DNS 自愈：仅当 /etc/resolv.conf 里没有任何公共解析器时才写入 8.8.8.8/1.1.1.1，
    避免覆盖用户既有配置。用于修复“隧道网络层正常、只是本机 DNS 被配成非递归解析器”导致的联通假阴性。"""
    if not AUTO_DNS_HEAL:
        return False
    path = Path("/etc/resolv.conf")
    try:
        content = path.read_text(errors="replace")
    except Exception:
        return False
    publics = ("8.8.8.8", "8.8.4.4", "1.1.1.1", "9.9.9.9", "223.5.5.5", "119.29.29.29")
    if any(ns in content for ns in publics):
        return False
    try:
        backup = Path("/etc/resolv.conf.bak")
        if not backup.exists():
            backup.write_text(content)
        path.write_text("nameserver 8.8.8.8\\nnameserver 1.1.1.1\\n")
        print("[*] 节点本地 DNS 异常（无公共解析器），已自动改写 /etc/resolv.conf 为 8.8.8.8/1.1.1.1", flush=True)
        return True
    except Exception:
        return False


def tunnel_probe_parallel(dev, targets, timeout=PROBE_TIMEOUT):
    """并行探测多个 HTTP 目标，任一成功即判定隧道存活。
    原实现串行 curl -m 8，最坏 len(targets)*8s（4 个 = 32s）——这是“掉线→上线”
    感知延迟的最大单点。并行后：健康时 ≈1s 即返回，全断时最坏 ≈ timeout。
    只要有一个探测成功就立即返回，不等待其余慢目标。"""
    hit = {"ok": False}
    lock = threading.Lock()

    def _probe(t):
        try:
            r = subprocess.run(
                ["curl", "-s", "-I", "-m", str(timeout), "--interface", dev, t],
                capture_output=True,
            )
            if r.returncode == 0:
                with lock:
                    hit["ok"] = True
        except Exception:
            pass

    for t in targets:
        threading.Thread(target=_probe, args=(t,), daemon=True).start()
    deadline = time.time() + timeout + 1
    while time.time() < deadline:
        if hit["ok"]:
            return True
        time.sleep(0.15)
    return hit["ok"]


def tcp_alive(dev, host, port, timeout=4):
    """不依赖 DNS 的 TCP 存活探测：绑定指定隧道接口直连 IP:端口。
    用于区分“隧道真的断了”与“隧道活着、只是 DNS 解析坏了”——后者绝不能判掉线误杀好节点。"""
    try:
        import socket as _s
        s = _s.socket(_s.AF_INET, _s.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            # SO_BINDTODEVICE=25：强制从指定隧道口出，与 proxy_server.create_connection 一致。
            s.setsockopt(_s.SOL_SOCKET, 25, dev.encode("utf-8"))
        except Exception:
            s.close()
            return False   # 无法绑定隧道则不予采信，避免走主路由造成“假存活”
        try:
            s.connect((host, port))
            return True
        finally:
            try:
                s.close()
            except Exception:
                pass
    except Exception:
        return False


def fetch_config():
    req = urllib.request.Request(f"{C2_URL}/api/config", headers=get_c2_headers())
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def apply_config(data):
    """多服务器独立策略：按本机公网 IP 匹配 servers 配置，命中则用之，否则用 defaults。"""
    global dynamic_slot_map, last_switch_timestamps, BASE_PROXY_PORT, control_mode, manual_node_ip, youtube_check_enabled, config_fetch_interval, heartbeat_interval, _first_config_applied, manual_status, _manual_fail_count, _manual_next_retry_at, _manual_last_printed
    servers_cfg = data.get("servers") or {}
    defaults_cfg = data.get("defaults") or {}
    my_cfg = servers_cfg.get(public_ip) or {}
    def pick(key, default):
        v = my_cfg.get(key, None)
        if v is None or v == "":
            v = defaults_cfg.get(key, default)
        return v
    new_port = pick("port", 10001)
    try:
        new_port = int(new_port)
    except:
        new_port = BASE_PROXY_PORT
    if not (1 <= new_port <= 65535):
        new_port = BASE_PROXY_PORT
    with _port_lock:
        port_changed = (new_port != BASE_PROXY_PORT)
        first_sync = not _first_config_applied
        if port_changed:
            if first_sync:
                print(f"[*] 启动时同步监听端口: {BASE_PROXY_PORT} -> {new_port}（首次同步，直接采用不重启）", flush=True)
            else:
                print(f"[*] 本机({public_ip})监听端口变更: {BASE_PROXY_PORT} -> {new_port}，准备重启服务...", flush=True)
            try:
                _PORT_FILE.write_text(str(new_port))
            except Exception as e:
                print(f"[!] 端口持久化失败: {e}", flush=True)
            BASE_PROXY_PORT = new_port
        _first_config_applied = True
    if port_changed and not first_sync:
        os._exit(0)
    new_mode = "manual" if pick("mode", "auto") == "manual" else "auto"
    new_manual_node_ip = str(pick("manual_node_ip", "") or "").strip()
    mode_changed = new_mode != control_mode or (new_mode == "manual" and new_manual_node_ip != manual_node_ip)
    if mode_changed:
        # 模式/手动节点变更：旧连接与其在途拨号线程即刻过期，手动退避计数清零
        _manual_fail_count = 0
        _manual_next_retry_at = 0.0
        if new_mode == "auto":
            manual_status = ""
            _manual_last_printed = ""
        else:
            _set_manual_status("waiting: 切换中…")
    control_mode = new_mode
    manual_node_ip = new_manual_node_ip
    youtube_check_enabled = pick("youtube_check", False) is True
    config_fetch_interval = max(5, min(3600, int(data.get("config_fetch_interval", 15))))
    heartbeat_interval = max(10, min(3600, int(data.get("heartbeat_interval", 30))))
    new_country = str(pick("country", "JP") or "JP").upper()
    fs_map = data.get("force_switch") or {}
    my_fs = fs_map.get(public_ip, {}) if isinstance(fs_map, dict) else {}
    force_switch = {}
    try:
        force_switch = {int(k): int(v) for k, v in my_fs.items()}
    except:
        pass
    with pool_lock:
        killed_any = False
        for slot in range(MAX_CONCURRENT_NODES):
            desired_country = new_country
            dynamic_slot_map[slot] = desired_country
            info = pool[slot]
            cmd_ts = force_switch.get(slot, 0)
            should_switch = False
            if cmd_ts > last_switch_timestamps.get(slot, 0):
                last_switch_timestamps[slot] = cmd_ts
                should_switch = True
                print("[*] ⚡ 接收到母机手动干预指令: 强制刷新单端口网络层IP！", flush=True)
            if info["process"] and info["process"].poll() is None:
                current_country = info.get("country", "")
                # 手动模式下国家策略不适用：只响应模式/手动节点变更与强制切换，避免自动逻辑掐手动的线
                country_mismatch = (control_mode == "auto" and current_country and current_country != desired_country)
                if country_mismatch or should_switch or mode_changed:
                    if not should_switch and not mode_changed:
                        print(f"[*] 策略变更触发: 需要从 {current_country} 切换到 {desired_country}，正在掐断旧连接...", flush=True)
                    # 模式切换的掐线不是故障；手动钉选的节点也不是故障：都不进自动冷却黑名单
                    pinned_manual = (control_mode == "manual" and info["ip"] and info["ip"] == manual_node_ip)
                    if info["ip"] and not pinned_manual and not mode_changed:
                        add_to_blacklist(info["ip"], info["country"], reason="manual", duration=60)
                    try:
                        info["process"].terminate()
                        info["process"].wait(timeout=2)
                    except:
                        try:
                            info["process"].kill()
                        except:
                            pass
                    info["process"] = None
                    info["ip"] = ""
                    info["country"] = ""
                    killed_any = True
        if mode_changed or killed_any:
            # 代际递增后，旧代际的在途拨号线程必定静默退出（finally 被代际保护），
            # 它们置起的 connecting 标记必须在这里回收，否则槽位永久卡死不再拨号。
            for slot in range(MAX_CONCURRENT_NODES):
                pool[slot]["connecting"] = False
            _bump_epoch()


def update_config_loop():
    while True:
        try:
            apply_config(fetch_config())
        except:
            pass
        time.sleep(config_fetch_interval)


def build_applied_info():
    """当前实际生效的配置（供面板对比“下发 vs 实际”）。"""
    return {
        "country": dynamic_slot_map.get(0, "UN"),
        "port": BASE_PROXY_PORT,
        "mode": control_mode,
        "manual_node_ip": manual_node_ip,
        "manual_status": manual_status,
    }


def c2_heartbeat_loop():
    if not public_ip or public_ip == "Unknown_IP":
        get_public_ip()
    try:
        payload = json.dumps({"ip": public_ip, "version": AGENT_VERSION, "applied": build_applied_info(), "details": [], "log": read_recent_logs()}).encode('utf-8')
        req = urllib.request.Request(f"{C2_URL}/api/report", data=payload, headers=get_c2_headers(), method='POST')
        urllib.request.urlopen(req, timeout=10)
    except:
        pass
    while True:
        time.sleep(heartbeat_interval)
        if not public_ip or public_ip == "Unknown_IP":
            get_public_ip()
        details = []
        with pool_lock:
            for slot, info in pool.items():
                if info["process"] and info["process"].poll() is None:
                    uptime = time.time() - info["connected_at"]
                    if uptime > 10:
                        actual_country = info.get("country", dynamic_slot_map.get(slot, "UN"))
                        details.append({"slot": slot, "country": actual_country, "port": BASE_PROXY_PORT, "connected_time": int(uptime), "node_ip": info["ip"]})
        with reservoir_lock:
            candidates = [{"ip": n["ip"], "country": n["country"], "ping": n.get("ping", 9999)} for n in global_node_reservoir.values() if n.get("ip") and not is_ip_blacklisted(n["ip"])]
        candidates.sort(key=lambda n: n["ping"])
        payload = json.dumps({"ip": public_ip, "version": AGENT_VERSION, "applied": build_applied_info(), "details": details, "log": read_recent_logs(), "candidates": candidates[:500]}).encode('utf-8')
        try:
            req = urllib.request.Request(f"{C2_URL}/api/report", data=payload, headers=get_c2_headers(), method='POST')
            urllib.request.urlopen(req, timeout=10)
            print(f"[*] 成功向心跳控制塔汇报。连通率: {len(details)} / 1", flush=True)
        except:
            pass

def setup_env():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    sys.stdout = BoundedTee(sys.__stdout__, MANAGER_LOG_FILE)
    sys.stderr = BoundedTee(sys.__stderr__, MANAGER_LOG_FILE)
    if not AUTH_FILE.exists():
        AUTH_FILE.write_text("vpn\\nvpn\\n")
        AUTH_FILE.chmod(0o600)
    load_golden_nodes()


def harvest_snapshot_nodes() -> list:
    global _cached_snapshot, _last_harvest_time
    if time.time() - _last_harvest_time < 300 and _cached_snapshot:
        return _cached_snapshot
    try:
        req = urllib.request.Request(API_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as res:
            text = res.read().decode("utf-8", errors="replace")
        lines = [line for line in text.splitlines() if line and not line.startswith("*")]
        if lines and lines[0].startswith("#"):
            lines[0] = lines[0][1:]
        nodes = []
        for row in csv.DictReader(lines):
            ip = row.get("IP")
            if not ip or not row.get("OpenVPN_ConfigData_Base64"):
                continue
            raw_ping = row.get("Ping", "")
            nodes.append({
                "ip": ip, "ping": int(raw_ping) if raw_ping.isdigit() else 9999,
                "country": row.get("CountryShort", "").upper(),
                "config": base64.b64decode(row["OpenVPN_ConfigData_Base64"]).decode("utf-8", errors="replace"),
                "harvested_at": time.time()
            })
        if nodes:
            _cached_snapshot = nodes
            _last_harvest_time = time.time()
        return _cached_snapshot
    except:
        return _cached_snapshot


def setup_routing(slot: int):
    dev, table = f"tun{slot}", str(100 + slot)
    subprocess.run(["ip", "rule", "del", "table", table], capture_output=True)
    subprocess.run(["ip", "route", "flush", "table", table], capture_output=True)
    subprocess.run(["ip", "route", "add", "default", "dev", dev, "table", table], capture_output=True)
    subprocess.run(["ip", "rule", "add", "oif", dev, "table", table], capture_output=True)


def connect_slot(slot: int, node: dict, epoch: int, is_manual: bool):
    """拨号线程。epoch=出生代际：若与当前代际不符，说明模式/策略已变更，
    必须静默退出，不得触碰 pool、黑名单与 manual_status（模式隔离的核心）。
    is_manual=True 时跳过自动模式的质量门禁（住宅鉴定/YouTube/故障冷却），
    用户钉选即最高优先级；重拨节奏由手动退避计时器控制。"""
    global manual_status, _manual_fail_count, _manual_next_retry_at
    def _stale():
        return epoch != _current_epoch()
    def _kill_proc(p):
        try:
            p.terminate()
            p.wait(timeout=2)
        except:
            try:
                p.kill()
            except:
                pass
    if _stale():
        return
    try:
        dev, cfg_path, log_file = f"tun{slot}", CONFIG_DIR / f"tun{slot}.ovpn", WORKSPACE / f"ovpn_err_{slot}.log"
        cfg_path.write_text(node["config"])
        ovpn_version = subprocess.run(["openvpn", "--version"], capture_output=True, text=True).stdout
        cipher_args = ["--ncp-ciphers", "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305"] if "2.4" in ovpn_version else ["--data-ciphers", "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305", "--data-ciphers-fallback", "AES-128-CBC"]
        cmd = ["openvpn", "--config", str(cfg_path), "--dev", dev, "--dev-type", "tun", "--pull-filter", "ignore", "route-ipv6", "--pull-filter", "ignore", "ifconfig-ipv6", "--route-nopull", "--auth-user-pass", str(AUTH_FILE), "--auth-nocache", "--connect-timeout", "6", "--connect-retry-max", "1", "--verb", "3"] + cipher_args
        log_file.write_text("")
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=append_bounded_log, args=(log_file, process.stdout), daemon=True).start()
        success = False
        # 先给 openvpn 一点时间产生首行输出，再以 0.5s 粒度轮询，并只读日志尾部，降低延迟。
        time.sleep(0.4)
        for _ in range(35):
            try:
                with open(log_file, "rb") as lf:
                    lf.seek(0, 2)
                    size = lf.tell()
                    lf.seek(max(0, size - 2048))
                    tail = lf.read().decode("utf-8", "replace")
                if "Initialization Sequence Completed" in tail:
                    success = True
                    break
            except:
                pass
            if process.poll() is not None:
                break
            time.sleep(0.4)
        if _stale():
            _kill_proc(process)
            return
        if success and process.poll() is None:
            if is_manual:
                print(f"[*] 手动模式: 隧道已打通，直接采用钉选节点 {node['ip']}（跳过自动质量门禁）", flush=True)
            else:
                is_residential = True
                try:
                    print(f"[*] 单端口 ({node['country']}) 隧道初步打通，鉴定是否为纯正住宅IP...", flush=True)
                    # 关键修正：VPN Gate 上报表里的 node['ip'] 常是运营商NAT的服务器管理地址，
                    # 不等于隧道真实出口IP。必须先经 tun 接口查出真实出口 IP 再鉴定，否则大量
                    # 真正可用的住宅出口会被误判为机房IP而误隔离。
                    real_probe_ip = node["ip"]
                    try:
                        probe = subprocess.run(
                            ["curl", "-s", "-m", "5", "--interface", f"tun{slot}", "https://api.ipify.org"],
                            capture_output=True, timeout=6,
                        )
                        out = probe.stdout.decode("utf-8", "replace").strip()
                        if out and len(out) <= 45 and "." in out:
                            real_probe_ip = out
                    except:
                        pass
                    req_url = f"https://ip.net.coffee/ip/{real_probe_ip}"
                    check_req = urllib.request.Request(req_url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(check_req, timeout=6) as check_res:
                        api_resp = check_res.read().decode("utf-8").lower()
                        if "residential" in api_resp or "isp" in api_resp or "住宅" in api_resp:
                            is_residential = True
                        else:
                            clean_resp = api_resp.replace(" ", "").replace("\\n", "").replace("\\r", "")
                            if "hosting" in api_resp or "datacenter" in api_resp or "机房" in api_resp or "data center" in api_resp:
                                if '"hosting":false' not in clean_resp and '"datacenter":false' not in clean_resp:
                                    is_residential = False
                except:
                    pass
                if not is_residential:
                    # 所有可用节点必须为纯正住宅属性：机房/数据中心 IP 一律拒绝，
                    # 金库节点同样不豁免（无免死特权），并按失效处理移出金库。
                    print(f"[-] 单端口 ({node['country']}) 检测为机房IP，拒绝使用并冷却(2小时): {node['ip']}", flush=True)
                    if node["ip"] in golden_nodes:
                        remove_golden_node(node["ip"], reason="datacenter")
                    if _stale():
                        _kill_proc(process)
                        return
                    _kill_proc(process)
                    add_to_blacklist(node["ip"], node["country"], reason="datacenter", duration=7200)
                    return
            setup_routing(slot)
            if not is_manual and youtube_check_enabled:
                print(f"[*] 单端口 ({node['country']}) 核验通过，执行 YouTube 业务连通性测试...", flush=True)
                services_passed = True
                test_urls = ["https://www.youtube.com"]
                for test_url in test_urls:
                    res = subprocess.run(["curl", "-s", "-I", "-m", "5", "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "--interface", f"tun{slot}", test_url], capture_output=True)
                    if res.returncode != 0:
                        print(f"[-] 单端口 ({node['country']}) 访问 {test_url} 阻断/超时，临时冷却: {node['ip']}", flush=True)
                        services_passed = False
                        break
                if not services_passed:
                    if _stale():
                        _kill_proc(process)
                        return
                    _kill_proc(process)
                    add_to_blacklist(node["ip"], node["country"], reason="fault", duration=60)
                    # 组合2：金库节点业务核验失败 → 移出金库，避免僵尸节点反复当选
                    if not is_manual and node["ip"] in golden_nodes:
                        remove_golden_node(node["ip"], reason="youtube_check")
                    return
            if not is_manual:
                add_golden_node(node)
            if _stale():
                _kill_proc(process)
                return
            clear_failure(node["ip"])
            with pool_lock:
                pool[slot]["process"] = process
                pool[slot]["ip"] = node["ip"]
                pool[slot]["country"] = node["country"]
                pool[slot]["connected_at"] = time.time()
                pool[slot]["last_checked_at"] = 0.0   # 首次检查由 health_check 快速安排
                pool[slot]["check_interval"] = HEALTHY_INTERVAL
            print(f"[+] 单端口 ({node['country']}) 优质IP完全就绪入池: {node['ip']}", flush=True)
            if is_manual:
                manual_status = f"connected: {node['ip']}"
                _manual_fail_count = 0
        else:
            _kill_proc(process)
            if is_manual:
                # 手动节点不进自动黑名单：由退避计时器控制重拨节奏，避免“cooling”卡死
                if not _stale():
                    _manual_fail_count += 1
                    wait_s = min(300, 10 * (2 ** (_manual_fail_count - 1)))
                    _manual_next_retry_at = time.time() + wait_s
                    manual_status = f"retrying: {node['ip']} 连接失败，{wait_s}s后重拨 (连续失败{_manual_fail_count}次)"
                    print(f"[-] 手动模式: {manual_status}", flush=True)
            elif not _stale():
                add_to_blacklist(node["ip"], node["country"], reason="fault", duration=60)
                # 组合2：金库节点拨号失败 → 移出金库，避免失效旧IP反复试错
                if node["ip"] in golden_nodes:
                    remove_golden_node(node["ip"], reason="dial_fail")
    finally:
        # 过期线程不得清除新代际的 connecting 标记（否则会导致重复拨号）
        with pool_lock:
            if epoch == _current_epoch():
                pool[slot]["connecting"] = False


def health_check_loop():
    global _manual_fail_count, _manual_next_retry_at, manual_status
    test_targets = [
        "http://www.gstatic.com/generate_204",
        "http://captive.apple.com/hotspot-detect.html",
        "https://www.cloudflare.com/cdn-cgi/trace",
        "http://www.msftconnecttest.com/connecttest.txt"
    ]
    while True:
        time.sleep(5)   # 基础轮询 5s（原 10s）：与检查间隔对齐，缩小掉线感知粒度
        slots_to_check = []
        with pool_lock:
            for slot, info in pool.items():
                proc = info["process"]
                if not proc or proc.poll() is not None:
                    continue
                now = time.time()
                # 去掉旧的 60s 保护盲区：连接后 10s 内安排首次检测，之后按 check_interval 动态间隔。
                age = now - info.get("connected_at", now)
                interval = info.get("check_interval", HEALTHY_INTERVAL)
                last = info.get("last_checked_at", 0) or 0
                if age >= 10 and (now - last) >= interval:
                    slots_to_check.append((slot, proc, info.get("ip", ""), dynamic_slot_map.get(slot, "UN")))
        for _idx, (slot, process, ip, country) in enumerate(slots_to_check):
            if _idx:
                time.sleep(min(_idx * 0.4, 2.0))   # 轻量错峰：避免多槽位同轮齐发，同时尽量少拖慢后续槽位
            failed = True
            attempts_used = 0
            for attempt in range(3):
                attempts_used = attempt + 1
                alive = False
                dns_suspect = False
                # 通道1：并行探测 4 个目标（原串行最坏 32s，现在最坏 ≈ PROBE_TIMEOUT=5s）
                alive = tunnel_probe_parallel(f"tun{slot}", test_targets, PROBE_TIMEOUT)
                # 通道1b：DNS 无关的 TCP 兜底（直连 8.8.8.8:53）。
                # 若 HTTP 全败但 TCP 直连通，说明隧道网络层活着、只是 DNS 解析坏了，
                # 绝不能判掉线误杀好节点——顺手尝试自愈 resolv.conf。
                if not alive and tcp_alive(f"tun{slot}", "8.8.8.8", 53):
                    alive = True
                    dns_suspect = True
                    ensure_public_dns()
                if alive:
                    if dns_suspect:
                        print(f"[!] 单端口 {slot} 隧道存活但 DNS 解析异常（HTTP 探测全败、TCP 直连正常），已尝试自愈，暂不判掉线: {ip}", flush=True)
                    # 通道2：SOCKS5 代理进程存活检测（TCP 端口探测）。
                    # 注意：不做完整 HTTP 转发测试，因为单次转发易因目标站点偶发超时而误报，
                    # 且“重启代理监听”对已占用端口的旧线程实际无效——旧监听线程是 daemon 且仍在
                    # accept，新 start_proxy_server 因端口占用会静默 return，只会刷屏无效果。
                    # 因此这里仅在端口确实无监听时才判定 SOCKS5 失效并尝试重启。
                    port_alive = False
                    try:
                        import socket as _sock
                        _hp = _sock.socket(_sock.AF_INET, _sock.SOCK_STREAM)
                        _hp.settimeout(2)
                        _hp.connect(("127.0.0.1", BASE_PROXY_PORT))
                        _hp.close()
                        port_alive = True
                    except Exception:
                        port_alive = False
                    if not port_alive:
                        print(f"[!] SOCKS5 代理端口 {BASE_PROXY_PORT} 无监听，尝试重启: tunnel {slot}", flush=True)
                        try:
                            import proxy_server
                        except Exception:
                            proxy_server = None
                        if proxy_server:
                            threading.Thread(
                                target=proxy_server.start_proxy_server,
                                args=("0.0.0.0", BASE_PROXY_PORT, f"tun{slot}"), daemon=True).start()
                    # 网络层存活即视为通过（SOCKS5 只作信息性探测，不作掉线依据）
                    failed = False
                    break
                time.sleep(2)
            now = time.time()
            if failed:
                print(f"[!] 单端口网络 连续多次均失败！判定掉线重拨: {ip}", flush=True)
                if control_mode == "manual" and ip and ip == manual_node_ip:
                    # 手动钉选节点：不进自动故障冷却，由退避计时器安排重拨同一节点
                    _manual_fail_count += 1
                    wait_s = min(300, 10 * (2 ** (_manual_fail_count - 1)))
                    _manual_next_retry_at = time.time() + wait_s
                    manual_status = f"retrying: {ip} 掉线，{wait_s}s后重拨 (连续失败{_manual_fail_count}次)"
                else:
                    # 分级冷却：失败越多次，冷却越久
                    add_to_blacklist(ip, country, reason="fault")
                    # 组合2 一致性：健康检查确认掉线的节点同样移出金库，
                    # 失效即排除，不再回收复用。
                    with golden_lock:
                        _was_golden = ip in golden_nodes
                    if _was_golden:
                        remove_golden_node(ip, reason="health_check")
                try:
                    process.terminate()
                    process.wait(timeout=2)
                except:
                    try:
                        process.kill()
                    except:
                        pass
                # 立即唤醒 maintain_pool，缩短换 IP 反应时间
                with pool_lock:
                    pool[slot]["process"] = None
                _wakeup.set()
            else:
                # 健康：动态调整检查间隔（一次探测即通则 60s；曾重试过（软失败）则收紧到 30s 更早发现异常）
                with pool_lock:
                    if slot in pool:
                        pool[slot]["last_checked_at"] = now
                        pool[slot]["check_interval"] = HEALTHY_INTERVAL if attempts_used <= 1 else SOFT_INTERVAL


def maintain_pool():
    global dead_ips, global_node_reservoir, golden_nodes, manual_status
    global _country_exhausted, _last_reservoir_log
    while True:
        snapshot = harvest_snapshot_nodes()
        with reservoir_lock:
            for n in snapshot:
                global_node_reservoir[n["ip"]] = n
            now = time.time()
            stale_ips = [ip for ip, node in global_node_reservoir.items() if now - node["harvested_at"] > 10800]
            for ip in stale_ips:
                global_node_reservoir.pop(ip, None)
            # 日志节流：原每 5s 打印一次会淹没 manager.log 与面板（面板只显示最新 50 行）；现约 60s 一次
            if now - _last_reservoir_log >= 60:
                _last_reservoir_log = now
                print(f"[*] ⚡ 蓄水池循环，当前大池常驻: {len(global_node_reservoir)} 个 (极品保留库: {len(golden_nodes)} 个, 失效排除: {len(golden_banned)} 个)", flush=True)
        empty_slots = []
        with pool_lock:
            for slot, info in pool.items():
                if not info["connecting"] and (info["process"] is None or info["process"].poll() is not None):
                    empty_slots.append(slot)
                    info["process"] = None
                    info["ip"] = ""
                    info["country"] = ""
        if empty_slots:
            with reservoir_lock:
                all_pool_nodes = sorted(list(global_node_reservoir.values()), key=lambda x: x.get("ping", 9999))
            with golden_lock:
                # 优化：金库偏好排序由“单纯按 ping”改为“近期成功次数优先，其次 ping”。
                # 这样被反复验证可用的高质节点先上，避免低延迟但爱掉线的节点抢占先手。
                all_golden_nodes = sorted(list(golden_nodes.values()), key=lambda x: (-int(x.get("succ", 0)), x.get("ping", 9999)))
            used_ips = [info["ip"] for info in pool.values() if info["ip"]]
            for slot in empty_slots:
                if control_mode == "manual":
                    # 手动模式：钉选节点不受自动黑名单（故障冷却/机房隔离）约束，
                    # 重拨节奏只由手动退避计时器控制——这就是手动与自动的隔离线。
                    if not manual_node_ip:
                        _set_manual_status("waiting: 未选择节点")
                    elif time.time() < _manual_next_retry_at:
                        remain = int(_manual_next_retry_at - time.time()) + 1
                        _set_manual_status(f"retrying: {remain}s后重拨")
                    else:
                        node = next((n for n in all_pool_nodes if n["ip"] == manual_node_ip and n["ip"] not in golden_banned), None)
                        if not node:
                            node = next((n for n in all_golden_nodes if n["ip"] == manual_node_ip and n["ip"] not in golden_banned), None)
                        if node is None:
                            _set_manual_status("waiting: 候选中无此节点")
                        elif node["ip"] in used_ips:
                            _set_manual_status("waiting: 节点已被占用")
                        else:
                            _set_manual_status(f"connecting: {node['ip']}")
                            used_ips.append(node["ip"])
                            spawn_ok = False
                            slot_epoch = _current_epoch()
                            with pool_lock:
                                if not pool[slot]["connecting"] and pool[slot]["process"] is None:
                                    pool[slot]["connecting"] = True
                                    slot_epoch = _current_epoch()
                                    spawn_ok = True
                            if spawn_ok:
                                threading.Thread(target=connect_slot, args=(slot, node, slot_epoch, True), daemon=True).start()
                            else:
                                used_ips.remove(node["ip"])
                    continue
                target_country = dynamic_slot_map.get(slot, "JP")
                if time.time() < _country_exhausted.get(target_country, 0):
                    continue   # 国别退避中：该国别无候选时短时跳过本站槽位，避免每 5s 空转刷屏
                candidates = [n for n in all_pool_nodes if n["country"] == target_country and n["ip"] not in used_ips and not is_ip_blacklisted(n["ip"]) and n["ip"] not in golden_banned]
                if not candidates:
                    golden_candidates = [n for n in all_golden_nodes if n["country"] == target_country and n["ip"] not in used_ips and not is_ip_blacklisted(n["ip"]) and n["ip"] not in golden_banned]
                    if golden_candidates:
                        print(f"[*] 🏆 主池枯竭，触发！正在提取历史高质 [{target_country}] 节点...", flush=True)
                        candidates = golden_candidates
                if not candidates:
                    now_ts = time.time()
                    country_blacklisted = [ip for ip, meta in list(dead_ips.items()) if meta["country"] == target_country and now_ts < meta["expire_at"] and meta["reason"]!= "datacenter"]
                    if country_blacklisted:
                        # 优化：只释放“已度过 ≥70% 冷却期”的近到期节点，最多 5 个。
                        # 避免原先“一键清空”把 5s 前刚失败的坏节点也放出来导致死循环。
                        releasable = []
                        for bip in country_blacklisted:
                            meta = dead_ips[bip]
                            remaining = meta["expire_at"] - now_ts
                            total = meta.get("total_duration", 60)
                            pct = 1 - (remaining / total) if total > 0 else 0
                            if pct >= 0.7:
                                releasable.append(bip)
                            if len(releasable) >= 5:
                                break
                        if releasable:
                            for bip in releasable:
                                dead_ips.pop(bip, None)
                                _recent_released[bip] = time.time()   # 记入“刚释放”名单，120s 内回避复选
                            print(f"[!] ⚡ 区域紧急熔断：[{target_country}] 储备枯竭，已应急释放 {len(releasable)} 个近到期节点救场！", flush=True)
                            candidates = [n for n in (all_pool_nodes + all_golden_nodes) if n["country"] == target_country and n["ip"] not in used_ips and not is_ip_blacklisted(n["ip"]) and n["ip"] not in golden_banned]
                # 优化：优先避开 120s 内“刚被应急释放”的节点——刚判失败的节点回池后立刻复用极易再次踩坑；
                # 若全部都在回避期内则退回原名单，保证不会因此空转。同时顺带清理过期回避条目。
                if len(_recent_released) > 256:
                    _cut = time.time() - RELEASED_AVOID_SEC * 3
                    for _ip in [k for k, v in list(_recent_released.items()) if v < _cut]:
                        _recent_released.pop(_ip, None)
                if candidates:
                    _now_r = time.time()
                    fresh = [n for n in candidates if _now_r - _recent_released.get(n["ip"], 0) >= RELEASED_AVOID_SEC]
                    if fresh:
                        candidates = fresh
                if candidates:
                    node = candidates.pop(0)
                    used_ips.append(node["ip"])
                    with pool_lock:
                        pool[slot]["connecting"] = True
                        slot_epoch = _current_epoch()
                    threading.Thread(target=connect_slot, args=(slot, node, slot_epoch, False), daemon=True).start()
                    time.sleep(0.5)
                else:
                    _country_exhausted[target_country] = time.time() + 10
                    print(f"[-] 单端口: [{target_country}] 本地配额打空，进入 10s 国别退避（减少空转与刷屏）...", flush=True)
        # 优化：用事件等待替代固定 5s sleep——health_check 掐线后会 set(_wakeup)，
        # 使故障能被立即感知并触发换 IP，而不是最多再等满 5s。
        _wakeup.wait(timeout=5)
        _wakeup.clear()


def main():
    if os.geteuid()!= 0:
        return
    get_public_ip()
    setup_env()
    subprocess.run(["pkill", "-f", "openvpn.*tun[0-9]"], capture_output=True)
    print("========================================", flush=True)
    print(" 免费住宅IP智能调度系统 [多服务器独立策略版] 启动！", flush=True)
    print(f" 本机公网 IP: {public_ip}", flush=True)
    print("========================================", flush=True)
    threading.Thread(target=update_config_loop, daemon=True).start()
    try:
        apply_config(fetch_config())
    except:
        pass
    import proxy_server
    for i in range(MAX_CONCURRENT_NODES):
        threading.Thread(target=proxy_server.start_proxy_server, args=("0.0.0.0", BASE_PROXY_PORT, f"tun{i}"), daemon=True).start()
    threading.Thread(target=health_check_loop, daemon=True).start()
    threading.Thread(target=c2_heartbeat_loop, daemon=True).start()
    maintain_pool()


if __name__ == "__main__":
    main()
`;
}
