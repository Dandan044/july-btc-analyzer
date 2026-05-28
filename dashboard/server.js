#!/usr/bin/env node
/**
 * 七月 BTC 监控面板 - 后端服务
 *
 * 周期为顶层,仓位和警报钻取到周期下。
 * 实盘仓位通过 OKX CLI (proxychains4) 实时查询,快照仓位读 positions.json。
 */

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 常量 ──────────────────────────────────────────────
const BASE_DIR = path.resolve(__dirname, '..');
const ACTIVE_DIR = path.join(BASE_DIR, 'active');
const ARCHIVED_DIR = path.join(BASE_DIR, 'archived');
const SCRIPTS_DIR = path.join(BASE_DIR, 'scripts');
const SKILLS_DIR = path.join(BASE_DIR, 'skills');
const RULES_DIR = path.join(SKILLS_DIR, 'btc-alert', 'rules');
const RULES_ARCHIVE_DIR = path.join(SKILLS_DIR, 'btc-alert', 'rules-archive');
const HEALTH_DIR = path.join(BASE_DIR, 'cycle-health');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const DATA_DIR = path.join(BASE_DIR, 'data');
const ALERTS_CACHE_FILE = path.join(DATA_DIR, 'recent-alerts-cache.json');

// ── OKX 持仓数缓存（由 /api/live-pnl 写入，/api/dashboard 读取） ──
const OKX_CACHE_FILE = path.join(DATA_DIR, 'okx-positions-cache.json');
let okxPositionCountCache = { count: 0, ts: 0 }; // 内存缓存
try {
  const cached = readJSON(OKX_CACHE_FILE);
  if (cached && Date.now() - cached.ts < 300000) okxPositionCountCache = cached;
} catch {}

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3100');

// 读取 Gateway Token(用于创建 cron 任务)
let GATEWAY_TOKEN = '';
try {
  const openclawConfig = JSON.parse(fs.readFileSync(
    path.join(process.env.HOME || '/home/administrator', '.openclaw', 'openclaw.json'), 'utf8'
  ));
  GATEWAY_TOKEN = openclawConfig?.gateway?.auth?.token || '';
} catch { /* ignore */ }

const app = express();

// ── 全局异常保护：防止未捕获异常导致进程崩溃 ──
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] uncaughtException: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 4).join('\n'));
  // 不退出进程，让 PM2 自行决定是否重启
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] unhandledRejection: ${reason}`);
});

app.use(express.json());

// ── 请求日志（调试用） ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api')) {
      console.log(`[req] ${res.statusCode} ${req.method} ${req.path} ${ms}ms`);
    }
  });
  next();
});

// ── 全局请求超时保护：30s 未响应自动 504 ──
app.use((req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`[timeout] ${req.method} ${req.path}`);
      res.status(504).json({ error: '请求超时，请刷新重试' });
    }
  }, 30000);
  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));
  next();
});

// ── GET / — 注入外观设置到 HTML（必须在 express.static 之前） ──
const SETTINGS_FILE = path.join(BASE_DIR, 'data', 'dashboard-settings.json');

function readSettings() {
  const defaults = { scannerLimit: 45, scannerIntervalMin: 60, glassEnabled: true, cardOpacity: 0.95 };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return { ...defaults, ...saved };
    }
  } catch {}
  return { ...defaults };
}

// ── 周期类型判定 ─────────────────────────────────
function classifyCycle(name) {
  if (name.startsWith('cycle-')) return { type: 'btc', coin: 'BTC', isBTC: true, isZhuang: false };
  if (name.startsWith('zhuang-')) {
    const coin = (name.match(/^zhuang-([A-Z0-9]+)-/) || [])[1] || 'UNKNOWN';
    return { type: 'zhuang', coin, isBTC: false, isZhuang: true };
  }
  const coin = (name.match(/^alt-([A-Z0-9]+)-/) || [])[1] || 'UNKNOWN';
  return { type: 'altcoin', coin, isBTC: false, isZhuang: false };
}

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    let html = fs.readFileSync(indexPath, 'utf8');
    const settings = readSettings();
    const glassOn = settings.glassEnabled !== false;
    const opacity = settings.cardOpacity || 0.95;
    const glassClass = glassOn ? 'glass-on' : 'glass-off';
    const bgImage = settings.backgroundImage || '/images/1.png';
    const injected = `<script>window.__APPEARANCE__={glassEnabled:${glassOn},cardOpacity:${opacity},backgroundImage:"${bgImage.replace(/"/g,'\\"')}"};document.documentElement.style.setProperty('--card-opacity','${opacity}');document.documentElement.style.setProperty('--card-blur','${glassOn?'12px':'0px'}');document.body.classList.add('${glassClass}');</script>`;
    html = html.replace('</head>', injected + '</head>');
    res.type('html').send(html);
  } catch {
    res.sendFile(indexPath);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false, lastModified: false, setHeaders: (res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));

// ── 工具函数 ──────────────────────────────────────────

// ── exec 故障熔断器 ──
const execBreaker = {}; // { cmdPrefix: { failures, until } }
const BREAKER_THRESHOLD = 3;     // 连续失败 3 次 → 熔断
const BREAKER_COOLDOWN = 60000;  // 熔断冷却 60s

/** 安全 execSync，出错返回空。内置熔断：同命令连续失败 3 次后 60s 内不再执行 */
function safeExec(cmd, opts = {}) {
  const prefix = cmd.split(' ').slice(0, 2).join(' '); // e.g. "openclaw cron"
  const breaker = execBreaker[prefix];
  if (breaker && Date.now() < breaker.until) {
    console.error(`[breaker] 熔断中: ${prefix} (${Math.round((breaker.until - Date.now()) / 1000)}s 后恢复)`);
    return null;
  }

  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: 10000, ...opts });
    // 成功 → 清零故障计数
    if (execBreaker[prefix]) delete execBreaker[prefix];
    return result;
  } catch (e) {
    console.error(`[exec error] ${prefix}: ${e.message.slice(0, 100)}`);
    // 记录故障
    if (!execBreaker[prefix]) execBreaker[prefix] = { failures: 0, until: 0 };
    execBreaker[prefix].failures++;
    if (execBreaker[prefix].failures >= BREAKER_THRESHOLD) {
      execBreaker[prefix].until = Date.now() + BREAKER_COOLDOWN;
      console.error(`[breaker] 已熔断: ${prefix} (${BREAKER_COOLDOWN / 1000}s 冷却)`);
    }
    return null;
  }
}

/** 通过 proxychains4 调 okx CLI,返回 JSON */
function okxCli(args) {
  const raw = safeExec(`proxychains4 -q okx --profile live --json ${args} 2>/dev/null`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 读 JSON 文件 */
function readJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch { return null; }
}

/** 列出目录下所有子目录 */
function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

/** 列出目录下所有文件 */
function listFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name); } catch { return []; }
}

/** 文件修改时间 (ISO) */
function mtimeISO(filepath) {
  try { return fs.statSync(filepath).mtime.toISOString(); } catch { return null; }
}

/** 计算静默时长(小时) */
function silenceHours(lastReportTime) {
  if (!lastReportTime) return Infinity;
  return (Date.now() - new Date(lastReportTime).getTime()) / 3600000;
}

// ── 规则查询(复用 query-rules.js,兼容旧格式) ──────

/** 从文件名/内容推断缺失的 C19 字段(兼容旧格式规则) */
function enrichRule(r) {
  // 补 coin:从文件名推断
  if (!r.coin && r.file) {
    const f = r.file.replace(/\.js$/, '');
    // 模式1: {date}-btc-{type} → BTC
    if (/-btc-/.test(f)) { r.coin = 'BTC'; }
    // 模式2: {COIN}-{type} → 山寨币
    else {
      const m = f.match(/^([A-Z0-9]+)-/);
      if (m) r.coin = m[1];
    }
  }
  // 补 status
  if (!r.status) {
    r.status = r.location === 'archived' ? 'archived' : 'active';
  }
  return r;
}

/** 从 rules-state.json 补充 lastCheckedAt(2026-05-19 热重载修复后状态已分离) */
function enrichRulesWithState(rules) {
  const stateFile = path.join(SKILLS_DIR, 'btc-alert', 'rules-state.json');
  const state = readJSON(stateFile);
  if (!state) return rules;
  for (const r of rules) {
    if (!r.file) continue;
    // query-rules.js returns file without .js, state file keys include .js
    const key = state[r.file] ? r.file : (state[r.file + '.js'] ? r.file + '.js' : null);
    if (key && state[key]?.lastCheckedAt) {
      r.lastCheckedAt = state[key].lastCheckedAt;
    }
  }
  return rules;
}

function getRules(filter = {}) {
  // 策略:先拉全部规则,再在内存中过滤(兼容旧格式无 coin/cycleId 字段的规则)
  const args = '--format json --all';
  const raw = safeExec(`node "${path.join(SCRIPTS_DIR, 'query-rules.js')}" ${args} 2>/dev/null`);
  if (!raw) return [];
  let rules;
  try { rules = JSON.parse(raw).map(enrichRule); } catch { return []; }

  // 从 rules-state.json 补充 lastCheckedAt(热重载修复后状态已分离)
  rules = enrichRulesWithState(rules);

  // 内存过滤
  if (filter.coin) {
    rules = rules.filter(r => r.coin?.toUpperCase() === filter.coin.toUpperCase());
  }
  if (filter.cycleId) {
    rules = rules.filter(r => r.cycleId === filter.cycleId);
  }
  return rules;
}

/** 按 cycleId 或 coin 索引规则(兼容缺失 cycleId 的旧规则) */
function rulesByCycle(rules, cycles) {
  const map = {};
  // 建立 coin → cycleId 查找表
  const coinToCycle = {};
  if (cycles) {
    for (const c of cycles) {
      if (!coinToCycle[c.coin]) coinToCycle[c.coin] = c.cycleId;
    }
  }
  for (const r of rules) {
    let cid = r.cycleId;
    // 如果没有 cycleId,尝试通过 coin 匹配到活跃周期
    if (!cid && r.coin && coinToCycle[r.coin]) {
      cid = coinToCycle[r.coin];
    }
    cid = cid || '_orphan';
    if (!map[cid]) map[cid] = [];
    map[cid].push(r);
  }
  return map;
}

// ── 周期扫描 ──────────────────────────────────────────

function scanCycles(location = 'active') {
  const dir = location === 'active' ? ACTIVE_DIR : ARCHIVED_DIR;
  const names = listDirs(dir);
  return names.map(name => {
    const cycleDir = path.join(dir, name);
    const posFile = path.join(cycleDir, 'positions.json');
    const reportsDir = path.join(cycleDir, 'reports');

    const positions = readJSON(posFile);
    const reports = listFiles(reportsDir).filter(f => f.endsWith('.md')).sort().reverse();
    const lastReport = reports[0] || null;
    const lastReportPath = lastReport ? path.join(reportsDir, lastReport) : null;
    const lastReportTime = lastReportPath ? mtimeISO(lastReportPath) : null;

    // 解析币种和类型
    const cls = classifyCycle(name);
    const coin = cls.coin;

    // 持仓摘要
    const posList = positions?.['当前持仓'] || [];
    const hasPositions = posList.length > 0;
    const unrealizedPnl = posList.reduce((sum, p) => sum + (parseFloat(p['未实现盈亏']) || 0), 0);
    const totalPnl = posList.reduce((sum, p) =>
      sum + (parseFloat(p['未实现盈亏']) || 0) + (parseFloat(p['已实现盈亏']) || 0), 0);

    // 快照汇总盈亏(归档周期用)
    const snapshotSummary = positions?.['汇总'] || null;
    const realizedPnl = snapshotSummary ? (parseFloat(snapshotSummary['已实现盈亏总计']) || 0) : null;
    const snapshotUnrealizedPnl = snapshotSummary ? (parseFloat(snapshotSummary['未实现盈亏总计']) || 0) : null;

    const sh = silenceHours(lastReportTime);

    return {
      cycleId: name,
      coin,
      type: cls.type,
      location,
      reportCount: reports.length,
      lastReport,
      lastReportTime,
      silenceHours: Number.isFinite(sh) ? sh : 999,
      hasPositions,
      positionCount: posList.length,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      realizedPnl: realizedPnl !== null ? Math.round(realizedPnl * 100) / 100 : null,
      snapshotUnrealizedPnl: snapshotUnrealizedPnl !== null ? Math.round(snapshotUnrealizedPnl * 100) / 100 : null,
    };
  });
}

// ── 周期状态判断 ──────────────────────────────────────

function cycleStatus(cycle, rulesCount) {
  // 二元:活(有持仓或有规则) / 死(都没了)
  if (cycle.hasPositions || rulesCount > 0) return 'alive';  // 🟢
  return 'dead';                                              // 🔴
}

// ══════════════════════════════════════════════════════
//  API 路由
// ══════════════════════════════════════════════════════

// ── GET/POST /api/settings ───────────────────────────
// SETTINGS_FILE 和 readSettings 已在文件顶部定义，此处复用

function writeSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const settings = readSettings();
    const { scannerLimit, scannerIntervalMin, zhuangScannerLimit, zhuangScannerIntervalMin, positionMultiplier, zhuangPositionMultiplier, hedgeEnabled, leverage, glassEnabled, cardOpacity } = req.body;
    if (scannerLimit !== undefined) {
      const v = parseInt(scannerLimit);
      if (isNaN(v) || v < 1) return res.status(400).json({ ok: false, error: 'invalid scannerLimit' });
      settings.scannerLimit = v;
    }
    if (scannerIntervalMin !== undefined) {
      const v = parseInt(scannerIntervalMin);
      if (isNaN(v) || v < 15 || v > 480) return res.status(400).json({ ok: false, error: 'invalid scannerIntervalMin (15-480)' });
      settings.scannerIntervalMin = v;
    }
    if (zhuangScannerLimit !== undefined) {
      const v = parseInt(zhuangScannerLimit);
      if (isNaN(v) || v < 1) return res.status(400).json({ ok: false, error: 'invalid zhuangScannerLimit' });
      settings.zhuangScannerLimit = v;
    }
    if (zhuangScannerIntervalMin !== undefined) {
      const v = parseInt(zhuangScannerIntervalMin);
      if (isNaN(v) || v < 15 || v > 480) return res.status(400).json({ ok: false, error: 'invalid zhuangScannerIntervalMin (15-480)' });
      settings.zhuangScannerIntervalMin = v;
    }
    if (positionMultiplier !== undefined) {
      const v = parseFloat(positionMultiplier);
      if (isNaN(v) || v < 0.8 || v > 20) return res.status(400).json({ ok: false, error: '仓位倍率必须在 0.8-20 之间' });
      settings.positionMultiplier = v;
    }
    if (zhuangPositionMultiplier !== undefined) {
      const v = parseFloat(zhuangPositionMultiplier);
      if (isNaN(v) || v < 0.8 || v > 20) return res.status(400).json({ ok: false, error: '庄币仓位倍率必须在 0.8-20 之间' });
      settings.zhuangPositionMultiplier = v;
    }
    if (hedgeEnabled !== undefined) {
      settings.hedgeEnabled = !!hedgeEnabled;
    }
    if (leverage !== undefined) {
      const v = parseInt(leverage);
      if (isNaN(v) || v < 1 || v > 125) return res.status(400).json({ ok: false, error: '杠杆必须在 1-125 之间' });
      settings.leverage = v;
    }
    if (glassEnabled !== undefined) {
      settings.glassEnabled = !!glassEnabled;
    }
    if (cardOpacity !== undefined) {
      const v = parseFloat(cardOpacity);
      if (isNaN(v) || v < 0.3 || v > 1) return res.status(400).json({ ok: false, error: '不透明度必须在 0.3-1 之间' });
      settings.cardOpacity = v;
    }
    if (writeSettings(settings)) {
      res.json({ ok: true, ...settings });
    } else {
      res.status(500).json({ ok: false, error: 'write failed' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/scanner-data ──────────────────────────
// 返回系统黑名单、用户黑名单、非山寨名单（供面板展示）
const SYSTEM_BL_PATH = path.join(BASE_DIR, 'data', 'altcoin-blacklist.json');
const USER_BL_PATH = path.join(BASE_DIR, 'data', 'user-blacklist.json');
const NON_ALT_PATH = path.join(BASE_DIR, 'data', 'non-alt-list.json');

app.get('/api/scanner-data', (req, res) => {
  try {
    const sysBl = readJSON(SYSTEM_BL_PATH) || { blacklist: [], reason: {} };
    const userBl = readJSON(USER_BL_PATH) || { blacklist: [], reason: {} };
    const nonAlt = readJSON(NON_ALT_PATH) || { non_alts: [], categories: {} };
    res.json({
      systemBlacklist: { blacklist: sysBl.blacklist || [], reason: sysBl.reason || {} },
      userBlacklist: { blacklist: userBl.blacklist || [], reason: userBl.reason || {} },
      nonAltList: { non_alts: nonAlt.non_alts || [], categories: nonAlt.categories || {} },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/user-blacklist ───────────────────────
app.post('/api/user-blacklist', (req, res) => {
  try {
    const { coin, reason } = req.body;
    if (!coin || typeof coin !== 'string') return res.status(400).json({ ok: false, error: 'invalid coin' });
    const upper = coin.toUpperCase().trim();
    if (!upper) return res.status(400).json({ ok: false, error: 'empty coin' });

    let data = readJSON(USER_BL_PATH) || { blacklist: [], reason: {} };
    if (data.blacklist.includes(upper)) {
      return res.json({ ok: true, coin: upper, action: 'already_exists' });
    }
    data.blacklist.push(upper);
    data.blacklist.sort();
    if (reason) data.reason[upper] = reason;
    const dir = path.dirname(USER_BL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USER_BL_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    res.json({ ok: true, coin: upper, action: 'added', total: data.blacklist.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/user-blacklist/:coin ───────────────
app.delete('/api/user-blacklist/:coin', (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase().trim();
    let data = readJSON(USER_BL_PATH);
    if (!data) return res.status(404).json({ ok: false, error: 'file not found' });
    const idx = data.blacklist.indexOf(coin);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'coin not in user blacklist' });
    data.blacklist.splice(idx, 1);
    delete data.reason[coin];
    fs.writeFileSync(USER_BL_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    res.json({ ok: true, coin, action: 'removed', total: data.blacklist.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET/POST /api/stage2-mode ─────────────────────────
const STAGE2_LINK = path.join(BASE_DIR, 'tasks', 'alt-pipeline', 'alt-intel-stage2.live.md');
const SWITCH_SCRIPT = path.join(BASE_DIR, 'scripts', 'switch-stage2-mode.sh');

app.get('/api/stage2-mode', (req, res) => {
  try {
    const out = execSync(`bash "${SWITCH_SCRIPT}" status`, { encoding: 'utf8', timeout: 5000 });
    const mode = out.includes('激进') ? 'aggressive' : 'normal';
    res.json({ ok: true, mode });
  } catch (e) {
    res.json({ ok: true, mode: 'normal' });
  }
});

app.post('/api/stage2-mode', (req, res) => {
  try {
    const { mode } = req.body;
    if (!['normal', 'aggressive'].includes(mode)) {
      return res.status(400).json({ ok: false, error: 'invalid mode' });
    }
    execSync(`bash "${SWITCH_SCRIPT}" ${mode}`, { encoding: 'utf8', timeout: 5000 });
    res.json({ ok: true, mode });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 背景图片上传 ──────────────────────────────────
const multer = require('multer');
const bgStorage = multer.diskStorage({
  destination: path.join(__dirname, 'public', 'images'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'bg-' + Date.now() + ext);
  }
});
const bgUpload = multer({
  storage: bgStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('仅支持图片和视频文件'));
  }
});

app.post('/api/settings/background', bgUpload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '未选择文件' });
    const settings = readSettings();
    settings.backgroundImage = '/images/' + req.file.filename;
    writeSettings(settings);
    res.json({ ok: true, path: settings.backgroundImage });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/settings/background', (req, res) => {
  try {
    const settings = readSettings();
    delete settings.backgroundImage;
    writeSettings(settings);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/market-brief/latest ──────────────────────
app.get('/api/market-brief/latest', (req, res) => {
  try {
    const BRIEF_DIR = path.join(BASE_DIR, 'market-brief', 'data');
    if (!fs.existsSync(BRIEF_DIR)) return res.json({ found: false });

    const files = fs.readdirSync(BRIEF_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    if (!files.length) return res.json({ found: false });

    const latest = JSON.parse(fs.readFileSync(path.join(BRIEF_DIR, files[0]), 'utf8'));

    // 读取 processed.json 补充 summary + majors
    const PROC_PATH = '/tmp/market-brief/processed.json';
    let summary = null, majors = null;
    if (fs.existsSync(PROC_PATH)) {
      try {
        const proc = JSON.parse(fs.readFileSync(PROC_PATH, 'utf8'));
        summary = proc.summary || null;
        majors = proc.majors || null;
      } catch {}
    }

    // 同时读取 Markdown 报告摘要
    const REPORT_DIR = path.join(BASE_DIR, 'market-brief', 'reports');
    const mdFile = files[0].replace('.json', '.md');
    const mdPath = path.join(REPORT_DIR, mdFile);
    let briefText = '';
    if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, 'utf8');
      const stateMatch = md.match(/## 市场状态\n([^\n]+(?:\n[^#\n]+)*)/);
      if (stateMatch) briefText = stateMatch[1].trim();
    }

    res.json({
      found: true,
      briefText,
      ...latest,
      summary,
      majors
    });
  } catch (e) {
    res.status(500).json({ error: e.message, found: false });
  }
});

// ── GET /api/dashboard ────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  try {
    const cycles = scanCycles('active');
    const allRules = getRules({ all: true });
    const rulesByCycleMap = rulesByCycle(allRules, cycles);

    // 引擎状态
    let engineStatus = 'unknown';
    const pm2Out = safeExec('pm2 jlist 2>/dev/null', { timeout: 5000 });
    if (pm2Out) {
      try {
        const pm2List = JSON.parse(pm2Out);
        const btcAlert = pm2List.find(p => p.name === 'btc-alert');
        engineStatus = btcAlert?.pm2_env?.status === 'online' ? 'online' : 'offline';
      } catch {}
    }

    // 最近 24 小时触发的警报
    // ── 近 24h 警报（带持久缓存，日志归档不丢数据） ──
    let recentAlerts = [];
    try {
      // 1. 从缓存加载已有记录
      let cached = [];
      if (fs.existsSync(ALERTS_CACHE_FILE)) {
        try { cached = JSON.parse(fs.readFileSync(ALERTS_CACHE_FILE, 'utf8')).alerts || []; } catch { cached = []; }
      }

      // 2. 从日志 grep 新触发记录
      const logFile = path.join(LOGS_DIR, 'btc-alert.log');
      const twentyFourHoursAgo = Date.now() - 24 * 3600000;
      const logAlerts = [];
      if (fs.existsSync(logFile)) {
        // 引擎格式: "2026-05-21T00:00:34: [🔧警报引擎] [INFO] [RULE-NAME] TRIGGERED"
        const raw = safeExec(`grep 'TRIGGERED' "${logFile}" | tail -1000`);
        if (raw) {
          const lines = raw.trim().split('\n').filter(Boolean);
          for (const line of lines) {
            const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
            const time = tsMatch ? tsMatch[1] : '';
            const ts = time ? new Date(time).getTime() : 0;
            if (ts <= twentyFourHoursAgo) continue; // 跳过24小时外的
            const ruleMatch = line.match(/\[([^\]]+)\]\s*TRIGGERED/);
            const rule = ruleMatch ? ruleMatch[1].trim() : line.slice(60).trim().slice(0, 100);
            logAlerts.push({ id: `${time}::${rule}`, time, rule, ts, cachedAt: Date.now() });
          }
        }
      }

      // 3. 合并：日志新记录 + 缓存旧记录，去重
      const seen = new Set(logAlerts.map(a => a.id));
      const merged = [...logAlerts];
      for (const a of cached) {
        if (!seen.has(a.id) && a.ts > twentyFourHoursAgo) {
          merged.push(a);
          seen.add(a.id);
        }
      }

      // 4. 清理24小时外的，按时间倒序
      recentAlerts = merged.filter(a => a.ts > twentyFourHoursAgo).sort((a, b) => b.ts - a.ts);

      // 5. 写回缓存
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(ALERTS_CACHE_FILE, JSON.stringify({ alerts: recentAlerts }, null, 2));
      } catch {}
    } catch {}

    // 获得最新健康报告
    const healthFiles = listFiles(HEALTH_DIR).filter(f => f.endsWith('-cycle-health.md')).sort().reverse();
    const latestHealth = healthFiles[0]?.replace('-cycle-health.md', '') || null;

    // 计算规则数量
    const activeRules = allRules.filter(r => r.status === 'active');
    const archivedRules = allRules.filter(r => r.status === 'archived');

    // 统计
    const btcCycles = cycles.filter(c => c.type === 'btc');
    const altCycles = cycles.filter(c => c.type === 'altcoin');
    const zhuangCycles = cycles.filter(c => c.type === 'zhuang');

    // 实盘持仓数（从 OKX 缓存读取，由 /api/live-pnl 每 5min 更新）
    const livePositionCount = okxPositionCountCache.count || 0;

    // 按状态分组
    const statusGroups = { alive: 0, dead: 0 };
    for (const c of cycles) {
      const rules = rulesByCycleMap[c.cycleId] || [];
      const status = cycleStatus(c, rules.length);
      statusGroups[status]++;
    }

    res.json({
      summary: {
        activeCycles: { btc: btcCycles.length, altcoin: altCycles.length, zhuang: zhuangCycles.length, total: cycles.length },
        activeRules: activeRules.length,
        archivedRules: archivedRules.length,
        totalPositions: livePositionCount,
        // 盈亏由前端单独调 /api/live-pnl 获取实盘数据
      },
      engineStatus,
      recentAlerts,
      latestHealthCheck: latestHealth,
      cyclesByStatus: statusGroups,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cycles ───────────────────────────────────
app.get('/api/cycles', (req, res) => {
  try {
    const location = req.query.archived === 'true' ? 'archived' : 'active';
    const search = req.query.search?.toLowerCase();

    let cycles = scanCycles(location);

    // 获取规则,补充 ruleCount
    const allRules = getRules({ all: true });
    const rulesByCycleMap = rulesByCycle(allRules, cycles);

    cycles = cycles.map(c => {
      const rules = rulesByCycleMap[c.cycleId] || [];
      const activeRules = rules.filter(r => r.status === 'active');
      return {
        ...c,
        ruleCount: rules.length,
        activeRuleCount: activeRules.length,
        status: cycleStatus(c, activeRules.length),
      };
    });

    // 搜索过滤
    if (search) {
      cycles = cycles.filter(c =>
        c.cycleId.toLowerCase().includes(search) ||
        c.coin.toLowerCase().includes(search)
      );
    }

    // 排序: BTC 优先, 庄币次之, 然后按最后报告时间倒序
    cycles.sort((a, b) => {
      const order = { btc: 0, zhuang: 1, altcoin: 2 };
      const oa = order[a.type] ?? 3;
      const ob = order[b.type] ?? 3;
      if (oa !== ob) return oa - ob;
      return (b.lastReportTime || '') > (a.lastReportTime || '') ? 1 : -1;
    });

    res.json({ location, count: cycles.length, cycles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cycles/:id ───────────────────────────────
app.get('/api/cycles/:id', (req, res) => {
  try {
    const cycleId = req.params.id;

    // 查 active 和 archived
    let cycleDir = path.join(ACTIVE_DIR, cycleId);
    let location = 'active';
    if (!fs.existsSync(cycleDir)) {
      cycleDir = path.join(ARCHIVED_DIR, cycleId);
      location = 'archived';
    }
    if (!fs.existsSync(cycleDir)) {
      return res.status(404).json({ error: `周期 ${cycleId} 不存在` });
    }

    const cls = classifyCycle(cycleId);
    const coin = cls.coin;
    const reportsDir = path.join(cycleDir, 'reports');
    const posFile = path.join(cycleDir, 'positions.json');

    // 报告列表
    const reportFiles = listFiles(reportsDir).filter(f => f.endsWith('.md'));
    const reports = reportFiles.map(f => ({
      name: f,
      path: path.join(reportsDir, f),
      time: mtimeISO(path.join(reportsDir, f)),
    })).sort((a, b) => (b.time || '') > (a.time || '') ? 1 : -1);

    // 快照仓位
    const snapshotPositions = readJSON(posFile);

    // 关联规则(先按 cycleId 查,再按 coin 补旧格式规则)
    let rules = getRules({ cycleId });
    if (rules.length === 0) {
      rules = getRules({ coin });
    } else {
      const coinRules = getRules({ coin });
      const existingFiles = new Set(rules.map(r => r.file));
      for (const cr of coinRules) {
        if (!existingFiles.has(cr.file)) rules.push(cr);
      }
    }

    // 扫描结果
    const scanInfo = (() => {
      if (location === 'archived') return scanCycles('archived').find(c => c.cycleId === cycleId);
      return scanCycles('active').find(c => c.cycleId === cycleId);
    })();

    res.json({
      cycleId,
      coin,
      type: cls.type,
      location,
      ...(scanInfo || {}),
      reports,
      rules,
      snapshotPositions,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/realized-pnl-history ──────────────────────
// 按日汇总已实现盈亏(5月1日起的归档周期),含每周期明细
app.get('/api/realized-pnl-history', (req, res) => {
  try {
    const cycles = scanCycles('archived');
    const dailyMap = {};
    const dailyDetail = {}; // date -> [{cycleId, coin, pnl}]
    let totalPnl = 0;

    for (const c of cycles) {
      if (c.realizedPnl === null || c.realizedPnl === undefined) continue;
      const m = c.cycleId.match(/(\d{8})/);
      if (!m) continue;
      const dateStr = m[1];
      if (dateStr < '20260511') continue;

      const day = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
      if (!dailyMap[day]) dailyMap[day] = 0;
      dailyMap[day] += c.realizedPnl;
      totalPnl += c.realizedPnl;

      if (!dailyDetail[day]) dailyDetail[day] = [];
      dailyDetail[day].push({
        cycleId: c.cycleId,
        coin: c.coin,
        type: c.type,
        pnl: c.realizedPnl,
      });
    }

    // Build cumulative series
    const days = Object.keys(dailyMap).sort();
    const daily = days.map(d => ({ date: d, pnl: Math.round(dailyMap[d] * 100) / 100, detail: dailyDetail[d] || [] }));
    let cumSum = 0;
    const cumulative = days.map(d => {
      cumSum += dailyMap[d];
      return { date: d, pnl: Math.round(cumSum * 100) / 100, detail: dailyDetail[d] || [] };
    });

    res.json({
      totalPnl: Math.round(totalPnl * 100) / 100,
      days: days.length,
      daily,
      cumulative,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 账户余额历史缓存文件 ──
const BALANCE_HISTORY_FILE = path.join(DATA_DIR, 'account-balance-history.json');

// ── GET /api/account-summary ──────────────────────────
// 一次 OKX API 调用获取账户余额+未实现盈亏，并缓存每日余额
app.get('/api/account-summary', (req, res) => {
  try {
    const balanceData = okxCli('account balance');
    if (!balanceData) {
      return res.status(502).json({ error: 'OKX API 调用失败' });
    }

    const details = balanceData.details || balanceData[0]?.details || [];
    let totalEqUsd = 0;
    let totalUpl = 0;
    let usdtDetail = null;

    for (const d of details) {
      const eqUsd = parseFloat(d.eqUsd) || 0;
      const upl = parseFloat(d.upl) || 0;
      totalEqUsd += eqUsd;
      totalUpl += upl;
      if (d.ccy === 'USDT') usdtDetail = d;
    }

    const balance = Math.round(totalEqUsd * 100) / 100;
    const unrealizedPnl = Math.round(totalUpl * 100) / 100;

    // ── 缓存今日余额 ──
    const today = new Date().toISOString().slice(0, 10);
    let history = {};
    try {
      if (fs.existsSync(BALANCE_HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(BALANCE_HISTORY_FILE, 'utf8'));
      }
    } catch { history = {}; }
    history[today] = balance;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(BALANCE_HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch {}

    res.json({
      timestamp: new Date().toISOString(),
      balance,
      unrealizedPnl,
      positionCount: 0, // 由前端从 live-pnl 获取
      // 附上 USDT 明细供参考
      usdtEq: usdtDetail ? Math.round((parseFloat(usdtDetail.eq) || 0) * 100) / 100 : 0,
      usdtAvailBal: usdtDetail ? Math.round((parseFloat(usdtDetail.availBal) || 0) * 100) / 100 : 0,
      usdtFrozenBal: usdtDetail ? Math.round((parseFloat(usdtDetail.frozenBal) || 0) * 100) / 100 : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/account-balance-history ──────────────────
// 返回每日余额历史（含累计变化）
app.get('/api/account-balance-history', (req, res) => {
  try {
    let history = {};
    if (fs.existsSync(BALANCE_HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(BALANCE_HISTORY_FILE, 'utf8'));
      } catch { history = {}; }
    }

    const days = Object.keys(history).sort();
    const daily = days.map(d => ({
      date: d,
      balance: history[d],
    }));

    // 计算每日变化（无前一日则变化=0）
    const change = days.map((d, i) => ({
      date: d,
      change: i === 0 ? 0 : Math.round((history[d] - history[days[i-1]]) * 100) / 100,
    }));

    const latestBalance = days.length > 0 ? history[days[days.length-1]] : 0;

    res.json({
      days: days.length,
      latestBalance,
      daily,
      change,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/live-pnl ──────────────────────────────────
// 一次 OKX API 调用获取全账户持仓,汇总未实现盈亏
app.get('/api/live-pnl', (req, res) => {
  try {
    const allPositions = okxCli('account positions');
    if (!allPositions) {
      return res.status(502).json({ error: 'OKX API 调用失败' });
    }

    // 只取有持仓的(pos != "0" 且 posSide != "net" 或 pos != 0)
    const held = allPositions.filter(p => {
      const pos = parseFloat(p.pos);
      return pos !== 0 && p.posSide !== 'net' || (p.posSide === 'net' && pos !== 0);
    });

    const totalUpl = held.reduce((sum, p) => sum + (parseFloat(p.upl) || 0), 0);
    const totalUplRatio = held.reduce((sum, p) => sum + (parseFloat(p.uplRatio) || 0), 0) / (held.length || 1);
    const totalRealizedPnl = held.reduce((sum, p) => sum + (parseFloat(p.realizedPnl) || 0), 0);

    // 更新 OKX 持仓数缓存（供 /api/dashboard 使用，避免重复调 OKX）
    okxPositionCountCache = { count: held.length, ts: Date.now() };
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(OKX_CACHE_FILE, JSON.stringify(okxPositionCountCache));
    } catch {}

    res.json({
      timestamp: new Date().toISOString(),
      positionCount: held.length,
      totalUpl: Math.round(totalUpl * 100) / 100,
      totalUplRatio: Math.round(totalUplRatio * 10000) / 100, // percentage
      totalRealizedPnl: Math.round(totalRealizedPnl * 100) / 100,
      positions: held.map(p => ({
        instId: p.instId,
        posSide: p.posSide,
        pos: p.pos,
        upl: p.upl,
        uplRatio: p.uplRatio,
        lever: p.lever,
        avgPx: p.avgPx,
        markPx: p.markPx,
        notionalUsd: p.notionalUsd,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/positions-detail ─────────────────────────────
// 全账户持仓 + 挂单(OCO)，供前端实盘仓位卡片使用
app.get('/api/positions-detail', (req, res) => {
  try {
    const allPositions = okxCli('account positions');
    const pendingOrders = okxCli('swap orders');
    const algoOrders = okxCli('swap algo orders');

    // 只取持仓量非零
    const held = (allPositions || []).filter(p => {
      const pos = parseFloat(p.pos);
      return pos !== 0 && !isNaN(pos);
    });

    // 处理挂单（合并普通订单 + 算法订单）
    const allOrders = [...(pendingOrders || []), ...(algoOrders || [])];
    const orders = allOrders.map(o => ({
      instId: o.instId,
      ordId: o.ordId,
      side: o.side,
      ordType: o.ordType,
      sz: o.sz,
      px: o.px,
      state: o.state,
      algoClOrdId: o.algoClOrdId || '',
      algoId: o.algoId || '',
      cTime: o.cTime,
      uTime: o.uTime,
      tpTriggerPx: o.tpTriggerPx || '',
      tpOrdPx: o.tpOrdPx || '',
      slTriggerPx: o.slTriggerPx || '',
      slOrdPx: o.slOrdPx || '',
    }));

    // 建立 instId → orders 索引
    const ordersByInstId = {};
    orders.forEach(o => {
      if (!ordersByInstId[o.instId]) ordersByInstId[o.instId] = [];
      ordersByInstId[o.instId].push(o);
    });

    const positions = held.map(p => {
      const upl = parseFloat(p.upl) || 0;
      const uplRatio = parseFloat(p.uplRatio) || 0;
      const notionalUsd = parseFloat(p.notionalUsd) || 0;
      return {
        instId: p.instId,
        posSide: p.posSide,
        pos: p.pos,
        availPos: p.availPos,
        avgPx: p.avgPx,
        markPx: p.markPx,
        last: p.last,
        lever: p.lever,
        mgnMode: p.mgnMode,
        upl: String(upl),
        uplRatio: String(uplRatio),
        realizedPnl: p.realizedPnl,
        fee: p.fee,
        fundingFee: p.fundingFee,
        liqPx: p.liqPx,
        margin: p.margin,
        mgnRatio: p.mgnRatio,
        notionalUsd: String(notionalUsd),
        cTime: p.cTime,
        uTime: p.uTime,
        orders: ordersByInstId[p.instId] || [],
      };
    });

    const totalUpl = positions.reduce((s, p) => s + parseFloat(p.upl), 0);

    res.json({
      timestamp: new Date().toISOString(),
      count: positions.length,
      orderCount: orders.length,
      totalUpl: Math.round(totalUpl * 100) / 100,
      positions,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/scanner-logs ─────────────────────────────────
// 返回扫描日志的结构化提取 + 原始日志
app.get('/api/scanner-logs', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 500;
    const search = (req.query.search || '').toUpperCase().trim();

    const logFiles = [
      path.join(LOGS_DIR, 'scanner-cron.log'),
      path.join(LOGS_DIR, 'alt-scanner.log'),
    ];

    // 合并两个日志文件的最近 N 行（每个文件取 lines 行，不截断合并结果）
    let allLines = [];
    for (const f of logFiles) {
      if (!fs.existsSync(f)) continue;
      const raw = safeExec(`tail -${lines} "${f}"`);
      if (!raw) continue;
      const fileLines = raw.trim().split('\n').filter(Boolean);
      for (const line of fileLines) {
        const tsMatch = line.match(/\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\]/);
        allLines.push({
          time: tsMatch ? tsMatch[1].replace('T', ' ') : '',
          text: line,
          source: path.basename(f),
        });
      }
    }

    // 按时间排序（最新在前），搜索过滤
    allLines.sort((a, b) => b.time.localeCompare(a.time) || 0);
    if (search) {
      allLines = allLines.filter(l => l.text.toUpperCase().includes(search));
    }

    // 提取结构化命中记录（先收集原始数据，再按币种+时间窗口去重）
    const rawHits = [];
    for (const l of allLines) {
      // 格式1: [扫描] ✅ 命中: COIN / ✅ 命中币种: COIN
      let m = l.text.match(/✅\s*命中(?:币种)?[:：]\s*([A-Z0-9]+)/);
      if (m) {
        const detailM = l.text.match(/涨跌幅[:：]\s*([+-]?[\d.]+%)/);
        const oiM = l.text.match(/OI(?:变化)?[:：]\s*([+-]?[\d.]+%)/);
        rawHits.push({
          time: l.time,
          coin: m[1],
          type: 'hit',
          change: detailM ? detailM[1] : '',
          oiChange: oiM ? oiM[1] : '',
          source: l.source,
        });
        continue;
      }
      // 格式2: [筛选] COIN | ...
      m = l.text.match(/\[筛选\]\s*([A-Z0-9]+)-USDT-SWAP\s*\|/);
      if (m) {
        const detailM = l.text.match(/涨跌幅[:：]\s*([+-]?[\d.]+%)/);
        const resultM = l.text.match(/(通过|跳过|命中)[^|]*$/);
        rawHits.push({
          time: l.time,
          coin: m[1],
          type: 'screening',
          change: detailM ? detailM[1] : '',
          oiChange: '',
          result: resultM ? resultM[1].trim() : '',
          source: l.source,
        });
        continue;
      }
      // dispatch 记录
      if (l.text.includes('[dispatch]')) {
        m = l.text.match(/dispatch.*?\|\s*(med|high|low)[^|]*\|\s*([A-Z0-9]+)\s*\|/);
        if (m) {
          rawHits.push({
            time: l.time,
            coin: m[2],
            type: 'dispatch',
            priority: m[1],
            source: l.source,
          });
        }
      }
    }

    // 去掉无时间戳的噪音条目（dispatch 行等无 [YYYY-MM-DD HH:MM:SS] 格式）
    const validHits = rawHits.filter(h => h.time && h.time.length >= 16);

    // 补充：对缺少详情的 hit，从相邻行提取涨跌幅/OI（alt-scanner.log 格式中详情在下一行）
    for (const h of validHits) {
      if (h.type !== 'hit') continue;
      if (h.change && h.oiChange) continue; // 已有完整详情
      const hIdx = allLines.findIndex(l => l.time === h.time && l.text.includes(h.coin));
      if (hIdx < 0) continue;
      // 检查前后 3 行，找同源文件的涨跌幅/OI 行
      for (let offset = -3; offset <= 3; offset++) {
        if (offset === 0) continue;
        const idx = hIdx + offset;
        if (idx < 0 || idx >= allLines.length) continue;
        const neighbor = allLines[idx];
        if (neighbor.source !== h.source) continue;
        // 不跨超过 5 秒
        if (Math.abs(new Date(neighbor.time).getTime() - new Date(h.time).getTime()) > 5000) continue;
        if (!h.change) {
          const dm = neighbor.text.match(/涨跌幅[:：]\s*([+-]?[\d.]+%)/);
          if (dm) h.change = dm[1];
        }
        if (!h.oiChange) {
          const om = neighbor.text.match(/OI(?:变化)?[:：]\s*([+-]?[\d.]+%)/);
          if (om) h.oiChange = om[1];
        }
        if (h.change && h.oiChange) break;
      }
    }

    // 去重：同一币种+同一类型 60 秒内的记录合并为一条
    // 合并策略：保留有详情的字段（change/oiChange 非空优先）
    const hits = [];
    const DEDUP_WINDOW_MS = 60000;
    for (const h of validHits) {
      const hTime = new Date(h.time).getTime();
      const existing = hits.find(e =>
        e.coin === h.coin &&
        e.type === h.type &&
        Math.abs(new Date(e.time).getTime() - hTime) <= DEDUP_WINDOW_MS
      );
      if (existing) {
        if (!existing.change && h.change) existing.change = h.change;
        if (!existing.oiChange && h.oiChange) existing.oiChange = h.oiChange;
        if (!existing.result && h.result) existing.result = h.result;
        if (!existing.priority && h.priority) existing.priority = h.priority;
      } else {
        hits.push({ ...h });
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      totalLines: allLines.length,
      hitCount: hits.length,
      search: search || null,
      hits,
      rawLines: allLines,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/silence-monitor-logs ──────────────────────
// 返回静默监控日志的结构化提取 + 原始日志
app.get('/api/silence-monitor-logs', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 500;
    const search = (req.query.search || '').toUpperCase().trim();

    const logFile = path.join(LOGS_DIR, 'silence-monitor.log');
    if (!fs.existsSync(logFile)) {
      return res.json({ timestamp: new Date().toISOString(), totalLines: 0, hitCount: 0, search: search || null, hits: [], rawLines: [] });
    }

    const raw = safeExec(`tail -${lines} "${logFile}"`);
    if (!raw) {
      return res.json({ timestamp: new Date().toISOString(), totalLines: 0, hitCount: 0, search: search || null, hits: [], rawLines: [] });
    }

    // 解析所有行
    let allLines = raw.trim().split('\n').filter(Boolean).map(line => {
      const tsMatch = line.match(/\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\]/);
      return { time: tsMatch ? tsMatch[1].replace('T', ' ') : '', text: line };
    });

    // 去重：PM2 日志会重复输出（stderr + stdout），相同文本相邻的去重
    allLines = allLines.filter((l, i, arr) => i === 0 || l.text !== arr[i - 1].text);

    let filteredLines = allLines;
    if (search) filteredLines = allLines.filter(l => l.text.toUpperCase().includes(search));

    // 提取结构化记录
    const rawHits = [];
    for (const l of allLines) {
      // 周期检查
      let m = l.text.match(/═══+\s*(静默检查[^═]*)\s*═══+/);
      if (m) { rawHits.push({ time: l.time, coin: '', type: 'cycle', result: m[1].trim() }); continue; }

      // 活跃周期数
      m = l.text.match(/发现\s+(\d+)\s+个活跃/);
      if (m) { rawHits.push({ time: l.time, coin: '', type: 'summary', result: `发现 ${m[1]} 个活跃周期` }); continue; }
      m = l.text.match(/静默周期[:：]\s*(\d+)\s*个/);
      if (m) {
        const skipM = l.text.match(/跳过冷却[:：]\s*(\d+)/);
        rawHits.push({ time: l.time, coin: '', type: 'summary', result: `静默 ${m[1]} 个（跳过 ${skipM ? skipM[1] : 0} 个冷却）` });
        continue;
      }

      // 触发
      m = l.text.match(/触发静默检查[:：]\s*(\S+)\s*\(([A-Z0-9]+)\)\s*\|\s*静默\s*([\d.]+)h\s*\|\s*持仓\s*(\d+)\s*\|\s*阈值\s*(\d+)h/);
      if (m) {
        rawHits.push({ time: l.time, coin: m[2], type: 'trigger', silenceHours: parseFloat(m[3]), posCount: parseInt(m[4]), threshold: parseInt(m[5]) });
        continue;
      }

      // 成功
      m = l.text.match(/✅\s*([A-Z0-9]+)\s*阶段一完成\s*\|\s*合约[=:]\s*(OK|FAIL)\s*\|?\s*报告[=:]?\s*(\d+)篇/);
      if (m) { rawHits.push({ time: l.time, coin: m[1], type: 'success', contractOk: m[2] === 'OK', reportCount: parseInt(m[3]) }); continue; }

      // 失败
      m = l.text.match(/❌\s*([A-Z0-9]+)\s*(.*)/);
      if (m) {
        const reason = m[2].substring(0, 60).replace(/\[ERROR\]/, '').trim();
        rawHits.push({ time: l.time, coin: m[1], type: 'error', reason });
        continue;
      }

      // 启动/配置
      if (l.text.includes('🚀') && l.text.includes('静默监控器')) {
        rawHits.push({ time: l.time, coin: '', type: 'startup', result: '监控器启动' }); continue;
      }
      m = l.text.match(/配置[:：]\s*(.*)/);
      if (m) { rawHits.push({ time: l.time, coin: '', type: 'config', result: m[1].trim() }); continue; }

      // 清理过期
      m = l.text.match(/清理过期状态记录[:：]\s*(\d+)/);
      if (m) { rawHits.push({ time: l.time, coin: '', type: 'cleanup', result: `清理 ${m[1]} 条过期状态` }); continue; }
    }

    // 去重：同币种+同类型 120s 内合并
    const hits = [];
    const DEDUP_MS = 120000;
    for (const h of rawHits) {
      if (!h.coin && !['cycle', 'summary', 'startup', 'config', 'cleanup'].includes(h.type)) continue;
      const hTime = new Date(h.time).getTime();
      const dup = hits.find(e => e.coin === h.coin && e.type === h.type &&
        Math.abs(new Date(e.time).getTime() - hTime) <= DEDUP_MS);
      if (!dup) hits.push({ ...h });
    }
    hits.sort((a, b) => b.time.localeCompare(a.time));

    res.json({
      timestamp: new Date().toISOString(),
      totalLines: allLines.length,
      hitCount: hits.length,
      search: search || null,
      hits,
      rawLines: filteredLines,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cycles/:id/logs ─────────────────────
app.get('/api/cycles/:id/logs', (req, res) => {
  try {
    const cycleId = req.params.id;
    const cls = classifyCycle(cycleId);
    const coin = cls.coin;
    const lines = parseInt(req.query.lines) || 200;

    // 根据周期类型确定日志文件
    let logFileName;
    if (cls.isBTC) {
      logFileName = 'daily-report-process.log';
    } else if (cls.isZhuang) {
      logFileName = `zhuang-${coin}-process.log`;
    } else if (coin) {
      logFileName = `alt-${coin}-process.log`;
    } else {
      return res.status(400).json({ error: '无法解析币种' });
    }

    const logFile = path.join(LOGS_DIR, logFileName);
    if (!fs.existsSync(logFile)) {
      return res.json({ cycleId, coin, logFile: logFileName, exists: false, entries: [] });
    }

    const raw = safeExec(`tail -${Math.min(lines, 1000)} "${logFile}"`);
    const entries = raw
      ? raw.trim().split('\n').filter(Boolean).map(line => {
          const tsMatch = line.match(/\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\]/) || line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
          return {
            time: tsMatch ? tsMatch[1] : '',
            text: line,
          };
        })
      : [];

    res.json({ cycleId, coin, logFile: logFileName, exists: true, count: entries.length, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cycles/:id/positions/live ───────────────
app.get('/api/cycles/:id/positions/live', (req, res) => {
  try {
    // 解析币种
    const cycleId = req.params.id;
    const cls = classifyCycle(cycleId);
    const coin = cls.coin;

    if (!coin) return res.status(400).json({ error: '无法解析币种' });

    // 调用 OKX API 获取所有持仓
    const allPositions = okxCli('account positions');
    if (!allPositions) {
      return res.status(502).json({ error: 'OKX API 调用失败', coin });
    }

    // 过滤该币种
    const filtered = allPositions.filter(p => {
      const instId = p.instId || '';
      return instId.startsWith(`${coin}-`);
    });

    // 精简字段
    const simplified = filtered.map(p => ({
      instId: p.instId,
      instType: p.instType,
      posSide: p.posSide,
      pos: p.pos,
      availPos: p.availPos,
      avgPx: p.avgPx,
      markPx: p.markPx,
      last: p.last,
      lever: p.lever,
      mgnMode: p.mgnMode,
      upl: p.upl,
      uplRatio: p.uplRatio,
      realizedPnl: p.realizedPnl,
      fee: p.fee,
      fundingFee: p.fundingFee,
      liqPx: p.liqPx,
      margin: p.margin,
      mgnRatio: p.mgnRatio,
      notionalUsd: p.notionalUsd,
      cTime: p.cTime,
      uTime: p.uTime,
    }));

    res.json({
      coin,
      cycleId,
      timestamp: new Date().toISOString(),
      count: simplified.length,
      positions: simplified,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/cycles/:id ───────────────────────────────
// 删除归档周期文件夹(仅允许删除已归档的)
app.delete('/api/cycles/:id', (req, res) => {
  try {
    const cycleId = req.params.id;
    const archivedPath = path.join(ARCHIVED_DIR, cycleId);

    if (!fs.existsSync(archivedPath)) {
      return res.status(404).json({ error: `周期 ${cycleId} 不存在或不在归档目录` });
    }

    // Safety: only allow deleting from archived directory
    const activePath = path.join(ACTIVE_DIR, cycleId);
    if (fs.existsSync(activePath)) {
      return res.status(400).json({ error: `周期 ${cycleId} 仍在活跃目录,不能删除` });
    }

    // Delete the folder
    const result = safeExec(`rm -rf "${archivedPath}"`);
    if (result === null) {
      return res.status(500).json({ error: '删除失败' });
    }

    console.log(`[delete] ${cycleId} deleted from archived`);
    res.json({ success: true, cycleId, message: `周期 ${cycleId} 已删除` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cycles/:id/archive ─────────────────────
app.post('/api/cycles/:id/archive', (req, res) => {
  try {
    const cycleId = req.params.id;
    const reason = req.body?.reason || '面板手动归档';
    const cycleDir = path.join(ACTIVE_DIR, cycleId);

    if (!fs.existsSync(cycleDir)) {
      return res.status(404).json({ error: `活跃周期 ${cycleId} 不存在` });
    }

    // 使用统一归档脚本
    const script = path.join(SCRIPTS_DIR, 'archive-cycle.js');
    const cmd = `node "${script}" --cycle "${cycleId}" --by manual --reason "${reason}"`;
    const output = safeExec(cmd);

    res.json({ success: true, cycleId, reason, output: output?.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/rules/:file/logs ────────────────────────
app.get('/api/rules/:file/logs', (req, res) => {
  try {
    const ruleFile = req.params.file.replace(/[^a-zA-Z0-9_.-]/g, '');
    const ruleName = req.query.name || '';  // 可选:规则显示名(引擎日志新格式用它)
    const lines = parseInt(req.query.lines) || 150;
    const logFile = path.join(LOGS_DIR, 'btc-alert.log');

    if (!fs.existsSync(logFile)) {
      return res.json({ ruleFile, ruleName, lines: 0, entries: [] });
    }

    // 构建 grep 模式:文件名 OR 规则名(新日志 CHECK 行只含规则名)
    let pattern = ruleFile.replace(/\.js$/, '');
    if (ruleName && ruleName !== pattern) {
      pattern = `-E "${pattern}|${ruleName.replace(/[|\\]/g, '')}"`;
    }

    const raw = safeExec(`grep -i ${pattern.includes('|') ? pattern : `"${pattern}"`} "${logFile}" | tail -${Math.min(lines, 500)}`);
    if (!raw) return res.json({ ruleFile, ruleName, lines: 0, entries: [] });

    const entries = raw.trim().split('\n').filter(Boolean).map(line => {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
      return {
        time: tsMatch ? tsMatch[1] : '',
        text: line,
      };
    });

    res.json({ ruleFile, ruleName, logFile: 'btc-alert.log', count: entries.length, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/rules/archive ─────────────────────────
app.post('/api/rules/archive', (req, res) => {
  console.log('[dashboard] POST /api/rules/archive body:', JSON.stringify(req.body));
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: '缺少 file 参数' });
    // query-rules.js 返回的 file 不带 .js 后缀，补上
    const fileName = file.endsWith('.js') ? file : file + '.js';
    const srcFile = path.join(RULES_DIR, fileName);
    if (!fs.existsSync(srcFile)) return res.status(404).json({ error: `规则 ${fileName} 不存在` });
    const destFile = path.join(RULES_ARCHIVE_DIR, fileName);
    // 如果归档目录已有同名文件，加时间戳后缀
    let finalDest = destFile;
    if (fs.existsSync(destFile)) {
      const ts = Date.now();
      finalDest = destFile.replace(/\.js$/, `-${ts}.js`);
    }
    // 将文件读入内存，更新 C19 元数据（status→archived, 归档时间/来源）
    let content = fs.readFileSync(srcFile, 'utf8');
    const now = new Date().toISOString();
    content = content
      .replace(/(status:\s*)['"]?(?:[^,'"]+|null)['"]?/g, `$1'archived'`)
      .replace(/(archivedAt:\s*)['"]?(?:[^,'"\n]+|null)['"]?/g, `$1'${now}'`)
      .replace(/(archivedBy:\s*)['"]?(?:[^,'"\n]+|null)['"]?/g, `$1'manual'`);
    fs.writeFileSync(finalDest, content, 'utf8');
    // 写完后删掉源文件（rename 等效于 cp + rm）
    fs.unlinkSync(srcFile);
    console.log(`[dashboard] 规则归档: ${file} → ${path.basename(finalDest)}`);
    res.json({ success: true, file, dest: path.basename(finalDest) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/reports/:cycleId/:filename ────────────
app.delete('/api/reports/:cycleId/:filename', (req, res) => {
  try {
    const { cycleId, filename } = req.params;
    let cycleDir = path.join(ACTIVE_DIR, cycleId);
    if (!fs.existsSync(cycleDir)) cycleDir = path.join(ARCHIVED_DIR, cycleId);
    if (!fs.existsSync(cycleDir)) return res.status(404).json({ error: `周期 ${cycleId} 不存在` });
    const reportFile = path.join(cycleDir, 'reports', filename);
    if (!fs.existsSync(reportFile)) return res.status(404).json({ error: `报告 ${filename} 不存在` });
    fs.unlinkSync(reportFile);
    console.log(`[dashboard] 报告删除: ${path.join(cycleDir, 'reports', filename)}`);
    res.json({ success: true, cycleId, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/cycles/:id/logs ──────────────────────
app.delete('/api/cycles/:id/logs', (req, res) => {
  try {
    const cycleId = req.params.id;
    let cycleDir = path.join(ACTIVE_DIR, cycleId);
    if (!fs.existsSync(cycleDir)) cycleDir = path.join(ARCHIVED_DIR, cycleId);
    if (!fs.existsSync(cycleDir)) return res.status(404).json({ error: `周期 ${cycleId} 不存在` });
    const cls = classifyCycle(cycleId);
    const coin = cls.coin;
    const logFile = path.join(LOGS_DIR, `${cls.isBTC ? 'daily-report-process' : cls.isZhuang ? `zhuang-${coin}-process` : `alt-${coin}-process`}.log`);
    if (fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, '');
      console.log(`[dashboard] 日志清空: ${logFile}`);
    }
    res.json({ success: true, cycleId, logFile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cron/jobs ───────────────────────────────
// 从调度器缓存读取（毫秒级），不再调 openclaw CLI
app.get('/api/cron/jobs', (req, res) => {
  try {
    const cacheFile = path.join(BASE_DIR, 'data', 'cron-list-cache.json');
    if (!fs.existsSync(cacheFile)) return res.json({ jobs: [] });
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data.jobs || []);
    // 返回完整字段，前端可展开查看全部参数
    const jobs = list.map(j => ({
      id: j.id,
      name: j.name,
      agentId: j.agentId,
      enabled: j.enabled,
      deleteAfterRun: j.deleteAfterRun,
      schedule: j.schedule,
      state: j.state || {},
      createdAtMs: j.createdAtMs,
      sessionTarget: j.sessionTarget,
      payload: j.payload || {},
      delivery: j.delivery || {},
      updatedAtMs: j.updatedAtMs,
      wakeMode: j.wakeMode,
    }));
    res.json({ jobs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cron/jobs/live ──────────────────────────
// 即时刷新：直接调 openclaw CLI（4-5s），用于手动刷新按钮
app.get('/api/cron/jobs/live', (req, res) => {
  try {
    const raw = safeExec('openclaw cron list --json 2>&1', { timeout: 15000 });
    if (!raw) return res.json({ jobs: [] });
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data.jobs || []);
    const jobs = list.map(j => ({
      id: j.id,
      name: j.name,
      agentId: j.agentId,
      enabled: j.enabled,
      deleteAfterRun: j.deleteAfterRun,
      schedule: j.schedule,
      state: j.state || {},
      createdAtMs: j.createdAtMs,
      sessionTarget: j.sessionTarget,
      payload: j.payload || {},
      delivery: j.delivery || {},
      updatedAtMs: j.updatedAtMs,
      wakeMode: j.wakeMode,
    }));
    // 同时回写缓存，让调度器下次读到时也是最新的
    try {
      fs.writeFileSync(path.join(BASE_DIR, 'data', 'cron-list-cache.json'), raw, 'utf8');
    } catch {}
    res.json({ jobs, live: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cron/system ────────────────────────────────
app.get('/api/cron/system', (req, res) => {
  try {
    const lines = readCrontabLines();
    if (!lines.length) return res.json({ entries: [], count: 0 });

    const entries = [];
    let pendingComment = '';

    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line) { pendingComment = ''; continue; }
      if (line.match(/^[A-Z_]+\s*=/)) continue;

      if (line.startsWith('#') && !line.startsWith(PAUSED_PREFIX)) {
        pendingComment = line.replace(/^#\s*/, '');
        continue;
      }

      let status = 'active';
      if (line.startsWith(PAUSED_PREFIX)) {
        status = 'paused';
        line = line.slice(PAUSED_PREFIX.length).trim();
      }

      const parts = parseCronLine(line);
      if (!parts) continue;

      const [, min, hour, dom, month, dow, command] = parts;
      entries.push(buildEntry(min, hour, dom, month, dow, command, status, pendingComment || null));
      pendingComment = '';
    }

    // 对扫描器条目，用 dashboard 设置中的实际间隔覆盖 scheduleDesc
    try {
      const settings = readSettings();
      for (const entry of entries) {
        if (entry.command && entry.command.includes('scanner-zhuang-runner.sh')) {
          const intervalMin = settings.zhuangScannerIntervalMin || 60;
          entry.scheduleDesc = intervalMin >= 60 && intervalMin % 60 === 0
            ? `每 ${intervalMin / 60} 小时`
            : `每 ${intervalMin} 分钟`;
          entry.effectiveInterval = true;
        } else if (entry.command && entry.command.includes('scanner-runner.sh')) {
          const intervalMin = settings.scannerIntervalMin || 30;
          entry.scheduleDesc = intervalMin >= 60 && intervalMin % 60 === 0
            ? `每 ${intervalMin / 60} 小时`
            : `每 ${intervalMin} 分钟`;
          entry.effectiveInterval = true;
        }
      }
    } catch (_) { /* settings read failed, use cron expression */ }

    res.json({ entries, count: entries.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cron/system/run ───────────────────────────
app.post('/api/cron/system/run', (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: '缺少 command 参数' });
    const { spawn } = require('child_process');
    const child = spawn('bash', ['-c', command], { cwd: BASE_DIR, detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`[system-cron] 手动触发: ${command.slice(0, 80)}`);
    res.json({ ok: true, message: '命令已在后台启动' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cron/system/toggle ─────────────────────────
app.post('/api/cron/system/toggle', (req, res) => {
  try {
    const { command, enable } = req.body;
    if (!command) return res.status(400).json({ error: '缺少 command 参数' });
    const lines = readCrontabLines();
    if (!lines.length) return res.status(404).json({ error: 'crontab 为空' });

    const newLines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && !trimmed.startsWith(PAUSED_PREFIX)) return line;
      if (!parseCronLine(trimmed) && !parseCronLine(trimmed.startsWith(PAUSED_PREFIX) ? trimmed.slice(PAUSED_PREFIX.length).trim() : trimmed)) return line;
      let target = trimmed;
      if (target.startsWith(PAUSED_PREFIX)) target = target.slice(PAUSED_PREFIX.length).trim();
      const parts = parseCronLine(target);
      const targetCmd = parts ? parts[6] : target;
      if (targetCmd !== command) return line;
      if (enable) {
        if (trimmed.startsWith(PAUSED_PREFIX)) return trimmed.slice(PAUSED_PREFIX.length).trim();
        return line;
      } else {
        if (!trimmed.startsWith(PAUSED_PREFIX)) return `${PAUSED_PREFIX} ${trimmed}`;
        return line;
      }
    });

    writeCrontabLines(newLines);
    console.log(`[system-cron] ${enable ? '恢复' : '暂停'}: ${command.slice(0, 80)}`);
    res.json({ ok: true, action: enable ? 'resumed' : 'paused' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/cron/system ──────────────────────────────
app.delete('/api/cron/system', (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: '缺少 command 参数' });
    const lines = readCrontabLines();
    if (!lines.length) return res.status(404).json({ error: 'crontab 为空' });

    const before = lines.length;
    const newLines = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && !trimmed.startsWith(PAUSED_PREFIX)) return true;
      let target = trimmed;
      if (target.startsWith(PAUSED_PREFIX)) target = target.slice(PAUSED_PREFIX.length).trim();
      if (!parseCronLine(target)) return true;
      const parts = parseCronLine(target);
      const targetCmd = parts ? parts[6] : target;
      return targetCmd !== command;
    });

    // 清理孤立注释
    const cleaned = [];
    for (let i = 0; i < newLines.length; i++) {
      const cur = newLines[i].trim();
      const next = i + 1 < newLines.length ? newLines[i + 1].trim() : '';
      if (cur.startsWith('#') && !cur.startsWith(PAUSED_PREFIX) && (!next || next.startsWith('#') || next === '')) continue;
      cleaned.push(newLines[i]);
    }

    writeCrontabLines(cleaned);
    console.log(`[system-cron] 已删除: ${command.slice(0, 80)}`);
    res.json({ ok: true, deleted: before > newLines.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cron/:id/run', (req, res) => {
  try {
    const output = safeExec(`openclaw cron run "${req.params.id}" 2>&1`);
    res.json({ success: true, output: output?.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/cron/:id', (req, res) => {
  try {
    const output = safeExec(`openclaw cron rm "${req.params.id}" 2>&1`);
    res.json({ success: true, output: output?.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/cron/:id', (req, res) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: '需要 enabled (boolean)' });
    const action = enabled ? 'enable' : 'disable';
    const output = safeExec(`openclaw cron ${action} "${req.params.id}" 2>&1`);
    res.json({ success: true, enabled, output: output?.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cron/boxplot ────────────────────────────
// 分析任务耗时箱线图数据（按小时 / 天 聚合）
app.get('/api/cron/boxplot', (req, res) => {
  try {
    const range = req.query.range || '24h';
    const model = req.query.model || '';
    const isHourly = range === '24h';
    const bucketMs = isHourly ? 3600000 : 86400000;
    const bucketCount = isHourly ? 24 : 7;
    const runsDir = path.join(require('os').homedir(), '.openclaw', 'cron', 'runs');
    if (!fs.existsSync(runsDir)) return res.json({ buckets: [] });

    // ── 桶对齐到整点 / 整天边界 ──
    const now = new Date();
    let alignedEnd;
    if (isHourly) {
      alignedEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0).getTime();
    } else {
      alignedEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime();
    }
    const cutoffMs = alignedEnd - bucketCount * bucketMs;

    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
      const end = alignedEnd - i * bucketMs;
      const start = end - bucketMs;
      const d = new Date(start);
      buckets.push({
        start, end,
        label: isHourly ? String(d.getHours()).padStart(2,'0')+':00'
          : `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
        analysis: [], other: []
      });
    }
    buckets.reverse();

    // ── 名字缓存 + 分类 ──
    const nameMap = updateCronNameCache();

    // cron 名优先 → 分析类任务（alt-instant-*, alt-scanner-*, alert-*, july-btc-*）
    function classify(jobId, summary) {
      const nm = nameMap[jobId];
      if (nm) {
        if (/^(alt-instant-|alt-scanner-|alert-|july-btc-)/.test(nm)) return 'analysis';
        return 'other';
      }
      return /阶段二|全流程|全四阶段|扫描完成|山寨.*扫描|即时分析.*(完成|摘要|全流程)/.test(summary||'') ? 'analysis' : 'other';
    }

    // ── 读取文件 ──
    const files = listFiles(runsDir).filter(f => {
      try { return fs.statSync(path.join(runsDir, f)).mtimeMs > cutoffMs; }
      catch { return false; }
    });

    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(runsDir, f), 'utf8');
        for (const line of raw.trim().split('\n')) {
          try {
            const e = JSON.parse(line);
            if (e.action !== 'finished' || !e.durationMs || !e.runAtMs) continue;
            if (model && e.model !== model) continue;
            if (e.runAtMs < cutoffMs) continue;
            const cat = classify(e.jobId, e.summary);
            for (const b of buckets) {
              if (e.runAtMs >= b.start && e.runAtMs < b.end) {
                b[cat].push(e.durationMs);
                break;
              }
            }
          } catch {}
        }
      } catch {}
    }

    function boxStats(arr) {
      if (!arr || arr.length === 0) return null;
      const s = arr.slice().sort((a,b) => a-b);
      const n = s.length;
      if (n < 3) {
        // 1-2 个点：用单值模拟箱线图
        return { count: n, min: s[0], q1: s[0], median: s[0], q3: s[n-1], max: s[n-1], outliers: [], iqr: 0, rawMin: s[0], rawMax: s[n-1] };
      }
      const median = n%2 ? s[Math.floor(n/2)] : (s[n/2-1]+s[n/2])/2;
      const q1 = s[Math.floor(n/4)];
      const q3 = s[Math.floor(3*n/4)];
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      const outliers = s.filter(v => v < lower || v > upper);
      const whiskerMin = s.find(v => v >= lower) || s[0];
      const whiskerMax = [...s].reverse().find(v => v <= upper) || s[n-1];
      return { count: n, min: whiskerMin, q1, median, q3, max: whiskerMax, outliers, iqr, rawMin: s[0], rawMax: s[n-1] };
    }

    const result = buckets.map(b => ({
      label: b.label,
      analysis: boxStats(b.analysis),
      other: boxStats(b.other),
    }));

    const modelSet = new Set();
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(runsDir, f), 'utf8');
        for (const line of raw.trim().split('\n')) {
          try { const e = JSON.parse(line); if (e.action==='finished'&&e.model) modelSet.add(e.model); } catch {}
        }
      } catch {}
    }

    res.json({ buckets: result, range, model, availableModels: [...modelSet].sort() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cron/history ────────────────────────────
// 聚合所有已执行完毕的 cron 记录
app.get('/api/cron/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const runsDir = path.join(require('os').homedir(), '.openclaw', 'cron', 'runs');
    if (!fs.existsSync(runsDir)) return res.json({ entries: [] });

    // 只读最近 7 天修改过的文件
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const files = listFiles(runsDir).filter(f => {
      try { return fs.statSync(path.join(runsDir, f)).mtimeMs > cutoff; }
      catch { return false; }
    });

    // 获取任务名映射（关联 jobId → name，含持久化缓存 + 后台定时更新）
    const nameMap = updateCronNameCache();

    // 收集所有条目
    const allEntries = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(runsDir, f), 'utf8');
        const lines = raw.trim().split('\n');
        // 每个文件取最后 3 条（避免一次性加载过多）
        const recent = lines.slice(-3);
        for (const line of recent) {
          try {
            const e = JSON.parse(line);
            if (e.action === 'finished') {
              allEntries.push({
                jobId: e.jobId,
                name: nameMap[e.jobId] || '',
                runAtMs: e.runAtMs,
                durationMs: e.durationMs,
                status: e.status,
                summary: e.summary || '',
                model: e.model || '',
              });
            }
          } catch {}
        }
      } catch {}
    }

    // 按时间倒序
    allEntries.sort((a, b) => (b.runAtMs || 0) - (a.runAtMs || 0));
    res.json({ entries: allEntries.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cron/:id/runs ───────────────────────────
app.get('/api/cron/:id/runs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const raw = safeExec(`openclaw cron runs --id "${req.params.id}" --limit ${limit} --expect-final 2>&1`);
    if (!raw) return res.json({ entries: [], total: 0 });
    const data = JSON.parse(raw);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pm2/:action ───────────────────────────────
// 控制 PM2 进程 restart / stop / start / list
app.post('/api/pm2/:action', (req, res) => {
  try {
    const { action } = req.params;
    const { name } = req.body;
    if (!['restart','stop','start','list'].includes(action)) {
      return res.status(400).json({ error: `非法操作: ${action}` });
    }

    if (action === 'list') {
      const out = safeExec('pm2 jlist 2>/dev/null');
      if (!out) return res.json({ processes: [] });
      const list = JSON.parse(out);
      const procs = list.map(p => ({
        name: p.name,
        status: p.pm2_env?.status || 'unknown',
        pid: p.pid,
        cpu: p.monit?.cpu || 0,
        memory: Math.round((p.monit?.memory || 0) / 1048576 * 10) / 10,
        restarts: p.pm2_env?.restart_time || 0,
        uptime: p.pm2_env?.pm_uptime || 0,
      }));
      return res.json({ processes: procs });
    }

    if (!name) return res.status(400).json({ error: '缺少 name 参数' });
    console.log(`[pm2] ${action} ${name}`);
    safeExec(`pm2 ${action} ${name} 2>&1`, { timeout: 15000 });
    res.json({ ok: true, action, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/dispatcher/status ─────────────────────────
// 调度器状态（直接 Node.js HTTP 请求，不经过 shell/proxy）
app.get('/api/dispatcher/status', (req, res) => {
  const http = require('http');
  const dispatcherReq = http.get('http://127.0.0.1:3102/status', { timeout: 5000 }, (dispatcherRes) => {
    let data = '';
    dispatcherRes.on('data', c => data += c);
    dispatcherRes.on('end', () => {
      try { res.json(JSON.parse(data)); } catch (e) { res.json({ error: 'parse error' }); }
    });
  });
  dispatcherReq.on('error', () => res.json({ error: '调度器未运行' }));
  dispatcherReq.on('timeout', () => { dispatcherReq.destroy(); res.json({ error: '调度器超时' }); });
});

// ── GET /api/dispatcher/details ───────────────────────
// 队列明细 + 活跃任务明细
app.get('/api/dispatcher/details', (req, res) => {
  const http = require('http');
  const dispatcherReq = http.get('http://127.0.0.1:3102/details', { timeout: 5000 }, (dispatcherRes) => {
    let data = '';
    dispatcherRes.on('data', c => data += c);
    dispatcherRes.on('end', () => {
      try { res.json(JSON.parse(data)); } catch (e) { res.json({ error: 'parse error' }); }
    });
  });
  dispatcherReq.on('error', () => res.json({ error: '调度器未运行' }));
  dispatcherReq.on('timeout', () => { dispatcherReq.destroy(); res.json({ error: '调度器超时' }); });
});

// ── GET /api/dispatcher/forecast ───────────────────────
// 24h 载荷预测热力图数据
app.get('/api/dispatcher/forecast', (req, res) => {
  const http = require('http');
  const dispatcherReq = http.get('http://127.0.0.1:3102/forecast', { timeout: 5000 }, (dispatcherRes) => {
    let data = '';
    dispatcherRes.on('data', c => data += c);
    dispatcherRes.on('end', () => {
      try { res.json(JSON.parse(data)); } catch (e) { res.json({ error: 'parse error' }); }
    });
  });
  dispatcherReq.on('error', () => res.json({ error: '调度器未运行' }));
  dispatcherReq.on('timeout', () => { dispatcherReq.destroy(); res.json({ error: '调度器超时' }); });
});

// ── GET /api/dispatcher/config ─────────────────────────
// 读取调度器配置文件
app.get('/api/dispatcher/config', (req, res) => {
  try {
    const cfgPath = path.join(BASE_DIR, 'data', 'cron-dispatcher-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/dispatcher/config ─────────────────────────
// 更新调度器配置并热重载
app.put('/api/dispatcher/config', (req, res) => {
  try {
    const body = req.body;
    const cfgPath = path.join(BASE_DIR, 'data', 'cron-dispatcher-config.json');
    const old = fs.readFileSync(cfgPath, 'utf8');
    fs.writeFileSync(cfgPath + '.bak', old, 'utf8'); // 备份
    fs.writeFileSync(cfgPath, JSON.stringify(body, null, 4), 'utf8');
    // 通知调度器热重载
    try {
      const http = require('http');
      const reloadReq = http.request('http://127.0.0.1:3102/reload', { method: 'POST', timeout: 3000 });
      reloadReq.on('error', () => {});
      reloadReq.end();
    } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/available-models ──────────────────────────
// 列出 openclaw 中已注册的所有模型
app.get('/api/available-models', (req, res) => {
  try {
    const ocPath = path.join(process.env.HOME || '/home/administrator', '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
    const models = [];
    const seen = new Set();
    const providers = cfg.models?.providers || {};
    for (const [providerId, provider] of Object.entries(providers)) {
      for (const m of (provider.models || [])) {
        const fullId = `${providerId}/${m.id}`;
        if (seen.has(fullId)) continue;
        seen.add(fullId);
        models.push({
          id: fullId,
          provider: providerId,
          modelId: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow || 0,
          maxTokens: m.maxTokens || 0,
        });
      }
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/dispatcher/logs ────────────────────────────
// 调度器最近日志
app.get('/api/dispatcher/logs', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 50;
    const logFile = path.join(BASE_DIR, 'logs', 'cron-dispatcher.log');
    if (!fs.existsSync(logFile)) return res.json({ lines: [] });

    const tail = safeExec(`tail -n ${lines} "${logFile}"`, { timeout: 3000 });
    const parsed = tail.trim().split('\n').filter(Boolean).map(line => {
      // 格式: [2026-05-26T13:21:04] [ENQUEUE] med-2 | ARKM | scanner | ...
      const match = line.match(/^\[([^\]]+)\]\s+\[(\w+)\]\s+(.+)$/);
      if (!match) return { raw: line.substring(0, 200) };
      return { time: match[1], level: match[2], msg: match[3].substring(0, 200) };
    }).slice(-50); // 最近 50 条
    res.json({ lines: parsed });
  } catch (e) {
    res.json({ lines: [], error: e.message });
  }
});

// ── GET /api/gateway/status ───────────────────────────
// 轻量端点：ps + free，< 10ms，供前端秒级轮询
app.get('/api/gateway/status', (req, res) => {
  try {
    const data = {};
    const gwPid = safeExec("pgrep -f 'openclaw.*gateway' | head -1", { timeout: 3000 })?.trim();
    if (gwPid) {
      const psOut = safeExec(`ps -p ${gwPid} -o rss=,pcpu=,etime= --no-headers`, { timeout: 3000 });
      if (psOut) {
        const parts = psOut.trim().split(/\s+/);
        data.pid = parseInt(gwPid);
        data.rssMb = Math.round(parseInt(parts[0]) / 1024);
        data.cpu = parseFloat(parts[1]);
        data.uptime = parts[2]?.trim();
      }
      // 峰值 RSS (VmHWM) — 从 /proc/PID/status 读，看是否逼近过 OOM
      try {
        const status = require('fs').readFileSync(`/proc/${gwPid}/status`, 'utf8');
        const hwmMatch = status.match(/VmHWM:\s+(\d+)\s+kB/);
        if (hwmMatch) data.peakRssMb = Math.round(parseInt(hwmMatch[1]) / 1024);
      } catch {}
    }
    // OOM 崩溃检测：PID 变化 = 进程重启过（OOM 或其他原因）
    try {
      const trackFile = path.join(BASE_DIR, 'data', 'gw-oom-track.json');
      let track = { pid: 0, count: 0, history: [] };
      try { if (fs.existsSync(trackFile)) track = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {}
      if (data.pid && track.pid && data.pid !== track.pid) {
        track.count++;
        track.history.push({ at: new Date().toISOString(), oldPid: track.pid, newPid: data.pid });
        if (track.history.length > 20) track.history = track.history.slice(-20);
      }
      track.pid = data.pid || track.pid;
      try { fs.writeFileSync(trackFile, JSON.stringify(track), 'utf8'); } catch {}
      data.oomCount = track.count;
      data.oomHistory = track.history.slice(-5);
    } catch { data.oomCount = -1; }
    const freeOut = safeExec('free -h', { timeout: 3000 });
    if (freeOut) {
      const memLine = freeOut.split('\n')[1]?.split(/\s+/);
      const swapLine = freeOut.split('\n')[2]?.split(/\s+/);
      if (memLine) data.sysMem = { total: memLine[1], used: memLine[2], free: memLine[3], avail: memLine[6] };
      if (swapLine) data.swap = { total: swapLine[1], used: swapLine[2] };
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/system ───────────────────────────────────
app.get('/api/system', (req, res) => {
  try {
    // PM2 状态
    let pm2Status = [];
    const pm2Out = safeExec('pm2 jlist 2>/dev/null', { timeout: 5000 });
    if (pm2Out) {
      try {
        const pm2List = JSON.parse(pm2Out);
        pm2Status = pm2List.map(p => ({
          name: p.name,
          status: p.pm2_env?.status,
          cpu: p.monit?.cpu,
          memory: Math.round((p.monit?.memory || 0) / 1024 / 1024),
          uptime: p.pm2_env?.pm_uptime,
          restarts: p.pm2_env?.restart_time,
        }));
      } catch {}
    }

    // 健康报告列表
    const healthFiles = listFiles(HEALTH_DIR)
      .filter(f => f.endsWith('-cycle-health.md'))
      .sort().reverse()
      .slice(0, 10);

    // 最新健康报告内容摘要
    let healthSummary = null;
    if (healthFiles.length > 0) {
      const latestPath = path.join(HEALTH_DIR, healthFiles[0]);
      const content = fs.readFileSync(latestPath, 'utf8');
      // 提取统计段落
      const summaryMatch = content.match(/## 四、统计汇总[\s\S]+?(?=---|\n##|$)/);
      healthSummary = {
        date: healthFiles[0].replace('-cycle-health.md', ''),
        summary: summaryMatch?.[0]?.trim() || '暂无摘要',
      };
    }

    // actions.log
    const actionsLog = (() => {
      const p = path.join(HEALTH_DIR, 'actions.log');
      if (!fs.existsSync(p)) return [];
      const raw = safeExec(`tail -20 "${p}"`);
      return raw ? raw.trim().split('\n').filter(Boolean) : [];
    })();

    // 磁盘使用
    let disk = {};
    const df = safeExec('df -h /home/administrator/.openclaw/july-btc-analyzer', { timeout: 5000 });
    if (df) {
      const parts = df.split('\n')[1]?.split(/\s+/);
      if (parts) disk = { size: parts[1], used: parts[2], avail: parts[3], usePct: parts[4] };
    }

    // 活跃规则计数: 用 getRules() 解析元数据中的 status，不数文件（文件数 ≠ 活跃规则数）
    let activeRuleCount = 0;
    let archivedRuleCount = 0;
    try {
      const allRules = getRules({ all: true });
      if (Array.isArray(allRules)) {
        activeRuleCount = allRules.filter(r => r.status === 'active').length;
        archivedRuleCount = allRules.filter(r => r.status === 'archived').length;
      }
    } catch {
      // fallback: 数文件（不精确）
      activeRuleCount = listFiles(RULES_DIR).filter(f => f.endsWith('.js')).length;
    }

    // ── 周期统计 ──
    const activeBtcCycles = listDirs(ACTIVE_DIR).filter(d => d.startsWith('cycle-')).length;
    const activeAltCycles = listDirs(ACTIVE_DIR).filter(d => d.startsWith('alt-')).length;
    const activeZhuangCycles = listDirs(ACTIVE_DIR).filter(d => d.startsWith('zhuang-')).length;
    const archivedBtcCycles = listDirs(ARCHIVED_DIR).filter(d => d.startsWith('cycle-')).length;
    const archivedAltCycles = listDirs(ARCHIVED_DIR).filter(d => d.startsWith('alt-')).length;
    const archivedZhuangCycles = listDirs(ARCHIVED_DIR).filter(d => d.startsWith('zhuang-')).length;

    // ── 文件统计 ──
    const logFiles = listFiles(LOGS_DIR).filter(f => f.endsWith('.log')).length;
    const dataFiles = listFiles(DATA_DIR).filter(f => f.endsWith('.json') || f.endsWith('.csv')).length;
    const learningFiles = listFiles(path.join(BASE_DIR, 'learnings')).filter(f => f.endsWith('.md')).length;

    // ── 周期创建时间线（用于图表） ──
    function buildCycleTimeline(dir, prefix) {
      const entries = listDirs(dir).filter(d => d.startsWith(prefix));
      const byDate = {};
      for (const entry of entries) {
        // 格式: cycle-YYYYMMDD-NNN 或 alt-COIN-YYYYMMDD-HHMM
        const match = entry.match(/-(\d{8})/);
        if (match) {
          const dateKey = match[1]; // YYYYMMDD
          byDate[dateKey] = (byDate[dateKey] || 0) + 1;
        }
      }
      return byDate;
    }

    // ── 日内按小时时间线（用于「日内」视图） ──
    function buildCycleHourly() {
      const today = new Date();
      const todayStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
      const byHour = {};
      for (let h = 0; h < 24; h++) {
        byHour[String(h).padStart(2, '0')] = { active: 0, archived: 0, total: 0 };
      }
      for (const dir of [ACTIVE_DIR, ARCHIVED_DIR]) {
        const entries = listDirs(dir);
        for (const entry of entries) {
          // alt-COIN-YYYYMMDD-HHMM 或 zhuang-COIN-YYYYMMDD-HHMM
          const altMatch = entry.match(/^(?:alt|zhuang)-.+-(\d{8})-(\d{2})\d{2}$/);
          if (altMatch && altMatch[1] === todayStr) {
            const hour = altMatch[2];
            const type = dir === ACTIVE_DIR ? 'active' : 'archived';
            byHour[hour][type]++;
            byHour[hour].total++;
            continue;
          }
          // cycle-YYYYMMDD-NNN
          const btcMatch = entry.match(/^cycle-(\d{8})-/);
          if (btcMatch && btcMatch[1] === todayStr) {
            try {
              const stat = fs.statSync(path.join(dir, entry));
              const hour = String(new Date(stat.mtime).getHours()).padStart(2, '0');
              const type = dir === ACTIVE_DIR ? 'active' : 'archived';
              byHour[hour][type]++;
              byHour[hour].total++;
            } catch {}
          }
        }
      }
      return Object.entries(byHour)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([hour, data]) => ({ hour, ...data }));
    }

    // 合并活跃+归档的时间线
    const activeTimeline = buildCycleTimeline(ACTIVE_DIR, '');
    const archivedTimeline = buildCycleTimeline(ARCHIVED_DIR, '');
    const allDates = new Set([...Object.keys(activeTimeline), ...Object.keys(archivedTimeline)]);
    const cycleTimeline = [];
    for (const date of [...allDates].sort()) {
      cycleTimeline.push({
        date: `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`,
        active: activeTimeline[date] || 0,
        archived: archivedTimeline[date] || 0,
        total: (activeTimeline[date] || 0) + (archivedTimeline[date] || 0),
      });
    }

    const cycleHourly = buildCycleHourly();

    // ── 24h / 7d 增量 ──
    function sumTimelineDays(timeline, n, key) {
      return timeline.slice(-n).reduce((s, d) => s + (d[key] || 0), 0);
    }
    const delta24hActive = sumTimelineDays(cycleTimeline, 1, 'active');
    const delta7dActive = sumTimelineDays(cycleTimeline, 7, 'active');
    const delta24hArchived = sumTimelineDays(cycleTimeline, 1, 'archived');
    const delta7dArchived = sumTimelineDays(cycleTimeline, 7, 'archived');
    const delta24h = sumTimelineDays(cycleTimeline, 1, 'total');
    const delta7d = sumTimelineDays(cycleTimeline, 7, 'total');

    // 规则/日志/健康报告 近24h/7d（按文件 mtime）
    const nowMs = Date.now();
    const ms24h = 24 * 60 * 60 * 1000;
    const ms7d = 7 * 24 * 60 * 60 * 1000;
    function countByMtime(dir, ext) {
      try {
        const files = listFiles(dir).filter(f => f.endsWith(ext));
        const recent24h = files.filter(f => {
          const s = fs.statSync(path.join(dir, f));
          return nowMs - s.mtimeMs < ms24h;
        }).length;
        const recent7d = files.filter(f => {
          const s = fs.statSync(path.join(dir, f));
          return nowMs - s.mtimeMs < ms7d;
        }).length;
        return { recent24h, recent7d };
      } catch { return { recent24h: 0, recent7d: 0 }; }
    }
    const rulesDelta = countByMtime(RULES_DIR, '.js');
    const logsDelta = countByMtime(LOGS_DIR, '.log');
    const healthDelta = countByMtime(HEALTH_DIR, '.md');

    // ── Gateway 进程状态 ──
    let gateway = {};
    try {
      const gwPid = safeExec("pgrep -f 'openclaw.*gateway' | head -1", { timeout: 3000 })?.trim();
      if (gwPid) {
        const psOut = safeExec(`ps -p ${gwPid} -o rss=,pcpu=,etime= --no-headers`, { timeout: 3000 });
        if (psOut) {
          const parts = psOut.trim().split(/\s+/);
          gateway = {
            pid: parseInt(gwPid),
            rssMb: Math.round(parseInt(parts[0]) / 1024),
            cpu: parseFloat(parts[1]),
            uptime: parts[2]?.trim(),
          };
        }
      }
      // 系统内存
      const freeOut = safeExec('free -h', { timeout: 3000 });
      if (freeOut) {
        const memLine = freeOut.split('\n')[1]?.split(/\s+/);
        const swapLine = freeOut.split('\n')[2]?.split(/\s+/);
        if (memLine) gateway.sysMem = { total: memLine[1], used: memLine[2], free: memLine[3], avail: memLine[6] };
        if (swapLine) gateway.swap = { total: swapLine[1], used: swapLine[2] };
      }
      // cron.list 5分钟调用频率（从 journalctl 快速采样）
      try {
        const cnt = safeExec(`journalctl --user -u openclaw-gateway --since '5 min ago' --no-pager 2>&1 | grep -c 'cron.list'`, { timeout: 5000 })?.trim();
        gateway.cronList5min = parseInt(cnt) || 0;
      } catch { gateway.cronList5min = -1; }
    } catch {}

    res.json({
      pm2: pm2Status,
      healthReports: healthFiles,
      healthSummary,
      actionsLog,
      disk,
      rules: {
        active: activeRuleCount,
        archived: archivedRuleCount,
        totalFiles: listFiles(RULES_DIR).filter(f => f.endsWith('.js')).length,
        delta24h: rulesDelta.recent24h,
        delta7d: rulesDelta.recent7d,
      },
      cycles: {
        active: { btc: activeBtcCycles, alt: activeAltCycles, zhuang: activeZhuangCycles, total: activeBtcCycles + activeAltCycles + activeZhuangCycles },
        archived: { btc: archivedBtcCycles, alt: archivedAltCycles, zhuang: archivedZhuangCycles, total: archivedBtcCycles + archivedAltCycles + archivedZhuangCycles },
        timeline: cycleTimeline,
        hourly: cycleHourly,
        delta24h, delta7d,
        delta24hActive, delta7dActive,
        delta24hArchived, delta7dArchived,
      },
      gateway,
      files: {
        logs: logFiles,
        data: dataFiles,
        learnings: learningFiles,
        delta24h: logsDelta.recent24h,
        delta7d: logsDelta.recent7d,
        healthDelta24h: healthDelta.recent24h,
        healthDelta7d: healthDelta.recent7d,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/health/:date ────────────────────────────
app.get('/api/health/:date', (req, res) => {
  try {
    const date = req.params.date;
    const filePath = path.join(HEALTH_DIR, `${date}-cycle-health.md`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `健康报告 ${date} 不存在` });
    }
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ date, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/report ────────────────────────────────────
// 读取报告文件内容(必须在工作区目录下)
app.get('/api/report', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });

    // Safety: only allow files under BASE_DIR
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(BASE_DIR)) {
      return res.status(403).json({ error: '路径不在工作区内' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ path: resolved, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/logs/:name ──────────────────────────────────
app.get('/api/logs/:name', (req, res) => {
  try {
    const name = req.params.name.replace(/[^a-zA-Z0-9_.-]/g, '');
    const lines = parseInt(req.query.lines) || 100;
    const filePath = path.join(LOGS_DIR, name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `日志 ${name} 不存在` });
    }
    const raw = safeExec(`tail -${Math.min(lines, 500)} "${filePath}"`);
    res.json({ name, lines: lines, content: raw || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 系统 crontab 工具函数 ────────────────────────────
const PAUSED_PREFIX = '#PAUSED:';

function readCrontabLines() {
  const raw = safeExec('crontab -l 2>/dev/null');
  return raw ? raw.split('\n') : [];
}

function writeCrontabLines(lines) {
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const tmpFile = `/tmp/crontab-${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, content);
  execSync(`crontab "${tmpFile}"`, { encoding: 'utf8', timeout: 5000 });
  try { fs.unlinkSync(tmpFile); } catch {}
}

function parseCronLine(line) {
  return line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
}

function scheduleDesc(min, hour) {
  if (min === '*' && hour === '*') return '每分钟';
  if (min.startsWith('*/')) return `每${parseInt(min.slice(2))}分钟`;
  if (hour !== '*' && min !== '*') return `每天 ${String(parseInt(hour)).padStart(2,'0')}:${String(parseInt(min)).padStart(2,'0')}`;
  if (min === '0' && hour === '*') return '每小时整点';
  if (!isNaN(parseInt(min)) && hour === '*' && min.match(/^\d+$/)) return `每小时第${parseInt(min)}分钟`;
  if (min === '*' && hour.startsWith('*/')) return `每${parseInt(hour.slice(2))}小时整点`;
  return null;
}

function extractCmdBrief(command) {
  const sm = command.match(/scripts\/([^\s|]+)/);
  if (sm) return sm[1];
  return command.length > 60 ? command.slice(0, 57) + '...' : command;
}

function buildEntry(min, hour, dom, month, dow, command, status, comment) {
  const schedule = `${min} ${hour} ${dom} ${month} ${dow}`;
  return { schedule, scheduleDesc: scheduleDesc(min, hour) || schedule, command, cmdBrief: extractCmdBrief(command), status: status || 'active', comment: comment || null };
}

// ── GET /api/logs ────────────────────────────────────
app.get('/api/logs', (req, res) => {
  try {
    const files = listFiles(LOGS_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const fp = path.join(LOGS_DIR, f);
        let size = 0;
        try { size = fs.statSync(fp).size; } catch {}
        return { name: f, size, mtime: mtimeISO(fp) };
      })
      .sort((a, b) => (b.mtime || '') > (a.mtime || '') ? 1 : -1);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/trade-decisions ────────────────────────
// 开仓决策可视化：读取所有活跃周期的 trade-decision JSON
app.get('/api/trade-decisions', (req, res) => {
  try {
    const results = [];
    for (const location of ['active', 'archived']) {
      const locPath = path.join(BASE_DIR, location);
      if (!fs.existsSync(locPath)) continue;
      const cycleDirs = fs.readdirSync(locPath).filter(d => {
        try { return fs.statSync(path.join(locPath, d)).isDirectory(); } catch { return false; }
      });

      for (const cycleDir of cycleDirs) {
        const reportsDir = path.join(locPath, cycleDir, 'reports');
        if (!fs.existsSync(reportsDir)) continue;

        const cls = classifyCycle(cycleDir);
        const coin = cls.coin;

        const decisionFiles = fs.readdirSync(reportsDir)
          .filter(f => f.startsWith(`trade-decision-${coin}-`) && f.endsWith('.json'))
          .sort();

        // 读取该周期的 positions.json 判断决策是否已执行
        const posFile = path.join(locPath, cycleDir, 'positions.json');
        let cyclePositions = null;
        try { cyclePositions = JSON.parse(fs.readFileSync(posFile, 'utf8')); } catch {}

        for (const df of decisionFiles) {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(reportsDir, df), 'utf8'));
            // 从文件名提取时间: trade-decision-COIN-YYYY-MM-DD-HHMM.json
            const timeMatch = df.match(/trade-decision-\w+-(\d{4}-\d{2}-\d{2}-\d{4})\.json/);
            const fileTime = timeMatch ? timeMatch[1].replace(/-(\d{2})(\d{2})$/, ' $1:$2') : null;

            // 判断决策是否已执行：检查 positions.json 中是否有匹配的持仓
            let _executed = false;
            let _positionCount = 0;
            let _positionDirection = null;
            if (cyclePositions) {
              const holdings = cyclePositions['当前持仓'] || [];
              const matchingPositions = holdings.filter(p => {
                const posDirection = (p['持仓方向'] || '').toLowerCase();
                return posDirection === (content.direction || '').toLowerCase();
              });
              _executed = matchingPositions.length > 0;
              _positionCount = matchingPositions.length;
              if (_executed) {
                _positionDirection = content.direction;
              }
            }

            results.push({
              ...content,
              _cycleId: cycleDir,
              _location: location,
              _file: df,
              _fileTime: fileTime,
              _executed,
              _positionCount,
              _positionDirection,
            });
          } catch (e) {
            // skip malformed
          }
        }
      }
    }
    // 按文件时间倒序
    results.sort((a, b) => (b._fileTime || '').localeCompare(a._fileTime || ''));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/alert-price-visualization ────────────────
// 价格柱可视化：读取活跃价格警报规则的检查日志 + 价位配置
app.get('/api/alert-price-visualization', (req, res) => {
  try {
    const allRules = getRules({ all: true });
    const activePriceRules = allRules.filter(r => r.ruleType === 'price-levels' && r.status === 'active');

    const LOG_FILE = path.join(LOGS_DIR, 'btc-alert.log');
    function parseCheckLogs(coin, maxLines = 80) {
      if (!fs.existsSync(LOG_FILE)) return [];
      const raw = safeExec(`grep -aE '(OKX获取${coin} |进度] ${coin}-多价位监控)' "${LOG_FILE}" | grep '当前:' | tail -${maxLines}`);
      if (!raw) return [];
      return raw.trim().split('\n').filter(Boolean).map(line => {
        const ts = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)?.[1];
        const range = line.match(/区间:\s*\$?([\d.]+)-\$?([\d.]+)/);
        const current = line.match(/当前:\s*\$?([\d.]+)/);
        const triggered = line.includes('触发: true');
        return {
          time: ts,
          low: range ? parseFloat(range[1]) : null,
          high: range ? parseFloat(range[2]) : null,
          current: current ? parseFloat(current[1]) : null,
          triggered
        };
      }).filter(d => d.current !== null);
    }

    function parsePriceLevels(content) {
      const m = content.match(/const\s+PRICE_LEVELS\s*=\s*(\[[\s\S]*?\]);/);
      if (!m) return [];
      try {
        const levels = new Function(`return ${m[1]}`)();
        return levels.map(l => ({
          price: l.price,
          type: l.type,
          label: l.label,
          action: l.action,
          confirmPolicy: l.confirmPolicy,
          confirmMs: l.confirmMs
        }));
      } catch { return []; }
    }

    const results = [];
    for (const rule of activePriceRules) {
      const filePath = path.join(RULES_DIR, rule.file + '.js');
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const levels = parsePriceLevels(content);
      const checks = parseCheckLogs(rule.coin, 80);
      if (levels.length === 0) continue;

      const prices = checks.map(c => c.current).filter(p => p !== null);
      const lows = checks.map(c => c.low).filter(p => p !== null);
      const highs = checks.map(c => c.high).filter(p => p !== null);

      results.push({
        coin: rule.coin,
        name: rule.name,
        cycleId: rule.cycleId,
        priceLevels: levels,
        checks: checks.reverse(), // chronological
        stats: {
          earliestPrice: prices.length > 0 ? prices[0] : null,
          latestPrice: prices.length > 0 ? prices[prices.length - 1] : null,
          overallLow: lows.length > 0 ? Math.min(...lows) : null,
          overallHigh: highs.length > 0 ? Math.max(...highs) : null,
          checkCount: checks.length
        }
      });
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/self-heal ────────────────────────────────
// 自愈系统可视化: 解析 alert-selfheal.log, 按 AB/C 分类
app.get('/api/self-heal', (req, res) => {
  try {
    const logFile = path.join(LOGS_DIR, 'alert-selfheal.log');
    if (!fs.existsSync(logFile)) {
      return res.json({ exists: false, summary: {}, fixes: [], intervals: [], archive: [], timeline: [], coinDiags: [] });
    }

    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);

    // 解析所有条目
    const allEntries = [];
    let pendingMulti = null; // 多行 COIN_DIAG/SYSTEM_LESSON

    for (const line of lines) {
      // 匹配时间戳: [2026-05-23 14:54:00] 或 [2026-05-16 13:43 CST] 或 [2026-05-08 22:38 CST]
      // 统一标准化: 无秒补 :00
      let ts = '', tsMs = 0;
      const tsMatch1 = line.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
      const tsMatch2 = line.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})\s/);
      if (tsMatch1) {
        ts = tsMatch1[1].replace('T', ' ');
      } else if (tsMatch2) {
        ts = tsMatch2[1].replace('T', ' ') + ':00';
      }
      tsMs = ts ? new Date(ts.replace(' CST', '')).getTime() : 0;

      if (line.includes('INTERVAL_ADJUSTED')) {
        // C 类: interval 翻倍
        // 格式: INTERVAL_ADJUSTED | 规则: XXX | 文件: XXX | 原因: XXX | 新间隔: Nmin (原 Nmin)
        const ruleMatch = line.match(/规则:\s*([^|]+)/);
        const fileMatch = line.match(/文件:\s*([^|]+)/);
        const reasonMatch = line.match(/原因:\s*([^|]+)/);
        const intervalMatch = line.match(/新间隔:\s*([^|]+)\(/);
        const origIntervalMatch = line.match(/原\s*([^)]+min)\)/);
        allEntries.push({
          type: 'interval_adjust',
          ts, tsMs,
          rule: ruleMatch ? ruleMatch[1].trim() : '',
          file: fileMatch ? fileMatch[1].trim() : '',
          reason: reasonMatch ? reasonMatch[1].trim() : '',
          newInterval: intervalMatch ? intervalMatch[1].trim() : '',
          origInterval: origIntervalMatch ? origIntervalMatch[1].trim() : '',
        });
      } else if (line.includes('FIXED |')) {
        // A/B 类: 自愈修复 (包含类别行? 检查)
        const ruleMatch = line.match(/规则:\s*([^|]+)/);
        const fileMatch = line.match(/文件:\s*([^|]+)/);
        const problemMatch = line.match(/问题:\s*(.+?)(?:\s*\|\s*修复:|\s*\|\s*类别:|$)/);
        allEntries.push({
          type: 'fixed',
          ts, tsMs,
          rule: ruleMatch ? ruleMatch[1].trim() : '',
          file: fileMatch ? fileMatch[1].trim() : '',
          problem: problemMatch ? problemMatch[1].trim() : '',
        });
      } else if (line.includes('ARCHIVED |')) {
        const ruleMatch = line.match(/规则:\s*([^|]+)/);
        const fileMatch = line.match(/文件:\s*([^|]+)/);
        const catMatch = line.match(/类别:\s*([^|]+)/);
        const reasonMatch = line.match(/原因:\s*([^|]+)/);
        allEntries.push({
          type: 'archived',
          ts, tsMs,
          rule: ruleMatch ? ruleMatch[1].trim() : '',
          file: fileMatch ? fileMatch[1].trim() : '',
          category: catMatch ? catMatch[1].trim() : '',
          reason: reasonMatch ? reasonMatch[1].trim() : '',
        });
      } else if (line.includes('COIN_DIAG |')) {
        const coinMatch = line.match(/币种:\s*([^|]+)/);
        const fixedMatch = line.match(/修复:\s*(\d+)/);
        const problemMatch = line.match(/问题:\s*(.+)$/);
        allEntries.push({
          type: 'coin_diag',
          ts, tsMs,
          coin: coinMatch ? coinMatch[1].trim() : '',
          fixedCount: fixedMatch ? parseInt(fixedMatch[1]) : 0,
          problem: problemMatch ? problemMatch[1].trim() : '',
        });
      } else if (line.includes('SELFHEAL |')) {
        const ruleMatch = line.match(/规则:\s*([^|]+)/);
        const resultMatch = line.match(/结果:\s*([^|]+)/);
        const catMatch = line.match(/类别:\s*([^|]+)/);
        const intervalMatch = line.match(/新间隔:\s*([^|]+)/);
        allEntries.push({
          type: 'selfheal',
          ts, tsMs,
          rule: ruleMatch ? ruleMatch[1].trim() : '',
          result: resultMatch ? resultMatch[1].trim() : '',
          category: catMatch ? catMatch[1].trim() : '',
          newInterval: intervalMatch ? intervalMatch[1].trim() : '',
        });
      } else if (line.includes('ROOT_CAUSE_DIAG')) {
        const causeMatch = line.match(/根因:\s*(.+)$/);
        allEntries.push({
          type: 'root_cause',
          ts, tsMs,
          detail: causeMatch ? causeMatch[1].trim() : '',
        });
      } else if (line.includes('BULK_FIX |')) {
        const fixMatch = line.match(/修复:\s*(.+)$/);
        allEntries.push({
          type: 'bulk_fix',
          ts, tsMs,
          detail: fixMatch ? fixMatch[1].trim() : '',
        });
      } else if (line.includes('SYSTEM_LESSON')) {
        const lessonMatch = line.match(/^[^\]]+\]\s*SYSTEM_LESSON\s*\|?\s*(.+)$/);
        allEntries.push({
          type: 'system_lesson',
          ts, tsMs,
          detail: lessonMatch ? lessonMatch[1].trim() : '',
        });
      }
    }

    // 统计
    let fixCount = 0, intervalCount = 0, archiveCount = 0, coinDiagCount = 0;
    // 按日期聚合
    const byDate = {};
    for (const e of allEntries) {
      const day = e.ts.slice(0, 10);
      if (!byDate[day]) byDate[day] = { fixes: 0, intervals: 0, archives: 0, coinDiags: 0 };
      if (e.type === 'fixed') { fixCount++; byDate[day].fixes++; }
      else if (e.type === 'interval_adjust' || e.type === 'selfheal') { intervalCount++; byDate[day].intervals++; }
      else if (e.type === 'archived') { archiveCount++; byDate[day].archives++; }
      else if (e.type === 'coin_diag') { coinDiagCount++; byDate[day].coinDiags++; }
    }

    // 去重 + 按时间倒序
    const compare = (a, b) => b.ts.localeCompare(a.ts);

    // A/B 类修复: FIXED 条目 (去重: 同一规则+同一问题只保留最新一条)
    const fixMap = new Map();
    for (const e of allEntries.filter(e => e.type === 'fixed')) {
      const key = e.rule + '::' + (e.file || '');
      if (!fixMap.has(key) || e.ts > fixMap.get(key).ts) fixMap.set(key, e);
    }
    const fixes = Array.from(fixMap.values()).sort(compare);

    // C 类间隔调整: INTERVAL_ADJUSTED + SELFHEAL(interval_adjust)
    const intervalMap = new Map();
    for (const e of allEntries.filter(e => e.type === 'interval_adjust')) {
      const key = e.rule + '::' + e.ts.slice(0, 16);
      intervalMap.set(key, e);
    }
    for (const e of allEntries.filter(e => e.type === 'selfheal' && e.category?.startsWith('C'))) {
      const key = e.rule + '::' + e.ts.slice(0, 16);
      if (!intervalMap.has(key)) intervalMap.set(key, e);
    }
    const intervals = Array.from(intervalMap.values()).sort(compare);

    // 归档日志
    const archiveEntries = allEntries.filter(e => e.type === 'archived').sort(compare);

    // 逐日统计 (用于 timeline 展示)
    const dailyStats = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0])).map(([day, stats]) => ({
      date: day,
      ...stats
    }));

    // Coin diagnostics
    const coinDiags = allEntries.filter(e => e.type === 'coin_diag').sort(compare);

    // 逐小时统计 (近24小时,用于 24h 视图 X 轴以小时为单位)
    const nowMs = Date.now();
    const twentyFourHrAgo = nowMs - 24 * 3600000;
    const byHour = {};
    for (const e of allEntries) {
      if (e.tsMs < twentyFourHrAgo) continue;
      // 截取到小时: "2026-05-23 14"
      // 截取到小时: 从 "2026-05-23 14:54:00" 取前13字符 "2026-05-23 14"
      const hrKey = e.ts.slice(0, 13);
      if (!byHour[hrKey]) byHour[hrKey] = { fixes: 0, intervals: 0, archives: 0, coinDiags: 0 };
      if (e.type === 'fixed') byHour[hrKey].fixes++;
      else if (e.type === 'interval_adjust' || e.type === 'selfheal') byHour[hrKey].intervals++;
      else if (e.type === 'archived') byHour[hrKey].archives++;
      else if (e.type === 'coin_diag') byHour[hrKey].coinDiags++;
    }
    const hourlyStats = Object.entries(byHour)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, stats]) => ({ hour: hour + ':00', ...stats }));

    // 补全所有24小时（填充值为0的空小时）
    const todayStr = new Date().toISOString().slice(0, 10);
    const hourMap = {};
    for (const hs of hourlyStats) hourMap[hs.hour] = hs;
    const filledHourly = [];
    for (let h = 0; h < 24; h++) {
      const key = todayStr + ' ' + String(h).padStart(2, '0') + ':00';
      filledHourly.push(hourMap[key] || { hour: key, fixes: 0, intervals: 0, archives: 0, coinDiags: 0, restores: 0 });
    }
    // 覆盖
    hourlyStats.length = 0;
    hourlyStats.push(...filledHourly);

    // 15分钟粒度统计在后段 restoredRules 解析完成后处理

    // 规则恢复统计: 从 btc-alert.log 中解析 NETWORK_RESTORED 事件
    const alertLog = path.join(LOGS_DIR, 'btc-alert.log');
    let restoredCount = 0;
    let restoredRules = [];
    if (fs.existsSync(alertLog)) {
      const raw2 = safeExec(`grep -a 'NETWORK_RESTORED' "${alertLog}" | tail -100`);
      if (raw2) {
        const restoreLines = raw2.trim().split('\n').filter(Boolean);
        const seenRestore = new Set();
        for (const line of restoreLines) {
          // 格式: 2026-05-23T13:21:55: [...] [SAHARA-OI异常增长] NETWORK_RESTORED | {...}
          const tsR = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
          const ruleR = line.match(/\[([^\]]+)\]\s*NETWORK_RESTORED/);
          if (tsR && ruleR) {
            const key = ruleR[1].trim() + '::' + tsR[1].slice(0, 16);
            if (!seenRestore.has(key)) {
              seenRestore.add(key);
              restoredRules.push({
                ts: tsR[1],
                rule: ruleR[1].trim(),
              });
              restoredCount++;
            }
          }
        }
      }
    }
    restoredRules.sort((a, b) => b.ts.localeCompare(a.ts));

    // 将恢复事件也按天聚合加入 dailyStats
    const restoreByDay = {};
    const restoreByHour = {};
    for (const rr of restoredRules) {
      // ts 格式: 2026-05-23T15:42:53 → 取前10字符做天, 前13做小时
      // dailyStats 日期格式: "2026-05-23"，直接取前10位
      const day = rr.ts.slice(0, 10);
      // hourlyStats 的 hour 字段用 T 分隔，取前13位
      const hrKey = rr.ts.slice(0, 13);
      if (!restoreByDay[day]) restoreByDay[day] = 0;
      restoreByDay[day]++;
      // 只有近24小时
      if (new Date(rr.ts).getTime() >= twentyFourHrAgo) {
        if (!restoreByHour[hrKey]) restoreByHour[hrKey] = 0;
        restoreByHour[hrKey]++;
      }
    }
    // 合并到 dailyStats
    for (const ds of dailyStats) {
      ds.restores = restoreByDay[ds.date] || 0;
    }
    // 合并到 hourlyStats: 先合并已有的，再补全只有恢复没有自愈事件的小时
    const hrMap = {};
    for (const hs of hourlyStats) {
      hrMap[hs.hour] = hs;
      const key = hs.hour.replace(' ', 'T').replace(':00', '').slice(0, 13);
      hs.restores = restoreByHour[key] || 0;
    }
    // 补充只有恢复事件的小时
    for (const [hrKey, rc] of Object.entries(restoreByHour)) {
      // hrKey 格式: "2026-05-23T13"，转成 "2026-05-23 13:00"
      const hourStr = hrKey.replace('T', ' ') + ':00';
      if (!hrMap[hourStr]) {
        hrMap[hourStr] = { hour: hourStr, fixes: 0, intervals: 0, archives: 0, coinDiags: 0, restores: rc };
      }
    }
    // 重写 hourlyStats，按时间排序
    const finalHourly = Object.values(hrMap).sort((a, b) => a.hour.localeCompare(b.hour));
    hourlyStats.length = 0;
    hourlyStats.push(...finalHourly);

    // 合并恢复事件到 15 分钟桶
    const threeHrAgo = new Date(Date.now() - 3 * 3600000);
    const qhSelfHeal = [];
    const qhBuckets = {};
    // 自愈事件入 15 分钟桶
    for (const e of allEntries) {
      if (e.tsMs < threeHrAgo.getTime()) continue;
      const m = parseInt(e.ts.slice(14, 16)) || 0;
      const qh = Math.floor(isNaN(m) ? 0 : m / 15) * 15;
      const key15 = e.ts.slice(0, 14) + String(qh).padStart(2, '0') + ':00';
      if (!qhBuckets[key15]) qhBuckets[key15] = { time: key15, fixes: 0, intervals: 0, archives: 0, coinDiags: 0, restores: 0 };
      if (e.type === 'fixed') qhBuckets[key15].fixes++;
      else if (e.type === 'interval_adjust' || e.type === 'selfheal') qhBuckets[key15].intervals++;
      else if (e.type === 'archived') qhBuckets[key15].archives++;
      else if (e.type === 'coin_diag') qhBuckets[key15].coinDiags++;
    }
    // 恢复事件入 15 分钟桶
    for (const rr of restoredRules) {
      if (new Date(rr.ts).getTime() < threeHrAgo.getTime()) continue;
      const m = rr.ts.length >= 16 ? parseInt(rr.ts.slice(14, 16)) : 0;
      const qh = Math.floor(isNaN(m) ? 0 : m / 15) * 15;
      const dayHr = rr.ts.slice(0, 10) + ' ' + rr.ts.slice(11, 13);
      const key15r = dayHr + ':' + String(qh).padStart(2, '0') + ':00';
      if (!qhBuckets[key15r]) qhBuckets[key15r] = { time: key15r, fixes: 0, intervals: 0, archives: 0, coinDiags: 0, restores: 0 };
      qhBuckets[key15r].restores++;
    }
    // 补齐最近 3 小时的 12 个 15 分钟桶（填 0）
    const nowHr = new Date();
    nowHr.setMinutes(Math.floor(nowHr.getMinutes() / 15) * 15, 0, 0);
    for (let i = 0; i < 12; i++) {
      const ts = new Date(nowHr.getTime() - (11 - i) * 15 * 60 * 1000);
      const key = ts.toISOString().slice(0, 10) + ' ' + String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0') + ':00';
      if (!qhBuckets[key]) qhBuckets[key] = { time: key, fixes: 0, intervals: 0, archives: 0, coinDiags: 0, restores: 0 };
      qhSelfHeal.push(qhBuckets[key]);
    }

    res.json({
      exists: true,
      totalEntries: allEntries.length,
      lastUpdated: mtimeISO(logFile),
      restoredSummary: {
        count: restoredCount,
      },
      summary: {
        fixes: fixes.length,
        intervals: intervals.length,
        archives: archiveEntries.length,
        coinDiags: coinDiags.length,
      },
      daily: dailyStats,
      hourly: hourlyStats,
      quarterHourly: qhSelfHeal,
      fixes,
      intervals,
      archives: archiveEntries,
      coinDiags,
      restoredRules,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/alert-activity ───────────────────────────
// 警报规则动作统计: 从 btc-alert.log + 归档日志解析 CHECK_START/TRIGGERED/等事件
app.get('/api/alert-activity', (req, res) => {
  try {
    const logFile = path.join(LOGS_DIR, 'btc-alert.log');
    const historyDir = path.join(LOGS_DIR, 'alert-history');
    const todayStr = new Date().toISOString().slice(0, 10);

    // ── 收集需要读取的日志文件（当天 + 近7天归档） ──
    function collectLogFiles() {
      const files = [];
      if (fs.existsSync(logFile)) files.push(logFile);
      // 用本地日期收集近7天归档
      const now = new Date();
      for (let ago = 1; ago < 8; ago++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
        const dayStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        try {
          for (const entry of fs.readdirSync(historyDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const f = path.join(historyDir, entry.name, dayStr + '.log');
            if (fs.existsSync(f)) { files.push(f); break; }
          }
        } catch {}
      }
      return files;
    }

    const logFiles = collectLogFiles();
    const filesArg = logFiles.map(f => `"${f}"`).join(' ');
    const allFilesExist = logFiles.length > 0;
    if (!allFilesExist) {
      return res.json({ exists: false, summary: {}, daily: [], hourly: [] });
    }

    // 用 grep 快速统计各事件类型总数
    function countEvent(pattern) {
      let total = 0;
      for (const f of logFiles) {
        const raw = safeExec(`grep -achF '${pattern}' "${f}" 2>/dev/null || true`);
        if (raw) total += parseInt(raw.trim()) || 0;
      }
      return total;
    }

    const eventPatterns = [
      'CHECK_START', 'TIMER_STARTED', 'TRIGGERED |', 'TRIGGER_COMPLETED',
      'DATA_COLLECTED', 'RULE_UNLOADED', 'RULE_RELOADED', 'RULE_ARCHIVED',
      'NETWORK_ADJUSTED', 'NETWORK_RESTORED', 'SELF_HEAL_TRIGGERED',
      'SELF_HEAL_SPAWNED', 'SUMMARY_SENT'
    ];

    const totals = {};
    for (const p of eventPatterns) {
      totals[p] = countEvent(p);
    }

    // ── 近24小时逐小时统计（awk 临时脚本，避免 buffer/shell 转义） ──
    const byHour = {};
    const now = new Date();

    const awkScript = `/tmp/alert-activity-${Date.now()}.awk`;
    fs.writeFileSync(awkScript, `BEGIN { FS="[T:]" }
{
  d=$1; h=$2;
  if (d !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) next;
  ts = d " " sprintf("%02d", h) ":00";
  c[ts]++;
  if (/CHECK_START/) ck[ts]++;
  if (/TRIGGERED \\|/) tr[ts]++;
  if (/NETWORK_ADJUSTED/) ad[ts]++;
  if (/NETWORK_RESTORED/) rs[ts]++;
  if (/RULE_ARCHIVED/) ar[ts]++;
  if (/RULE_RELOADED/) rl[ts]++;
  if (/RULE_UNLOADED/) ul[ts]++;
  if (/\\[ERROR\\]/) er[ts]++;
  if (/\\[WARN\\]/) wa[ts]++;
}
END {
  for (ts in c) printf "%s|%d|%d|%d|%d|%d|%d|%d|%d|%d\\n", ts, ck[ts]+0, tr[ts]+0, er[ts]+0, wa[ts]+0, ad[ts]+0, rs[ts]+0, ar[ts]+0, rl[ts]+0, ul[ts]+0;
}
`);
    const awkHourly = safeExec(`awk -f "${awkScript}" ${filesArg}`, { maxBuffer: 10 * 1024 * 1024 });
    try { fs.unlinkSync(awkScript); } catch {}
    if (awkHourly) {
      for (const line of awkHourly.trim().split('\n').filter(Boolean)) {
        const parts = line.split('|');
        if (parts.length < 10) continue;
        const hour = parts[0];
        // 过滤：只保留近24小时（用本地时间比较）
        const hourDate = new Date(hour + ':00');
        const twentyFourHrAgoLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 24, now.getMinutes());
        if (isNaN(hourDate.getTime()) || hourDate < twentyFourHrAgoLocal) continue;
        byHour[hour] = {
          checks: parseInt(parts[1]) || 0,
          triggers: parseInt(parts[2]) || 0,
          errors: parseInt(parts[3]) || 0,
          warnings: parseInt(parts[4]) || 0,
          adjust: parseInt(parts[5]) || 0,
          restore: parseInt(parts[6]) || 0,
          archive: parseInt(parts[7]) || 0,
          reload: parseInt(parts[8]) || 0,
          unload: parseInt(parts[9]) || 0,
        };
      }
    }

    // ── 按天统计（搜索所有日志文件含归档） ──
    const byDay = {};
    for (let ago = 0; ago < 7; ago++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
      const dayStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      byDay[dayStr] = { checks:0, triggers:0, errors:0, warnings:0, adjust:0, restore:0, archive:0, reload:0, unload:0 };

      function dayCount(pattern) {
        // escape regex meta chars for grep (brackets, pipes)
        const safe = pattern.replace(/[\[\]|\\]/g, '\\$&');
        let total = 0;
        for (const f of logFiles) {
          const raw = safeExec(`grep -ach "^${dayStr}T.*${safe}" "${f}" 2>/dev/null || true`);
          if (raw) total += parseInt(raw.trim()) || 0;
        }
        return total;
      }
      byDay[dayStr].checks = dayCount('CHECK_START');
      byDay[dayStr].triggers = dayCount('TRIGGERED ');
      byDay[dayStr].adjust = dayCount('NETWORK_ADJUSTED');
      byDay[dayStr].restore = dayCount('NETWORK_RESTORED');
      byDay[dayStr].archive = dayCount('RULE_ARCHIVED');
      byDay[dayStr].reload = dayCount('RULE_RELOADED');
      byDay[dayStr].unload = dayCount('RULE_UNLOADED');
      // ERROR 和 WARN 有 [ERROR] / [WARN] 标记
      byDay[dayStr].errors = dayCount('\\[ERROR\\]');
      byDay[dayStr].warnings = dayCount('\\[WARN\\]');
    }

    // 合并近7天的按天统计 (不限于有 CHECK_START 的天)
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const dayStr = d.toISOString().slice(0, 10);
      if (!byDay[dayStr]) byDay[dayStr] = { checks: 0, triggers: 0, errors: 0, warnings: 0, adjust: 0, restore: 0, archive: 0, reload: 0, unload: 0 };
    }

    const dailyStats = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([date, stats]) => ({ date, ...stats }));
    const hourlyStats = Object.entries(byHour).sort((a, b) => a[0].localeCompare(b[0])).map(([hour, stats]) => ({ hour, ...stats }));

    // 15 分钟粒度统计（近 3 小时，共 12 个桶）
    // awk: 每行的 ts 如 "2026-05-23T17:51:20"，取 hh:mm 并 floor minute 到 0/15/30/45
    const threeHrAgo = new Date(Date.now() - 3 * 3600000);
    const threeHrStr = threeHrAgo.toISOString().slice(0, 16); // "2026-05-23T14"
    const quarterHourly = [];
    const qhRaw = safeExec(`awk -F'[T:]' '/^${todayStr}T/{
      h=\$2; m=int(\$3/15)*15;
      key = sprintf(\"%02d:%02d\", h, m);
      c[key]++;
      if(/CHECK_START/) ck[key]++;
      if(/TRIGGERED /) tr[key]++;
      if(/NETWORK_ADJUSTED/) ad[key]++;
      if(/NETWORK_RESTORED/) rs[key]++;
    } END {
      for(k in c) printf \"%s|%d|%d|%d|%d\\n\", k, ck[k]+0, tr[k]+0, ad[k]+0, rs[k]+0;
    }' "${logFile}"`);
    if (qhRaw) {
      const qhMap = {};
      for (const line of qhRaw.trim().split('\n').filter(Boolean)) {
        const p = line.split('|');
        if (p.length < 5) continue;
        // key 格式 "17:45"，转为完整时间戳
        const key = todayStr + ' ' + p[0] + ':00';
        if (!qhMap[p[0]]) qhMap[p[0]] = {
          time: key,
          checks: parseInt(p[1]) || 0,
          triggers: parseInt(p[2]) || 0,
          adjust: parseInt(p[3]) || 0,
          restore: parseInt(p[4]) || 0,
        };
      }
      // 按 time 排序
      const qhKeys = Object.keys(qhMap).sort();
      // 只保留最近 12 个桶（3 小时）
      const lastBins = qhKeys.slice(-12);
      for (const k of lastBins) {
        quarterHourly.push(qhMap[k]);
      }
    }

    res.json({
      exists: true,
      lastUpdated: mtimeISO(logFile),
      totals,
      summary: {
        checks: totals['CHECK_START'] || 0,
        triggers: totals['TRIGGERED |'] || 0,
        adjust: totals['NETWORK_ADJUSTED'] || 0,
        restore: totals['NETWORK_RESTORED'] || 0,
        unloads: totals['RULE_UNLOADED'] || 0,
        archives: totals['RULE_ARCHIVED'] || 0,
        reloads: totals['RULE_RELOADED'] || 0,
      },
      daily: dailyStats,
      hourly: hourlyStats,
      quarterHourly,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 开发者卡片（Kanban） ──────────────────────────────
const DEV_CARDS_FILE = path.join(BASE_DIR, 'data', 'dev-cards.json');

function readDevCards() {
  if (!fs.existsSync(DEV_CARDS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(DEV_CARDS_FILE, 'utf8'));
    return Array.isArray(data.cards) ? data.cards : [];
  } catch { return []; }
}

function writeDevCards(cards) {
  const dir = path.dirname(DEV_CARDS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DEV_CARDS_FILE, JSON.stringify({ cards }, null, 2), 'utf8');
}

// GET /api/dev-cards — 列出所有卡片
app.get('/api/dev-cards', (req, res) => {
  try {
    const cards = readDevCards();
    res.json({ cards, count: cards.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/dev-cards — 新建卡片
app.post('/api/dev-cards', (req, res) => {
  try {
    const { text } = req.body;
    const cards = readDevCards();
    const card = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      text: text || '新任务',
      status: 'todo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    cards.push(card);
    writeDevCards(cards);
    console.log(`[dev-cards] 新建卡片: ${card.id}`);
    res.json({ ok: true, card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/dev-cards/:id — 更新卡片
app.put('/api/dev-cards/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { text, status } = req.body;
    const cards = readDevCards();
    const idx = cards.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: '卡片不存在' });
    if (text !== undefined) cards[idx].text = text;
    if (status !== undefined) cards[idx].status = status;
    cards[idx].updatedAt = new Date().toISOString();
    writeDevCards(cards);
    console.log(`[dev-cards] 更新卡片: ${id}`);
    res.json({ ok: true, card: cards[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/dev-cards/:id — 删除卡片
app.delete('/api/dev-cards/:id', (req, res) => {
  try {
    const { id } = req.params;
    let cards = readDevCards();
    const idx = cards.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: '卡片不存在' });
    cards.splice(idx, 1);
    writeDevCards(cards);
    console.log(`[dev-cards] 删除卡片: ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SPA fallback ──────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── Cron 名字缓存（后台定时更新，不依赖网页访问） ────
function updateCronNameCache() {
  const nameCacheFile = path.join(require('os').homedir(), '.openclaw', 'cron', 'job-names.json');
  const nameMap = {};
  try {
    if (fs.existsSync(nameCacheFile)) {
      Object.assign(nameMap, JSON.parse(fs.readFileSync(nameCacheFile, 'utf8')));
    }
  } catch {}
  try {
    const jobsRaw = safeExec('openclaw cron list --json 2>&1');
    if (jobsRaw) {
      const jd = JSON.parse(jobsRaw);
      for (const j of (jd.jobs || [])) {
        if (j.name) nameMap[j.id] = j.name;
      }
    }
  } catch {}
  try { fs.writeFileSync(nameCacheFile, JSON.stringify(nameMap), 'utf8'); } catch {}
  return nameMap;
}

// ── 启动 ──────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`📈 七月 BTC 监控面板已启动: http://0.0.0.0:${PORT}`);
  console.log(`   工作目录: ${BASE_DIR}`);

  // 后台定时更新 cron 名字缓存（每 60s），确保即时分析 job 在删除前被缓存
  updateCronNameCache();
  setInterval(updateCronNameCache, 60000);
});
