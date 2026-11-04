// 管理面板 HTML，自旧版 _worker.js 拆分。改动仅：不再明文显示管理员密码、
// 接入命令改用 agent 凭证、注入 CSRF meta + fetch 包装、增加退出登录入口。
export function dashboardHtml({ domain, adminUser, agentUser, agentToken, proxyUser, proxyPass, proxyPort, csrfToken, shq }) {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="csrf-token" content="${csrfToken}">
    <title>免费住宅IP智能调度系统 (多服务器独立策略版)</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 font-sans min-h-screen">
    <div class="pointer-events-none fixed inset-0 overflow-hidden">
        <div class="absolute -top-32 -left-32 w-[30rem] h-[30rem] bg-cyan-500/10 rounded-full blur-3xl"></div>
        <div class="absolute top-24 -right-24 w-[28rem] h-[28rem] bg-blue-600/10 rounded-full blur-3xl"></div>
    </div>

    <div class="relative max-w-[1600px] mx-auto w-full px-4 md:px-6 pt-5 pb-10">

        <header class="mb-4">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_16px_rgba(52,211,153,.85)] animate-pulse shrink-0"></div>
                    <h1 class="text-xl md:text-2xl font-black tracking-tight bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-400 bg-clip-text text-transparent whitespace-nowrap">住宅代理调度中心</h1>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-400/25 text-cyan-300 font-mono whitespace-nowrap">UI v11</span>
                    <span class="hidden xl:inline text-[11px] text-slate-500">多服务器独立策略 · 单端口智能编排 · Alpine/Debian 自适应</span>
                </div>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
                    <span>管理员 <b class="text-cyan-300 font-mono">${adminUser}</b> <span class="text-slate-500\">(PBKDF2-SHA256)</span></span> <a href="/logout" class="text-red-300 hover:text-red-200 whitespace-nowrap">退出登录</a>
                    <span>代理 <b class="text-amber-300 font-mono">${proxyUser}</b> / <b class="text-amber-300 font-mono">${proxyPass}</b></span>
                    <a href="/api/proxies" target="_blank" class="text-cyan-300 hover:text-cyan-200 whitespace-nowrap">${domain}/api/proxies ↗</a>
                </div>
            </div>
            <details class="glass-card rounded-xl border border-white/10 mt-3">
                <summary class="cursor-pointer list-none px-4 py-2 flex items-center gap-3 text-[11px] tracking-widest uppercase text-slate-500 hover:text-slate-300 transition">
                    <span>接入 / 卸载命令</span><span class="text-cyan-300/80 tracking-normal">展开 ▾</span>
                </summary>
                <div class="px-4 pb-4 pt-1">
                    <p class="text-[11px] tracking-widest uppercase text-slate-500 mb-1.5">Provision New VPS（Debian/Ubuntu/Alpine 通用）</p>
                    <code class="text-emerald-300 text-xs select-all break-all">bash &lt;(curl -sSL --user ${shq(agentUser + ':' + agentToken)} ${domain}/agent)</code>
                    <p class="text-[11px] tracking-widest uppercase text-slate-500 mt-3 mb-1.5">Uninstall Agent（卸载 VPS 端，同样自适应系统）</p>
                    <code class="text-red-300/90 text-xs select-all break-all">bash &lt;(curl -sSL --user ${shq(agentUser + ':' + agentToken)} ${domain}/uninstall)</code>
                </div>
            </details>
        </header>

        <div id="machine-bar" class="sticky top-0 z-30 -mx-4 md:-mx-6 px-4 md:px-6 py-3 mb-5 bg-slate-950/85 backdrop-blur-md border-y border-white/10">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="text-[11px] tracking-widest uppercase text-slate-500 mr-1">VPS 母机</span>
                <div id="machine-buttons" class="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                    <span class="text-slate-500 text-xs">加载中...</span>
                </div>
                <button onclick="saveConfig()" class="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg shadow-cyan-900/30 transition shrink-0">保存并下发</button>
            </div>
        </div>

        <div class="flex flex-col gap-5">
            <main class="order-last flex flex-col gap-5 min-w-0">

                <section class="glass-card rounded-2xl border border-white/10 p-4">
                    <div class="flex items-center justify-between mb-3">
                        <div class="flex items-center gap-2">
                            <span class="w-1 h-5 rounded-full bg-gradient-to-b from-cyan-400 to-blue-500"></span>
                            <h2 class="text-base font-bold text-slate-100">可用国家</h2>
                            <span class="text-[11px] text-slate-500 hidden sm:inline">点击即填入默认策略的国家输入框</span>
                        </div>
                        <span class="px-2 py-0.5 rounded-full text-[10px] bg-cyan-400/10 text-cyan-300 border border-cyan-400/20">LIVE</span>
                    </div>
                    <div id="countries-list" class="flex flex-wrap gap-1.5 max-h-[104px] overflow-y-auto custom-scrollbar content-start">
                        <span class="text-slate-500 text-sm">正在拉取节点数据库...</span>
                    </div>
                </section>

                <section class="glass-card rounded-2xl border border-white/10 p-5">
                    <div class="mb-4">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="w-1 h-5 rounded-full bg-gradient-to-b from-violet-400 to-cyan-500"></span>
                            <h2 class="text-base font-bold text-slate-100">连接策略控制（多服务器独立）</h2>
                            <span id="policy-filter-label" class="text-[11px] px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/25 text-cyan-300">全部实例（含默认策略）</span>
                        </div>
                        <p class="text-xs text-slate-500 mt-2">每台 VPS 按公网 IP 独立设置国家与端口；未单独配置的服务器自动走默认策略。卡片显示 <span class="text-cyan-300">下发配置</span> 与 <span class="text-emerald-300">agent 实际生效</span> 对比。</p>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 bg-slate-900/60 border border-white/10 rounded-xl p-3.5">
                        <label class="flex flex-col gap-1">
                            <span class="text-[11px] text-slate-500">Agent 拉配置间隔（秒）</span>
                            <input type="number" id="gi-config" value="15" min="5" max="3600" class="bg-slate-800 border border-white/10 rounded-lg p-2 text-center font-bold w-full focus:outline-none focus:border-cyan-400" />
                        </label>
                        <label class="flex flex-col gap-1">
                            <span class="text-[11px] text-slate-500">Agent 心跳间隔（秒）</span>
                            <input type="number" id="gi-heartbeat" value="30" min="10" max="3600" class="bg-slate-800 border border-white/10 rounded-lg p-2 text-center font-bold w-full focus:outline-none focus:border-cyan-400" />
                        </label>
                        <label class="flex flex-col gap-1">
                            <span class="text-[11px] text-slate-500">面板轮询间隔（秒）</span>
                            <input type="number" id="gi-frontend" value="5" min="5" max="300" class="bg-slate-800 border border-white/10 rounded-lg p-2 text-center font-bold w-full focus:outline-none focus:border-cyan-400" />
                        </label>
                    </div>
                    <div class="flex flex-col gap-4" id="config-form">
                        <span class="text-gray-500 text-sm">加载中...</span>
                    </div>
                </section>

                <section class="glass-card rounded-2xl border border-white/10 overflow-hidden">
                    <div class="px-4 pt-4 pb-3 flex items-center justify-between border-b border-white/10">
                        <div class="flex items-center gap-2">
                            <span class="w-1 h-5 rounded-full bg-gradient-to-b from-emerald-400 to-cyan-500"></span>
                            <h2 class="text-base font-bold text-slate-100">在线节点</h2>
                        </div>
                        <span id="nodes-filter-label" class="text-xs text-slate-500"></span>
                    </div>
                    <div class="overflow-x-auto custom-scrollbar">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-white/[0.04] text-slate-400 border-b border-white/10">
                                    <th class="py-3 px-4 font-semibold text-sm w-1/6">VPS 母机 IP</th>
                                    <th class="py-3 px-4 font-semibold text-sm">已就绪的特优代理 (国家 | 节点IP:端口)</th>
                                    <th class="py-3 px-4 font-semibold text-sm w-1/12 whitespace-nowrap">心跳状态</th>
                                    <th class="py-3 px-4 font-semibold text-sm text-right w-1/12">在线率</th>
                                </tr>
                            </thead>
                            <tbody id="nodes-table" class="divide-y divide-gray-700">
                                <tr><td colspan="4" class="py-8 text-center text-gray-500">正在与调度中心数据库通信...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </section>
            </main>

            <aside class="order-first">
                <div>
                    <div class="bg-[#050a12] border border-white/10 rounded-2xl shadow-2xl flex flex-col h-[30vh] min-h-[200px] max-h-[340px] overflow-hidden">
                        <div class="bg-white/[0.04] border-b border-white/10 px-4 py-3 flex items-center justify-between gap-2">
                            <div class="flex items-center gap-2 min-w-0">
                                <div class="w-2.5 h-2.5 rounded-full bg-red-500/90"></div>
                                <div class="w-2.5 h-2.5 rounded-full bg-yellow-500/90"></div>
                                <div class="w-2.5 h-2.5 rounded-full bg-green-500/90"></div>
                                <span class="text-xs text-slate-400 ml-1.5 font-mono whitespace-nowrap">agent 实时日志</span>
                                <span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-400/25 text-cyan-300 font-mono whitespace-nowrap">UI v11</span>
                            </div>
                            <div class="flex items-center gap-2 min-w-0">
                                <span id="log-filter-label" class="text-[10px] text-slate-500 truncate max-w-[9rem]"></span>
                                <span class="text-[10px] text-green-400 font-mono animate-pulse whitespace-nowrap">● 直播</span>
                            </div>
                        </div>
                        <div id="remote-log" class="flex-grow overflow-y-auto p-4 text-xs font-mono leading-relaxed text-emerald-300/90 custom-scrollbar"></div>
                    </div>
                </div>
            </aside>
        </div>
    </div>

    <style>
        body { background-image: radial-gradient(circle at 20% 0%, rgba(14, 165, 233, .08), transparent 32rem), linear-gradient(135deg, #020617 0%, #0b1120 55%, #111827 100%); }
        .glass-card { background: linear-gradient(145deg, rgba(15, 23, 42, .88), rgba(15, 23, 42, .62)); box-shadow: 0 18px 60px rgba(0, 0, 0, .22), inset 0 1px rgba(255,255,255,.04); backdrop-filter: blur(16px); }
        th { letter-spacing: .08em; text-transform: uppercase; font-size: 10px !important; }
        td { border-color: rgba(255,255,255,.06) !important; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(15,23,42,.6); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #155e75; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #22d3ee; }
        .srv-card { transition: box-shadow .25s, border-color .25s; }
        .srv-card.flash { border-color: rgba(34,211,238,.7) !important; box-shadow: 0 0 0 2px rgba(34,211,238,.35), 0 18px 60px rgba(0,0,0,.25); }
        .mbtn { transition: all .15s; }
        .mbtn.active { background: rgba(34,211,238,.15) !important; border-color: rgba(34,211,238,.6) !important; color: #a5f3fc !important; }
        @keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        .dot-live { animation: pulse-dot 1.6s infinite; }
        html { scroll-behavior: smooth; }
        input:focus, select:focus { box-shadow: 0 0 0 3px rgba(34,211,238,.14); }
        .srv-card:hover { border-color: rgba(148,163,184,.35); }
        #remote-log { word-break: break-word; }
        @media (max-width: 640px) { table { min-width: 680px; } .glass-card { border-radius: 16px; } }
    </style>

    <script>
window.__csrf = document.querySelector('meta[name="csrf-token"]').content;
const __origFetch = window.fetch.bind(window);
window.fetch = function(input, init) { init = init || {}; const m = String(init.method || 'GET').toUpperCase(); if (m !== 'GET' && m !== 'HEAD') { init = Object.assign({}, init, { headers: Object.assign({}, init.headers || {}, { 'X-CSRF-Token': window.__csrf }) }); } return __origFetch(input, init); };
    </script>
    <script>
        const clientNotices = [];
        const policyState = { servers: {}, defaults: null, intervals: { config: 15, heartbeat: 30, frontend: 5 }, known: new Map() };
        const manualIps = new Set();
        let selectedMachine = 'all';
        let lastNodes = [];

        function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        function sidOf(ip) { return ip === '__default__' ? 'default' : String(ip).replace(/[^a-zA-Z0-9]/g, '_'); }
        function ago(ts) { const s = Math.max(0, Math.floor((Date.now() - ts) / 1000)); return s < 60 ? s + 's 前' : Math.floor(s / 60) + 'm 前'; }
        function isOnline(ts) { return Date.now() - ts < 45000; }

        function pushLog(msg, type="INFO") {
            clientNotices.push({ t: Date.now(), msg: String(msg), type: type });
            if (clientNotices.length > 40) clientNotices.shift();
            renderLogs();
        }

        async function fetchCountries() {
            try {
                const res = await fetch('/api/countries');
                const list = await res.json();
                const container = document.getElementById('countries-list');
                list.sort();
                container.innerHTML = list.map(c => \`<span class="bg-gray-700 px-2 py-1 rounded text-xs font-bold text-gray-300 border border-gray-600 cursor-pointer hover:bg-gray-600 transition" onclick="var el=document.getElementById('country-default'); if(el) el.value='\${c}'">\${c}</span>\`).join('');
            } catch(e) {}
        }

        // ================= 机器选择栏 =================
        function machineStatus(ip) {
            const meta = policyState.known.get(ip);
            if (!meta) return { cls: 'bg-slate-500', label: '未上报' };
            if (isOnline(meta.last_seen)) return { cls: 'bg-emerald-400 dot-live', label: '在线' };
            return { cls: 'bg-yellow-400', label: '心跳超时' };
        }

        function renderMachineBar() {
            const box = document.getElementById('machine-buttons');
            const ips = [...new Set([...policyState.known.keys(), ...manualIps])].sort();
            let html = \`<button data-m="all" onclick="selectMachine('all')" class="mbtn \${selectedMachine === 'all' ? 'active' : ''} px-3 py-2 rounded-xl text-xs font-bold bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10">全部</button>\`;
            for (const ip of ips) {
                const st = machineStatus(ip);
                const meta = policyState.known.get(ip);
                let ap = {};
                if (meta) { try { ap = JSON.parse(meta.applied || '{}'); } catch(e) {} }
                const sub = ap.port ? \`\${esc(ap.country || '--')}:\${esc(ap.port)}\` : '—';
                const tip = meta ? \`\${st.label} · \${ago(meta.last_seen)}\` : '未上报 · 等待 agent 心跳';
                html += \`<button data-m="\${esc(ip)}" onclick="selectMachine('\${esc(ip)}')" title="\${tip}"
                    class="mbtn \${selectedMachine === ip ? 'active' : ''} px-3 py-2 rounded-xl text-xs font-mono bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full \${st.cls}"></span>\${esc(ip)}<span class="text-slate-500">\${sub}</span>
                </button>\`;
            }
            if (!ips.length) html += '<span class="text-slate-500 text-xs">暂无上报机器，请在 VPS 运行顶部命令接入</span>';
            box.innerHTML = html;
        }

        function selectMachine(ip) {
            // 切换实例前先把当前卡片里未保存的输入同步回 state，避免被过滤重渲染冲掉
            try { syncPolicyStateFromDOM(); } catch (e) {}
            selectedMachine = ip;
            renderMachineBar();
            try { renderPolicyCards(); } catch (e) {}
            renderTable();
            renderLogs();
            if (ip !== 'all') {
                const card = document.querySelector('[data-server-card="' + ip + '"]');
                if (card) {
                    card.scrollIntoView({ block: 'nearest' });
                    card.classList.add('flash');
                    setTimeout(() => card.classList.remove('flash'), 1600);
                }
            }
            const label = ip === 'all' ? '' : '当前：' + ip;
            document.getElementById('nodes-filter-label').textContent = label;
            document.getElementById('log-filter-label').textContent = label;
            const pl = document.getElementById('policy-filter-label');
            if (pl) pl.textContent = ip === 'all' ? '全部实例（含默认策略）' : '仅显示 ' + ip;
        }

        // ================= 策略卡片 =================
        function effectiveConfig(ip) {
            if (ip === '__default__') return policyState.defaults;
            return policyState.servers[ip] || policyState.defaults;
        }

        function appliedOf(ip) {
            const meta = policyState.known.get(ip);
            if (!meta || !meta.applied) return null;
            try { return JSON.parse(meta.applied); } catch(e) { return null; }
        }

        function statusHTML(ip, isDefault) {
            if (isDefault) return '<span class="text-[11px] text-violet-300/80">未单独配置的服务器自动使用此策略</span>';
            const meta = policyState.known.get(ip);
            const eff = effectiveConfig(ip) || {};
            const ap = appliedOf(ip);
            const ver = meta && meta.version ? meta.version : '';
            let verBadge;
            if (!meta) verBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] bg-slate-500/15 text-slate-400 border border-white/10">未上报</span>';
            else verBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] bg-emerald-400/10 text-emerald-300 border border-emerald-400/30">agent v' + esc(ver || '?') + '</span>';
            const hb = meta ? '<span class="text-[11px] text-slate-500">心跳 ' + ago(meta.last_seen) + '</span>' : '<span class="text-[11px] text-slate-500">手动添加，等待上报</span>';
            let cmp;
            if (!ap || !ap.port) {
                cmp = '<span class="text-[11px] text-slate-500">实际：等待 agent 上报…</span>';
            } else {
                const same = String(eff.country).toUpperCase() === String(ap.country).toUpperCase() && Number(eff.port) === Number(ap.port) && eff.mode === ap.mode;
                cmp = '<span class="text-[11px] text-slate-400">实际：<span class="font-mono text-slate-200">' + esc(ap.country) + ':' + esc(ap.port) + ' ' + esc(ap.mode) + '</span></span> ' +
                    (same ? '<span class="text-[11px] text-emerald-300">✓ 已生效</span>' : '<span class="text-[11px] text-amber-300">⚠️ 与下发不一致</span>');
            }
            let manualLine = '';
            if (eff.mode === 'manual') {
                const ms = (ap && ap.manual_status) ? ap.manual_status : '等待上报…';
                const mcls = ms.indexOf('connected') === 0 ? 'text-emerald-300' : (ms.indexOf('cooling') === 0 || ms.indexOf('waiting') === 0 ? 'text-amber-300' : 'text-slate-400');
                manualLine = '<div class="mt-1 text-[11px] ' + mcls + '">手动状态：' + esc(ms) + '</div>';
            }
            return '<div class="flex items-center gap-2 flex-wrap">' + verBadge + hb + '</div>' +
                '<div class="mt-1.5 text-[11px] text-slate-400">下发：<span class="font-mono text-cyan-300">' + esc(eff.country) + ':' + esc(eff.port) + ' ' + esc(eff.mode) + '</span></div>' +
                '<div class="mt-0.5">' + cmp + '</div>' + manualLine;
        }

        function policyCardHTML(ip, cfg, meta, isDefault) {
            const sid = sidOf(ip);
            const title = isDefault ? '默认策略' : ip;
            const st = isDefault ? null : machineStatus(ip);
            const dot = isDefault ? '<span class="w-2.5 h-2.5 rounded-full bg-violet-400"></span>'
                : '<span class="w-2.5 h-2.5 rounded-full ' + (st ? st.cls : 'bg-slate-500') + '"></span>';
            let body;
            if (!isDefault && !cfg) {
                body = \`<div class="flex items-center justify-between gap-3">
                    <span class="text-xs text-slate-500">当前跟随默认策略</span>
                    <button onclick="enableIndependent('\${esc(ip)}')" class="text-xs px-3 py-2 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-400/30 hover:bg-cyan-500/25 transition">设为独立配置</button>
                </div>\`;
            } else {
                const c = cfg;
                const cands = (meta && meta.candidates) || [];
                const candOpts = cands.map(n => \`<option value="\${esc(n.ip)}">\${esc(n.country || '--')} | \${esc(n.ip)} | \${n.ping == null ? '?' : n.ping} ms</option>\`).join('');
                const selManual = c.manual_node_ip ? \` data-sel="\${esc(c.manual_node_ip)}"\` : '';
                body = \`
                <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                    <label class="flex flex-col gap-1">
                        <span class="text-[11px] text-slate-500">国家/地区</span>
                        <input id="country-\${sid}" value="\${esc(c.country || 'JP')}" maxlength="2" class="bg-slate-800 border border-white/10 rounded-lg p-2 text-center font-bold uppercase focus:outline-none focus:border-cyan-400" />
                    </label>
                    <label class="flex flex-col gap-1">
                        <span class="text-[11px] text-slate-500">代理端口</span>
                        <input id="port-\${sid}" type="number" value="\${esc(c.port || 10001)}" min="1" max="65535" class="bg-slate-800 border border-white/10 rounded-lg p-2 text-center font-bold focus:outline-none focus:border-cyan-400" />
                    </label>
                    <label class="flex flex-col gap-1">
                        <span class="text-[11px] text-slate-500">连接模式</span>
                        <select id="mode-\${sid}" onchange="toggleManualModes()" class="bg-slate-800 border border-white/10 rounded-lg p-2 font-bold focus:outline-none focus:border-cyan-400">
                            <option value="auto" \${c.mode === 'manual' ? '' : 'selected'}>自动连接</option>
                            <option value="manual" \${c.mode === 'manual' ? 'selected' : ''}>手动选择</option>
                        </select>
                    </label>
                    <label class="flex flex-col gap-1 col-span-2 md:col-span-3 xl:col-span-3">
                        <span class="text-[11px] text-slate-500">手动节点 <button type="button" onclick="refreshCandidates('\${esc(ip)}')" class="ml-1 text-cyan-300 hover:text-cyan-200 underline">刷新候选</button></span>
                        <select id="manual-\${sid}"\${selManual} class="bg-slate-800 border border-white/10 rounded-lg p-2 font-mono text-xs focus:outline-none focus:border-cyan-400">
                            <option value="">请选择可用节点</option>
                            \${candOpts}
                        </select>
                    </label>
                </div>
                <div class="flex flex-wrap items-center gap-3 mt-3">
                    <label class="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
                        <input type="checkbox" id="yt-\${sid}" \${c.youtube_check ? 'checked' : ''} class="w-4 h-4 accent-cyan-400" />
                        YouTube 可用检测
                    </label>
                    <div class="flex-1"></div>
                    \${isDefault ? '' : \`<button onclick="forceSwitchIP('\${esc(ip)}')" title="强制刷新该服务器当前节点 IP" class="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-300 border border-red-400/30 hover:bg-red-500/20 transition">⚡ 强制换 IP</button>\`}
                    \${isDefault ? '' : \`<button onclick="removeServerCard('\${esc(ip)}')" class="text-xs px-3 py-2 rounded-lg bg-white/5 text-slate-400 border border-white/10 hover:bg-white/10 transition">删除独立配置</button>\`}
                </div>\`;
            }
            return \`<div data-server-card="\${esc(ip)}" data-sid="\${sid}" class="srv-card bg-slate-900/60 border \${isDefault ? 'border-violet-400/30' : 'border-white/10'} rounded-2xl p-4">
                <div class="flex items-center gap-2 mb-2">\${dot}<div class="font-mono font-bold \${isDefault ? 'text-violet-300' : 'text-cyan-300'}">\${esc(title)}</div></div>
                <div class="card-status mb-3" data-status-for="\${esc(ip)}">\${statusHTML(ip, isDefault)}</div>
                \${body}
            </div>\`;
        }

        function renderPolicyCards() {
            const c = document.getElementById('config-form');
            const { servers, defaults, known } = policyState;
            const dft = defaults || { country: 'JP', port: 10001, mode: 'auto', manual_node_ip: '', youtube_check: false };
            // 跟随实例选择：'all' -> 默认卡 + 全部实例卡；选中单实例 -> 只渲染该实例卡
            const focus = selectedMachine;
            const only = focus !== 'all';
            let html = only ? '' : policyCardHTML('__default__', dft, null, true);
            const rendered = new Set();
            for (const ip of Object.keys(servers)) {
                if (only && ip !== focus) continue;
                html += policyCardHTML(ip, servers[ip], known.get(ip) || null, false);
                rendered.add(ip);
            }
            for (const ip of known.keys()) {
                if (only && ip !== focus) continue;
                if (!rendered.has(ip)) { html += policyCardHTML(ip, null, known.get(ip), false); rendered.add(ip); }
            }
            for (const ip of manualIps) {
                if (only && ip !== focus) continue;
                if (!rendered.has(ip) && !known.has(ip)) {
                    html += policyCardHTML(ip, Object.assign({}, dft), null, false);
                    rendered.add(ip);
                }
            }
            if (only && !rendered.has(focus)) {
                html += policyCardHTML(focus, Object.assign({}, dft), known.get(focus) || null, false);
            }
            if (!only) html += \`<div class="flex gap-2 items-center bg-slate-900/60 border border-dashed border-white/15 rounded-2xl p-4">
                <input id="add-server-ip" placeholder="输入 VPS 公网 IP，提前为其配置独立策略" class="bg-slate-800 border border-white/10 rounded-lg p-2 font-mono text-sm flex-1 focus:outline-none focus:border-cyan-400" />
                <button onclick="addServerCard()" class="text-xs px-4 py-2 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-400/30 hover:bg-cyan-500/25 transition whitespace-nowrap">+ 添加服务器</button>
            </div>\`;
            c.innerHTML = html;
            document.querySelectorAll('select[id^="manual-"][data-sel]').forEach(sel => {
                const v = sel.getAttribute('data-sel');
                if (v && Array.from(sel.options).some(o => o.value === v)) sel.value = v;
                sel.removeAttribute('data-sel');
            });
            toggleManualModes();
        }

        // 重渲染前先把用户已填的值同步回 state，避免未保存的修改丢失
        function syncPolicyStateFromDOM() {
            document.querySelectorAll('[data-server-card]').forEach(card => {
                const ip = card.getAttribute('data-server-card');
                const sid = card.getAttribute('data-sid');
                const countryEl = document.getElementById('country-' + sid);
                if (!countryEl) return;
                const entry = {
                    country: (countryEl.value || 'JP').toUpperCase().trim(),
                    port: Number.parseInt(document.getElementById('port-' + sid).value, 10) || 10001,
                    mode: document.getElementById('mode-' + sid).value,
                    manual_node_ip: document.getElementById('manual-' + sid).value,
                    youtube_check: document.getElementById('yt-' + sid).checked
                };
                if (ip === '__default__') policyState.defaults = entry;
                else policyState.servers[ip] = entry;
            });
            const num = (id, dft) => { const v = Number.parseInt(document.getElementById(id).value, 10); return Number.isInteger(v) ? v : dft; };
            policyState.intervals = { config: num('gi-config', 15), heartbeat: num('gi-heartbeat', 30), frontend: num('gi-frontend', 5) };
        }

        function updateCardStatus() {
            document.querySelectorAll('.card-status').forEach(el => {
                const ip = el.getAttribute('data-status-for');
                const card = el.closest('[data-server-card]');
                const isDefault = card && card.getAttribute('data-server-card') === '__default__';
                el.innerHTML = statusHTML(ip, isDefault);
            });
        }

        function enableIndependent(ip) {
            syncPolicyStateFromDOM();
            const dft = policyState.defaults || { country: 'JP', port: 10001, mode: 'auto', manual_node_ip: '', youtube_check: false };
            policyState.servers[ip] = Object.assign({}, dft);
            renderMachineBar();
            renderPolicyCards();
        }

        function removeServerCard(ip) {
            syncPolicyStateFromDOM();
            delete policyState.servers[ip];
            manualIps.delete(ip);
            // 立即把该卡片从 DOM 摘掉：否则后续 syncPolicyStateFromDOM 会把它重新写回 state，删除失效
            const stale = document.querySelector('[data-server-card="' + ip + '"]');
            if (stale) stale.remove();
            if (selectedMachine === ip && !policyState.known.has(ip)) { selectMachine('all'); return; }
            renderMachineBar();
            renderPolicyCards();
        }

        function addServerCard() {
            const el = document.getElementById('add-server-ip');
            const ip = (el.value || '').trim();
            if (!ip) { alert('请输入 VPS 公网 IP'); return; }
            syncPolicyStateFromDOM();
            manualIps.add(ip);
            enableIndependent(ip);
        }

        async function refreshCandidates(ip) {
            try {
                const res = await fetch('/api/nodes');
                const servers = await res.json();
                const s = (servers || []).find(x => x.ip === ip);
                if (!s) { alert('该机器暂无上报数据'); return; }
                let cands = [];
                try { cands = JSON.parse(s.candidates || '[]'); } catch(e) {}
                const meta = policyState.known.get(ip) || { ip: ip, last_seen: 0, candidates: [] };
                meta.candidates = cands;
                policyState.known.set(ip, meta);
                const sid = sidOf(ip);
                const sel = document.getElementById('manual-' + sid);
                if (sel) {
                    const cur = sel.value;
                    sel.innerHTML = '<option value="">请选择可用节点</option>' + cands.map(n =>
                        \`<option value="\${esc(n.ip)}">\${esc(n.country || '--')} | \${esc(n.ip)} | \${n.ping == null ? '?' : n.ping} ms</option>\`).join('');
                    if (cur && Array.from(sel.options).some(o => o.value === cur)) sel.value = cur;
                }
                pushLog('已刷新 ' + ip + ' 的候选节点（' + cands.length + ' 个）', 'SYS');
            } catch(e) { alert('刷新失败'); }
        }

        function toggleManualModes() {
            document.querySelectorAll('[data-server-card]').forEach(card => {
                const sid = card.getAttribute('data-sid');
                const mode = document.getElementById('mode-' + sid);
                const node = document.getElementById('manual-' + sid);
                if (!mode || !node) return;
                node.disabled = mode.value !== 'manual';
                node.classList.toggle('opacity-50', node.disabled);
            });
        }

async function initPolicyConsole() {
try {
const [cfgRes, nodesRes] = await Promise.all([fetch('/api/config'), fetch('/api/nodes')]);
const cfg = await cfgRes.json();
let nodes = [];
try { nodes = await nodesRes.json();} catch (e) {}
policyState.servers = (cfg.servers && typeof cfg.servers === 'object')? cfg.servers: {};
policyState.defaults = cfg.defaults || null;
policyState.intervals = {
config: cfg.config_fetch_interval || 15,
heartbeat: cfg.heartbeat_interval || 30,
frontend: cfg.frontend_poll_interval || 5
};
ingestNodes(nodes);
document.getElementById('gi-config').value = policyState.intervals.config;
document.getElementById('gi-heartbeat').value = policyState.intervals.heartbeat;
document.getElementById('gi-frontend').value = policyState.intervals.frontend;
renderPolicyCards();
renderMachineBar();
} catch (e) {
document.getElementById('config-form').innerHTML = '<span class="text-red-400 text-sm">策略加载失败，请检查 Worker 与 D1 是否正常</span>';
}
}

function ingestNodes(nodes) {
policyState.known = new Map();
for (const s of (nodes || [])) {
let cands = [];
try { cands = s.candidates || []; if (typeof cands === 'string') cands = JSON.parse(cands);} catch(e) { cands = [];}
policyState.known.set(s.ip, {
ip: s.ip, last_seen: s.last_seen, candidates: cands,
version: s.version || '', applied: s.applied || '',
details: s.details || '[]', log: s.log || ''
});
}
lastNodes = nodes || [];
}

async function saveConfig() {
syncPolicyStateFromDOM();
const servers = policyState.servers;
const defaults = policyState.defaults;
try {
for (const [ip, e] of Object.entries(servers)) {
if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new Error('服务器 ' + ip + '：端口必须是 1-65535 的整数');
if (!/^[A-Z]{2}$/.test(e.country)) throw new Error('服务器 ' + ip + '：国家代码必须是 2 位字母');
if (e.mode === 'manual' &&!e.manual_node_ip) throw new Error('服务器 ' + ip + '：手动模式必须选择一个节点');
}
if (!Number.isInteger(defaults.port) || defaults.port < 1 || defaults.port > 65535) throw new Error('默认策略：端口必须是 1-65535 的整数');
if (!/^[A-Z]{2}$/.test(defaults.country)) throw new Error('默认策略：国家代码必须是 2 位字母');
if (defaults.mode === 'manual' &&!defaults.manual_node_ip) throw new Error('默认策略：手动模式必须选择一个节点');
} catch (err) {
alert(err.message || err);
return;
}
const res = await fetch('/api/config', {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({
servers: servers,
defaults: defaults,
config_fetch_interval: policyState.intervals.config,
heartbeat_interval: policyState.intervals.heartbeat,
frontend_poll_interval: policyState.intervals.frontend
})
});
if (!res.ok) {
const t = await res.text().catch(() => '');
alert('配置保存失败：' + t);
return;
}
pushLog('[控制中心广播] 多服务器独立策略已下发，agent 将在 ' + policyState.intervals.config + 's 内生效。', 'SYS');
alert('配置已下发，agent 拉取后生效（端口变更会自动重启 agent）。可在卡片上对比“下发 vs 实际”确认。');
restartNodePolling(policyState.intervals.frontend);
}

async function forceSwitchIP(ip) {
if (!confirm('确认要强行断开并刷新当前的节点 IP 吗？\\n(该IP仅会进入 1 分钟临时冷却，不会被从池中删除。)')) return;
try {
const res = await fetch('/api/switch', {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ server_ip: ip, slot: 0})
});
if (res.ok) {
pushLog('[指令下达] 已向 ' + ip + ' 发送手动熔断强杀指令', 'WARN');
alert('⚡ 指令下达成功！\\nVPS 监控引擎已收到杀机指令。');
} else {
alert('网络指令下发失败，请重试');
}
} catch (e) {
alert('网络指令下发异常');
}
}

let nodePollingTimer;
function restartNodePolling(seconds) {
if (nodePollingTimer) clearInterval(nodePollingTimer);
nodePollingTimer = setInterval(fetchNodes, seconds * 1000);
}

async function fetchNodes() {
try {
const res = await fetch('/api/nodes');
const servers = await res.json();
ingestNodes(servers);
renderMachineBar();
renderTable();
renderLogs();
updateCardStatus();

} catch (err) {}
}

function visibleServers() {
if (selectedMachine === 'all') return lastNodes;
return lastNodes.filter(s => s.ip === selectedMachine);
}

function renderTable() {
const tbody = document.getElementById('nodes-table');
const servers = visibleServers();
if (!servers || servers.length === 0) {
tbody.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-gray-500">' +
(selectedMachine === 'all'? '当前没有被纳管的机器，请在 VPS 运行顶部命令接入': '该机器暂无上报数据') + '</td></tr>';
return;
}
tbody.innerHTML = servers.map(server => {
const details = JSON.parse(server.details || '[]');
const timeAgo = ago(server.last_seen);
details.sort((a,b) => a.port - b.port);
let proxyBadges = details.map(d =>
\`<div class="inline-flex items-center bg-slate-800/80 border border-white/10 rounded px-2 py-1 mr-2 mb-2 text-xs">
<span class="text-cyan-300 font-bold mr-2">\${d.country}</span>
<span class="font-mono text-slate-200 mr-2" title="节点物理IP">\${d.node_ip || '分配中...'}:\${d.port}</span>
</div>\`
).join('');
if (details.length === 0) proxyBadges = '<span class="text-yellow-500 text-xs">高容错极速调度中... 正在建立单端口稳定网络...</span>';
return \`
<tr class="hover:bg-white/5 transition-colors">
<td class="py-4 px-4 font-mono text-base text-cyan-200 align-top">\${server.ip}</td>
<td class="py-4 px-4 align-top">\${proxyBadges}</td>
<td class="py-4 px-4 text-slate-400 align-top">\${timeAgo}</td>
<td class="py-4 px-4 align-top text-right">
<span class="\${details.length === 1? 'bg-green-900 text-green-300': 'bg-yellow-900 text-yellow-300'} py-1 px-3 rounded-full text-xs font-bold">\${details.length} / 1</span>
</td>
</tr>
\`;
}).join('');
}

function renderLogs() {
const remoteLog = document.getElementById('remote-log');
if (!remoteLog) return;
const atBottom = remoteLog.scrollHeight - remoteLog.scrollTop - remoteLog.clientHeight < 48;
const servers = visibleServers();
const noticeColor = { WARN: 'text-amber-300', ERR: 'text-rose-300', SUCCESS: 'text-emerald-300', SYS: 'text-sky-300', INFO: 'text-slate-300' };
let html = '';
if (clientNotices.length) {
html += '<div class="mb-2 pb-2 border-b border-white/10">' + clientNotices.map(n => {
const d = new Date(n.t);
const ts = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0');
return '<div><span class="text-slate-600">[' + ts + ']</span> <span class="' + (noticeColor[n.type] || noticeColor.INFO) + '">\u25b8 ' + esc(n.msg) + '</span></div>';
}).join('') + '</div>';
}
const serverTxt = servers.map(server => {
const raw = String(server.log || '').split(String.fromCharCode(13)).join('').trim();
if (!raw) return '';
const rows = raw.split(String.fromCharCode(10)).map(line => {
const at = line.charAt(0) === '[' ? line.indexOf(']') : -1;
const head = at > 0 ? '<span class="text-slate-600 shrink-0">' + esc(line.slice(0, at + 1)) + '</span>' : '';
const body = at > 0 ? line.slice(at + 1).trimStart() : line;
return '<div class="flex gap-2 py-[1px]">' + head + '<span class="flex-1 min-w-0 whitespace-pre-wrap break-words text-emerald-300/90">' + esc(body) + '</span></div>';
}).join('');
return '<div class="mt-3 mb-1 text-cyan-400/80">===== ' + esc(server.ip) + ' =====</div>' + rows;
}).filter(Boolean).join('');
if (serverTxt) html += serverTxt;
else if (!clientNotices.length) html += '<div class="text-slate-600">' + (selectedMachine === 'all' ? '暂无日志输出，等待 agent 上报…' : '该机器暂无日志') + '</div>';
remoteLog.innerHTML = html;
if (atBottom) remoteLog.scrollTop = remoteLog.scrollHeight;
}

fetchCountries();
initPolicyConsole();
fetchNodes();
fetch('/api/config').then(res => res.json()).then(config => restartNodePolling(config.frontend_poll_interval || 5)).catch(() => restartNodePolling(5));
</script>
</body>
</html>
`;
}
