// VPS 一键安装 / 卸载脚本（bash），自旧版 _worker.js 原样拆分。
// 拉取引擎时使用的凭证改为独立 agent 凭证。
export function agentScript({ domain, agentUser, agentToken, shq }) {
  return `#!/usr/bin/env bash
set -e
echo "=========================================================="
echo "    免费住宅IP智能调度系统 直连部署 (多服务器独立策略版)"
echo "=========================================================="

# ---------- 系统自动辨别 ----------
OS="unknown"
if [ -f /etc/alpine-release ]; then
  OS="alpine"
elif [ -f /etc/debian_version ]; then
  OS="debian"
elif [ -f /etc/os-release ]; then
  . /etc/os-release
  case "$ID" in
    alpine) OS="alpine" ;;
    debian|ubuntu|raspbian|linuxmint|pop) OS="debian" ;;
    *) case "$ID_LIKE" in *debian*|*ubuntu*) OS="debian" ;; esac ;;
  esac
fi
if [ "$OS" = "unknown" ]; then
  echo "[-] 无法识别的系统，仅支持 Debian/Ubuntu 与 Alpine。"
  exit 1
fi
echo "[*] 识别到系统类型: $OS"

# ---------- 安装依赖 ----------
if [ "$OS" = "alpine" ]; then
  apk update
  apk add --no-cache openvpn python3 curl iproute2 iptables
else
  apt-get update -q
  apt-get install -y openvpn python3 curl iproute2 iptables
fi

# ---------- 拉取引擎 ----------
mkdir -p /opt/proxy_lite/configs
cd /opt/proxy_lite

C2_USER=${shq(agentUser)}
C2_PASS=${shq(agentToken)}
echo "[1/3] 从调度中心拉取智能隔离引擎..."
for _name in lite_manager proxy_server; do
  if ! curl -sSL --user "\${C2_USER}:\${C2_PASS}" -o "\${_name}.py.new" ${domain}/scripts/\${_name}.py; then
    echo "[-] \${_name}.py 下载失败（网络或鉴权），已保留旧文件，终止部署。"
    rm -f "\${_name}.py.new"
    exit 1
  fi
  if ! head -c 32 "\${_name}.py.new" | grep -q "python3"; then
    echo "[-] \${_name}.py 内容异常（可能是鉴权失败返回的错误页面），已保留旧文件，终止部署。"
    rm -f "\${_name}.py.new"
    exit 1
  fi
  if ! grep -q "_first_config_applied" "\${_name}.py.new" && [ "\${_name}" = "lite_manager" ]; then
    echo "[-] lite_manager.py 版本过旧（缺少防重启循环修复），已保留旧文件，终止部署。"
    rm -f "\${_name}.py.new"
    exit 1
  fi
  mv -f "\${_name}.py.new" "\${_name}.py"
  echo "[*] \${_name}.py 更新成功。"
done

# ---------- 配置系统守护 ----------
echo "[2/3] 配置系统群组守护..."
if [ "$OS" = "alpine" ]; then
  rm -f /lib/systemd/system/proxy-lite.service
  cat > /etc/init.d/proxy-lite << 'EOF'
#!/sbin/openrc-run
supervisor=supervise-daemon
name="proxy-lite"
description="Residential Proxy Core Engine"
command="/usr/bin/python3"
command_args="-u /opt/proxy_lite/lite_manager.py"
directory="/opt/proxy_lite"
pidfile="/run/proxy-lite.pid"
respawn_delay=5
respawn_max=0
depend() {
  need net
}
EOF
  chmod +x /etc/init.d/proxy-lite
  rc-update add proxy-lite default >/dev/null
  rc-service proxy-lite restart
else
  rm -f /etc/init.d/proxy-lite
  cat > /lib/systemd/system/proxy-lite.service << 'EOF'
[Unit]
Description=Residential Proxy Core Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/proxy_lite
ExecStart=/usr/bin/python3 -u lite_manager.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable proxy-lite.service
  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/proxy-lite.conf << 'EOF'
[Journal]
SystemMaxUse=50M
SystemMaxFileSize=10M
RuntimeMaxUse=20M
MaxRetentionSec=7day
EOF
  systemctl restart systemd-journald
  journalctl --vacuum-size=50M --vacuum-time=7d >/dev/null 2>&1 || true
  systemctl restart proxy-lite.service
fi

echo "[+] 部署成功！多服务器独立策略版已生效（$OS)。"
`;
}

export function uninstallScript() {
  return `#!/usr/bin/env bash
set -e
echo "=========================================================="
echo "    免费住宅IP智能调度系统 卸载程序"
echo "=========================================================="

# ---------- 系统自动辨别 ----------
OS="unknown"
if [ -f /etc/alpine-release ]; then
  OS="alpine"
elif [ -f /etc/debian_version ]; then
  OS="debian"
elif [ -f /etc/os-release ]; then
  . /etc/os-release
  case "$ID" in
    alpine) OS="alpine" ;;
    debian|ubuntu|raspbian|linuxmint|pop) OS="debian" ;;
    *) case "$ID_LIKE" in *debian*|*ubuntu*) OS="debian" ;; esac ;;
  esac
fi
echo "[*] 识别到系统类型: $OS"

# ---------- 停止并移除服务 ----------
echo "[1/5] 停止代理服务..."
if [ "$OS" = "alpine" ]; then
  rc-service proxy-lite stop 2>/dev/null || true
  rc-update del proxy-lite default 2>/dev/null || true
else
  systemctl stop proxy-lite.service 2>/dev/null || true
  systemctl disable proxy-lite.service 2>/dev/null || true
fi
# 兼容另一系统的残留文件
rm -f /etc/init.d/proxy-lite /lib/systemd/system/proxy-lite.service
rm -f /etc/systemd/journald.conf.d/proxy-lite.conf
if [ "$OS" = "debian" ]; then
  systemctl daemon-reload 2>/dev/null || true
fi

# ---------- 杀残留进程 ----------
echo "[2/5] 清理残留进程..."
pkill -f "openvpn.*tun[0-9]" 2>/dev/null || true
pkill -f "lite_manager.py" 2>/dev/null || true
sleep 2
pkill -9 -f "openvpn.*tun[0-9]" 2>/dev/null || true
pkill -9 -f "lite_manager.py" 2>/dev/null || true

# ---------- 清理策略路由与 tun 接口 ----------
echo "[3/5] 清理策略路由..."
for slot in 0 1 2 3; do
  table=$((100 + slot))
  ip rule del table $table 2>/dev/null || true
  ip route flush table $table 2>/dev/null || true
  ip link del tun$slot 2>/dev/null || true
done

# ---------- 清理定时任务残留 ----------
echo "[4/5] 清理定时任务残留..."
if crontab -l 2>/dev/null | grep -q "/opt/proxy_lite/"; then
  crontab -l 2>/dev/null | grep -v "/opt/proxy_lite/" | crontab - 2>/dev/null || true
  echo "[*] 已移除相关 crontab 条目"
fi

# ---------- 删除程序文件 ----------
echo "[5/5] 删除程序文件..."
rm -rf /opt/proxy_lite

echo ""
echo "[+] 卸载完成。"
echo "    - 面板上的该机器条目将在 2 分钟心跳超时后自动消失"
echo "    - 依赖包 (openvpn/python3/curl/iproute2/iptables) 已保留，如需删除请手动执行"
echo "=========================================================="
`;
}
