#!/usr/bin/env node
/**
 * cycle-guardian.js — 周期守护者（静默巡检 + 周期清理 合并）
 *
 * 每 30 分钟执行两个阶段:
 *   阶段 A: 静默巡检 — 检测有警报规则但长时间未触发/未出报告的周期，重新发起即时分析
 *   阶段 B: 周期清理 — 扫描空仓+无入场意图的僵尸周期，自动归档并冷却币种
 *
 * PM2 常驻。日志: logs/cycle-guardian.log
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const WORKSPACE = path.resolve(__dirname, '..');
const ACTIVE_DIR = path.join(WORKSPACE, 'active');
const RULES_DIR = path.join(WORKSPACE, 'skills', 'btc-alert', 'rules');
const ARCHIVE_SCRIPT = path.join(__dirname, 'archive-cycle.js');
const DISPATCH = path.join(__dirname, 'dispatch.js');
const STAGE1_SCRIPT = path.join(__dirname, 'stage1-instant.js');
const COOLDOWN_PATH = path.join(WORKSPACE, 'data', 'coin-cooldown.json');
const STATE_FILE = path.join(WORKSPACE, 'data', 'cycle-guardian-state.json');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'cycle-guardian.log');

// ════════════════════════════════════
// 配置
// ════════════════════════════════════
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const SILENCE_THRESHOLD_POS_H = 12;
const SILENCE_THRESHOLD_NO_POS_H = 8;
const SILENCE_DEDUP_MS = 6 * 60 * 60 * 1000;
const SILENCE_STAGGER_MS = 30 * 1000;
const STAGE1_TIMEOUT_MS = 360 * 1000;
const ARCHIVE_MAX_AGE_H = 24;
const ARCHIVE_COOLDOWN_H = 18;
const STATE_PRUNE_DAYS = 30;

// ════════════════════════════════════
// 工具函数
// ════════════════════════════════════
function ts() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { silenceTriggers: {}, archiveCooldowns: {} };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractCoin(dirName) {
  // alt-COIN-YYYYMMDD-HHMM | zhuang-COIN-YYYYMMDD-HHMM | cycle-YYYYMMDD-NNN
  if (dirName.startsWith('cycle-')) {
    // BTC cycle — 币种固定为 BTC
    return 'BTC';
  }
  const parts = dirName.split('-');
  return parts[1] || null;
}

function parseAgeHours(dirName) {
  const m = dirName.match(/(\d{8})-(\d{4})$/);
  if (!m) return null;
  const [, date, time] = m;
  const created = new Date(
    parseInt(date.slice(0, 4)), parseInt(date.slice(4, 6)) - 1, parseInt(date.slice(6, 8)),
    parseInt(time.slice(0, 2)), parseInt(time.slice(2, 4))
  );
  return (Date.now() - created.getTime()) / 3600000;
}

function hasPosition(cycleDir) {
  const pf = path.join(cycleDir, 'positions.json');
  if (!fs.existsSync(pf)) return false;
  try {
    return (JSON.parse(fs.readFileSync(pf, 'utf8'))['汇总']?.['当前持仓数'] || 0) > 0;
  } catch (_) { return false; }
}

function getPositionCount(cycleDir) {
  const pf = path.join(cycleDir, 'positions.json');
  if (!fs.existsSync(pf)) return 0;
  try {
    return JSON.parse(fs.readFileSync(pf, 'utf8'))['汇总']?.['当前持仓数'] || 0;
  } catch (_) { return 0; }
}

function activeCycles() {
  if (!fs.existsSync(ACTIVE_DIR)) return [];
  return fs.readdirSync(ACTIVE_DIR).filter(d => {
    const s = fs.statSync(path.join(ACTIVE_DIR, d));
    return s.isDirectory() && (d.startsWith('alt-') || d.startsWith('zhuang-') || d.startsWith('cycle-'));
  });
}

// ════════════════════════════════════
// 阶段 A: 静默巡检
// ════════════════════════════════════
function hasActiveRules(coin) {
  if (!fs.existsSync(RULES_DIR)) return false;
  try {
    const prefix = coin.toUpperCase();
    return fs.readdirSync(RULES_DIR).some(f => {
      if (!f.endsWith('.js')) return false;
      const upper = f.toUpperCase();
      return upper.startsWith(prefix + '-') || upper.startsWith(prefix + '_');
    });
  } catch (_) { return false; }
}

function getLastReportTime(cycleDir) {
  const reportsDir = path.join(cycleDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  let latest = 0;
  try {
    for (const f of fs.readdirSync(reportsDir)) {
      const mtime = fs.statSync(path.join(reportsDir, f)).mtimeMs;
      if (mtime > latest) latest = mtime;
    }
  } catch (_) { return null; }
  return latest > 0 ? latest : null;
}

async function phaseSilenceCheck(state) {
  log('── 阶段A: 静默巡检 ──');

  const cycleDirs = activeCycles().filter(d => d.startsWith('alt-') || d.startsWith('zhuang-')).sort();
  log(` 扫描 ${cycleDirs.length} 个山寨币/庄币周期`);

  if (!state.silenceTriggers) state.silenceTriggers = {};
  let silent = 0, triggered = 0, skipped = 0;

  const silentList = [];

  for (const dirName of cycleDirs) {
    const coin = extractCoin(dirName);
    if (!coin) continue;

    if (!hasActiveRules(coin)) continue; // 无规则的不检测

    const cycleDir = path.join(ACTIVE_DIR, dirName);
    const lastReport = getLastReportTime(cycleDir);
    const posCount = getPositionCount(cycleDir);

    let silenceH;
    if (lastReport === null) {
      try { silenceH = (Date.now() - fs.statSync(cycleDir).mtimeMs) / 3600000; }
      catch (_) { silenceH = Infinity; }
    } else {
      silenceH = (Date.now() - lastReport) / 3600000;
    }

    const threshold = posCount > 0 ? SILENCE_THRESHOLD_POS_H : SILENCE_THRESHOLD_NO_POS_H;
    if (silenceH < threshold) continue;

    // 去重
    const lastTrigger = state.silenceTriggers[dirName];
    if (lastTrigger && Date.now() - lastTrigger < SILENCE_DEDUP_MS) {
      skipped++;
      continue;
    }

    silentList.push({ dirName, coin, cycleDir, silenceH, posCount, threshold });
  }

  silent = silentList.length;
  log(` 静默周期: ${silent} 个（跳过冷却: ${skipped}）`);

  for (const item of silentList) {
    const { dirName, coin, cycleDir, silenceH, posCount, threshold } = item;
    log(`  🔔 静默触发: ${coin} | ${silenceH.toFixed(1)}h | 持仓${posCount} | 阈值${threshold}h`);

    const alertData = {
      coin,
      alertName: 'silence-check',
      alertType: 'silence',
      triggerPrice: null, currentPrice: null,
      silenceHours: Math.round(silenceH * 10) / 10,
      reason: `警报静默超过${threshold}h（实际${silenceH.toFixed(1)}h），持仓${posCount}个，自动重评估`,
    };

    let stage1Ok = false;
    try {
      const out = execSync(`node "${STAGE1_SCRIPT}" '${JSON.stringify(alertData).replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8', timeout: STAGE1_TIMEOUT_MS, cwd: WORKSPACE,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, REQUIRE_CONTRACT: '1' },
      });
      for (const line of out.trim().split('\n').reverse()) {
        if (line.startsWith('{') && line.includes('"status"')) {
          try {
            const r = JSON.parse(line);
            if (r.status === 'success' && r.contract_ok) stage1Ok = true;
          } catch (_) {}
          break;
        }
      }
    } catch (e) {
      const out = (e.stdout || '') + (e.stderr || '');
      for (const line of out.split('\n').reverse()) {
        if (line.startsWith('{') && line.includes('"status"')) {
          try {
            const r = JSON.parse(line);
            if (r.status === 'success' && r.contract_ok) stage1Ok = true;
          } catch (_) {}
          break;
        }
      }
    }

    if (stage1Ok) {
      state.silenceTriggers[dirName] = Date.now();
      triggered++;
      log(`  ✅ ${coin} 阶段一完成 → 已派发`);
    } else {
      log(`  ❌ ${coin} stage1 失败，未更新去重`);
    }

    saveState(state);
    if (silentList.indexOf(item) < silentList.length - 1) await sleep(SILENCE_STAGGER_MS);
  }

  log(`── 阶段A 完成: 触发 ${triggered} ──`);
}

// ════════════════════════════════════
// 阶段 B: 周期清理
// ════════════════════════════════════
function getLatestDecision(cycleDir) {
  const reportsDir = path.join(cycleDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('trade-decision-'))
    .sort().reverse();
  if (files.length === 0) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8'));
    data._fileName = files[0];
    return data;
  } catch (_) { return null; }
}

function parseReportTime(fileName) {
  const m = fileName.match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}T${m[2]}:${m[3]}:00+08:00`).getTime();
}

function writeCooldown(coin, reason) {
  let cd = { _schema: '自动冷却名单', entries: {}, updated: null };
  try {
    if (fs.existsSync(COOLDOWN_PATH)) cd = JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
  } catch (_) {}
  if (!cd.entries) cd.entries = {};

  cd.entries[coin] = {
    cooldown_until: new Date(Date.now() + ARCHIVE_COOLDOWN_H * 3600000).toISOString(),
    reason,
    added_at: new Date().toISOString()
  };
  cd.updated = new Date().toISOString();
  fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(cd, null, 2) + '\n');
}

async function phaseArchiveCleanup(state) {
  log('── 阶段B: 周期清理 ──');

  const dirs = activeCycles();
  let archived = 0, skipped = 0;

  for (const dir of dirs) {
    const age = parseAgeHours(dir);
    if (age === null || age < ARCHIVE_MAX_AGE_H) continue;
    if (hasPosition(path.join(ACTIVE_DIR, dir))) continue;

    const cyclePath = path.join(ACTIVE_DIR, dir);
    const dec = getLatestDecision(cyclePath);

    // 兜底策略：无 trade-decision 或 decision 超过 72h 未更新 → 直接归档
    const isStale = !dec || (dec._fileName && parseReportTime(dec._fileName) && (Date.now() - parseReportTime(dec._fileName)) > 72 * 3600000);

    if (!isStale && dec && dec.action === 'wait') {
      const reportTime = parseReportTime(dec._fileName);
      const deadlineMs = Date.now() - ARCHIVE_MAX_AGE_H * 3600000;
      if (reportTime && reportTime < deadlineMs) continue; // 决策刚好在24h边界前，等下轮
    } else if (!isStale && (!dec || dec.action !== 'wait')) {
      continue; // 决策不是 wait，不归
    }

    const coin = dec?.coin || extractCoin(dir) || dir.split('-')[1] || dir;
    const reportAge = dec?._fileName ? ((Date.now() - parseReportTime(dec._fileName)) / 3600000).toFixed(1) : '无';
    const staleTag = isStale && !dec ? '🧟' : (isStale ? '⏳' : '');
    log(` ${staleTag} 僵尸: ${dir} | coin=${coin} | age=${age.toFixed(1)}h | 决策=${dec?._fileName||'无'}(${reportAge}h前)`);

    try {
      execSync(`node "${ARCHIVE_SCRIPT}" --cycle ${dir} --by lifetime-expired --reason "周期守护: ${isStale&&!dec?'无决策超时':isStale?'决策过期超时':'24h超时wait'}" --close-type "手动归档" --no-sync`, {
        encoding: 'utf8', timeout: 30000, cwd: WORKSPACE
      });
      log(`  📦 已归档: ${dir}`);
      writeCooldown(coin, `auto-archived (cycle: ${dir})`);
      log(`  🧊 ${coin} → ${ARCHIVE_COOLDOWN_H}h 冷却`);
      archived++;
    } catch (e) {
      log(`  ⛔ 归档失败: ${dir} → ${e.message?.slice(0, 120)}`);
    }
  }

  // 清理过期状态
  const cutoff = Date.now() - STATE_PRUNE_DAYS * 86400000;
  let cleaned = 0;
  for (const key of Object.keys(state.silenceTriggers || {})) {
    if (state.silenceTriggers[key] < cutoff) { delete state.silenceTriggers[key]; cleaned++; }
  }
  if (cleaned > 0) { saveState(state); log(` 🧹 清理过期状态: ${cleaned} 条`); }

  log(`── 阶段B 完成: 归档 ${archived} | 跳过 ${skipped} ──`);
}

// ════════════════════════════════════
// 主循环
// ════════════════════════════════════
async function run() {
  log('══════════ 周期守护扫描开始 ══════════');
  const state = loadState();
  const t0 = Date.now();

  try { await phaseSilenceCheck(state); }
  catch (e) { log(`阶段A异常: ${e.message}`); }

  try { await phaseArchiveCleanup(state); }
  catch (e) { log(`阶段B异常: ${e.message}`); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  log(`══════════ 周期守护完成 | 耗时 ${elapsed}s ══════════`);
}

async function main() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  log('🚀 周期守护者启动');
  log(`配置: 间隔=${SCAN_INTERVAL_MS/60000}min | 静默阈值=${SILENCE_THRESHOLD_POS_H}h(持仓)/${SILENCE_THRESHOLD_NO_POS_H}h(空仓) | 归档阈值=${ARCHIVE_MAX_AGE_H}h | 冷却=${ARCHIVE_COOLDOWN_H}h`);

  await run();
  setInterval(async () => {
    try { await run(); }
    catch (e) { log(`定时循环异常: ${e.message}`); }
  }, SCAN_INTERVAL_MS);
}

main().catch(e => { log(`启动失败: ${e.message}`); process.exit(1); });
