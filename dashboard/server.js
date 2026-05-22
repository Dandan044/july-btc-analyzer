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
app.use(express.static(path.join(__dirname, 'public')));

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

    // 最近 6 小时触发的警报
    // ── 近 6h 警报（带持久缓存，日志归档不丢数据） ──
    let recentAlerts = [];
    try {
      // 1. 从缓存加载已有记录
      let cached = [];
      if (fs.existsSync(ALERTS_CACHE_FILE)) {
        try { cached = JSON.parse(fs.readFileSync(ALERTS_CACHE_FILE, 'utf8')).alerts || []; } catch { cached = []; }
      }

      // 2. 从日志 grep 新触发记录
      const logFile = path.join(LOGS_DIR, 'btc-alert.log');
      const sixHoursAgo = Date.now() - 6 * 3600000;
      const logAlerts = [];
      if (fs.existsSync(logFile)) {
        // 引擎格式: "2026-05-21T00:00:34: [🔧警报引擎] [INFO] [RULE-NAME] TRIGGERED"
        const raw = safeExec(`grep 'TRIGGERED' "${logFile}" | tail -200`);
        if (raw) {
          const lines = raw.trim().split('\n').filter(Boolean);
          for (const line of lines) {
            const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
            const time = tsMatch ? tsMatch[1] : '';
            const ts = time ? new Date(time).getTime() : 0;
            if (ts <= sixHoursAgo) continue; // 跳过6小时外的
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
        if (!seen.has(a.id) && a.ts > sixHoursAgo) {
          merged.push(a);
          seen.add(a.id);
        }
      }

      // 4. 清理6小时外的，按时间倒序
      recentAlerts = merged.filter(a => a.ts > sixHoursAgo).sort((a, b) => b.ts - a.ts);

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

    // 实盘持仓数（从 OKX API 获取，与快照可能不同步）
    let livePositionCount = 0;
    try {
      const allPositions = okxCli('account positions');
      if (allPositions) {
        livePositionCount = allPositions.filter(p => {
          const pos = parseFloat(p.pos);
          return pos !== 0 && p.posSide !== 'net' || (p.posSide === 'net' && pos !== 0);
        }).length;
      }
    } catch {}

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

    // 活跃规则文件数
    const activeRuleFiles = listFiles(RULES_DIR).filter(f => f.endsWith('.js')).length;
    const archivedRuleFiles = listFiles(RULES_ARCHIVE_DIR).filter(f => f.endsWith('.js')).length;

    res.json({
      pm2: pm2Status,
      healthReports: healthFiles,
      healthSummary,
      actionsLog,
      disk,
      rules: {
        active: activeRuleFiles,
        archived: archivedRuleFiles,
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

// ── SPA fallback ──────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── 启动 ──────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`📈 七月 BTC 监控面板已启动: http://0.0.0.0:${PORT}`);
  console.log(`   工作目录: ${BASE_DIR}`);
});
