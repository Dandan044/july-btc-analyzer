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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false, lastModified: false, setHeaders: (res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));

// ── 工具函数 ──────────────────────────────────────────

/** 安全 execSync,出错返回空 */
function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 25000, ...opts });
  } catch (e) {
    console.error(`[exec error] ${cmd.split(' ').slice(0, 3).join(' ')}: ${e.message.slice(0, 100)}`);
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
    const isBTC = name.startsWith('cycle-');
    const coin = isBTC ? 'BTC' : (name.match(/^alt-([A-Z0-9]+)-/) || [])[1] || 'UNKNOWN';

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
      type: isBTC ? 'btc' : 'altcoin',
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
const SETTINGS_FILE = path.join(BASE_DIR, 'data', 'dashboard-settings.json');

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return { scannerLimit: 45 };
}

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
    const { scannerLimit } = req.body;
    if (scannerLimit !== undefined) {
      const v = parseInt(scannerLimit);
      if (isNaN(v) || v < 1) return res.status(400).json({ ok: false, error: 'invalid scannerLimit' });
      settings.scannerLimit = v;
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

// ── GET /api/dashboard ────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  try {
    const cycles = scanCycles('active');
    const allRules = getRules({ all: true });
    const rulesByCycleMap = rulesByCycle(allRules, cycles);

    // 引擎状态
    let engineStatus = 'unknown';
    try {
      const pm2Out = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
      const pm2List = JSON.parse(pm2Out);
      const btcAlert = pm2List.find(p => p.name === 'btc-alert');
      engineStatus = btcAlert?.pm2_env?.status === 'online' ? 'online' : 'offline';
    } catch {}

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
        activeCycles: { btc: btcCycles.length, altcoin: altCycles.length, total: cycles.length },
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

    // 排序:BTC 优先,然后按最后报告时间倒序
    cycles.sort((a, b) => {
      if (a.type === 'btc' && b.type !== 'btc') return -1;
      if (a.type !== 'btc' && b.type === 'btc') return 1;
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

    const isBTC = cycleId.startsWith('cycle-');
    const coin = isBTC ? 'BTC' : (cycleId.match(/^alt-([A-Z0-9]+)-/) || [])[1] || 'UNKNOWN';
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
      type: isBTC ? 'btc' : 'altcoin',
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

// ── GET /api/cycles/:id/logs ─────────────────────
app.get('/api/cycles/:id/logs', (req, res) => {
  try {
    const cycleId = req.params.id;
    const isBTC = cycleId.startsWith('cycle-');
    const coin = isBTC ? 'BTC' : (cycleId.match(/^alt-([A-Z0-9]+)-/) || [])[1];
    const lines = parseInt(req.query.lines) || 200;

    // 根据周期类型确定日志文件
    let logFileName;
    if (isBTC) {
      logFileName = 'daily-report-process.log';
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
    const isBTC = cycleId.startsWith('cycle-');
    const coin = isBTC ? 'BTC' : (cycleId.match(/^alt-([A-Z0-9]+)-/) || [])[1];

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

// ── POST /api/cycles/:id/analyze ─────────────────────
app.post('/api/cycles/:id/analyze', async (req, res) => {
  try {
    const cycleId = req.params.id;
    const isBTC = cycleId.startsWith('cycle-');
    const coin = isBTC ? 'BTC' : (cycleId.match(/^alt-([A-Z0-9]+)-/) || [])[1] || 'UNKNOWN';

    const taskFile = isBTC ? 'tasks/instant-analysis-stage1.md' : 'tasks/alt-instant-stage1.md';
    const message = isBTC
      ? `BTC即时分析 - 周期: ${cycleId},请读取 ${taskFile} 开始分析。`
      : `山寨币即时分析 - 币种: ${coin},周期: ${cycleId},请读取 ${taskFile} 开始分析。`;

    // 通过 openclaw CLI 创建一次性 cron 任务
    const jobName = `dash-${coin}-${Date.now()}`;
    const at = new Date(Date.now() + 3000).toISOString();
    // 转义消息中的特殊字符
    const escapedMessage = message.replace(/'/g, "'\\''");

    const cmd = `openclaw cron add --name "${jobName}" --agent july --at "${at}" --message '${escapedMessage}' --no-deliver --json 2>&1`;
    const output = safeExec(cmd, { shell: '/bin/bash' });

    let jobId = null;
    if (output) {
      try { const parsed = JSON.parse(output); jobId = parsed.id || parsed.jobId; } catch {}
    }

    res.json({
      success: true,
      cycleId,
      coin,
      taskFile,
      jobName,
      jobId,
      output: output?.trim(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/analysis/jobs ────────────────────────────
app.get('/api/analysis/jobs', (req, res) => {
  try {
    // 获取所有 dashboard 创建的分析任务
    const listRaw = safeExec('openclaw cron list --json 2>&1');
    if (!listRaw) return res.json({ jobs: [] });

    let listData;
    try { listData = JSON.parse(listRaw); } catch { return res.json({ jobs: [] }); }

    const dashJobs = (listData.jobs || []).filter(j => (j.name || '').startsWith('dash-'));

    const jobs = dashJobs.map(j => {
      const state = j.state || {};
      let status = 'queued';
      if (state.runningAtMs) status = 'running';
      if (state.lastRunStatus) status = state.lastRunStatus; // 'ok' | 'error'

      // 检查是否有 runs(已完成的任务)
      let runResult = null;

      return {
        jobId: j.id,
        name: j.name,
        status,
        createdAt: j.createdAtMs,
        runningAt: state.runningAtMs,
        lastRunStatus: state.lastRunStatus,
        lastDurationMs: state.lastDurationMs,
        consecutiveErrors: state.consecutiveErrors,
        payload: j.payload,
        runResult,
      };
    });

    res.json({ jobs, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/analysis/:jobId ──────────────────────
app.delete('/api/analysis/:jobId', (req, res) => {
  try {
    const jobId = req.params.jobId;
    const output = safeExec(`openclaw cron rm "${jobId}" 2>&1`);
    res.json({ success: true, jobId, output: output?.trim() });
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
    const coin = cycleId.startsWith('cycle-') ? 'BTC' : (cycleId.match(/^alt-([A-Z0-9]+)-/) || [])[1] || 'UNKNOWN';
    const logFile = path.join(LOGS_DIR, `${coin === 'BTC' ? 'daily-report-process' : `alt-${coin}-process`}.log`);
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
app.get('/api/cron/jobs', (req, res) => {
  try {
    const raw = safeExec('openclaw cron list --json 2>&1');
    if (!raw) return res.json({ jobs: [] });
    const data = JSON.parse(raw);
    const jobs = (data.jobs || []).map(j => ({
      id: j.id,
      name: j.name,
      agentId: j.agentId,
      enabled: j.enabled,
      deleteAfterRun: j.deleteAfterRun,
      schedule: j.schedule,
      state: j.state || {},
      createdAtMs: j.createdAtMs,
      sessionTarget: j.sessionTarget,
    }));
    res.json({ jobs });
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

// ── GET /api/system ───────────────────────────────────
app.get('/api/system', (req, res) => {
  try {
    // PM2 状态
    let pm2Status = [];
    try {
      const pm2Out = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
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
    try {
      const df = execSync('df -h /home/administrator/.openclaw/july-btc-analyzer', { encoding: 'utf8' });
      const parts = df.split('\n')[1]?.split(/\s+/);
      if (parts) disk = { size: parts[1], used: parts[2], avail: parts[3], usePct: parts[4] };
    } catch {}

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
    const archivedBtcCycles = listDirs(ARCHIVED_DIR).filter(d => d.startsWith('cycle-')).length;
    const archivedAltCycles = listDirs(ARCHIVED_DIR).filter(d => d.startsWith('alt-')).length;

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
          // alt-COIN-YYYYMMDD-HHMM
          const altMatch = entry.match(/^alt-.+-(\d{8})-(\d{2})\d{2}$/);
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
        active: { btc: activeBtcCycles, alt: activeAltCycles, total: activeBtcCycles + activeAltCycles },
        archived: { btc: archivedBtcCycles, alt: archivedAltCycles, total: archivedBtcCycles + archivedAltCycles },
        timeline: cycleTimeline,
        hourly: cycleHourly,
        delta24h, delta7d,
        delta24hActive, delta7dActive,
        delta24hArchived, delta7dArchived,
      },
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

        const isBTC = cycleDir.startsWith('cycle-');
        const coin = isBTC ? 'BTC' : (cycleDir.match(/^alt-([A-Z0-9]+)-/) || [])[1] || 'UNKNOWN';

        const decisionFiles = fs.readdirSync(reportsDir)
          .filter(f => f.startsWith(`trade-decision-${coin}-`) && f.endsWith('.json'))
          .sort();

        for (const df of decisionFiles) {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(reportsDir, df), 'utf8'));
            // 从文件名提取时间: trade-decision-COIN-YYYY-MM-DD-HHMM.json
            const timeMatch = df.match(/trade-decision-\w+-(\d{4}-\d{2}-\d{2}-\d{4})\.json/);
            const fileTime = timeMatch ? timeMatch[1].replace(/-(\d{2})(\d{2})$/, ' $1:$2') : null;
            results.push({
              ...content,
              _cycleId: cycleDir,
              _location: location,
              _file: df,
              _fileTime: fileTime,
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
