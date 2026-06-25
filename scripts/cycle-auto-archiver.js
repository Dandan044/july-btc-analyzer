#!/usr/bin/env node
/**
 * cycle-auto-archiver.js — 僵尸周期自动清理
 *
 * 每 15 分钟扫描 active/ 下所有周期，静默归档满足以下条件的周期：
 *   1. 周期年龄 > 24h
 *   2. 当前持仓数 == 0
 *   3. 最新 trade-decision 在 24h 阈值之后生成
 *   4. 该 trade-decision action == "wait"
 *
 * 关键：必须等 24h 之后新生成的报告来定生死。
 * 如果最新报告在 24h 之前生成 → 跳过，等下一篇报告出来再判。
 *
 * 归档操作：
 *   - 调用 archive-cycle.js 归档周期及其活跃规则
 *   - 不创建复盘任务
 *   - 写入 coin-cooldown.json (72h 冷却)
 *
 * PM2 常驻进程。日志输出到 logs/cycle-auto-archiver.log。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = path.join(__dirname, '..');
const ACTIVE_DIR = path.join(WORKSPACE, 'active');
const ARCHIVE_SCRIPT = path.join(__dirname, 'archive-cycle.js');
const COOLDOWN_PATH = path.join(WORKSPACE, 'data', 'coin-cooldown.json');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'cycle-auto-archiver.log');

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const MAX_AGE_HOURS = 24;
const COOLDOWN_HOURS = 18;

function log(msg) {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function parseAgeHours(dirName) {
  // alt-COIN-YYYYMMDD-HHMM / zhuang-COIN-YYYYMMDD-HHMM / cycle-YYYYMMDD-NNN
  const m = dirName.match(/(\d{8})-(\d{4})$/);
  if (!m) return null;
  const [, date, time] = m;
  const created = new Date(
    parseInt(date.slice(0, 4)), parseInt(date.slice(4, 6)) - 1, parseInt(date.slice(6, 8)),
    parseInt(time.slice(0, 2)), parseInt(time.slice(2, 4))
  );
  return (Date.now() - created.getTime()) / (1000 * 60 * 60);
}

function getLatestDecision(cycleDir) {
  const reportsDir = path.join(ACTIVE_DIR, cycleDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('trade-decision-'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8'));
    data._fileName = files[0];  // 附带文件名，用于解析报告时间
    return data;
  }
  catch (_) { return null; }
}

function parseReportTime(fileName) {
  // trade-decision-COIN-YYYY-MM-DD-HHMM.json
  const m = fileName.match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}T${m[2]}:${m[3]}:00+08:00`).getTime();
}

function hasPosition(cycleDir) {
  const pf = path.join(ACTIVE_DIR, cycleDir, 'positions.json');
  if (!fs.existsSync(pf)) return false;
  try {
    return (JSON.parse(fs.readFileSync(pf, 'utf8'))['汇总']?.['当前持仓数'] || 0) > 0;
  } catch (_) { return false; }
}

function writeCooldown(coin, reason) {
  let cd = { _schema: "自动冷却名单", entries: {}, updated: null };
  try {
    if (fs.existsSync(COOLDOWN_PATH)) cd = JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
  } catch (_) {}
  if (!cd.entries) cd.entries = {};

  cd.entries[coin] = {
    cooldown_until: new Date(Date.now() + COOLDOWN_HOURS * 3600000).toISOString(),
    reason: reason,
    added_at: new Date().toISOString()
  };
  cd.updated = new Date().toISOString();
  fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(cd, null, 2) + '\n');
}

function scan() {
  log('========== 扫描开始 ==========');
  let archived = 0;

  try {
    const dirs = fs.readdirSync(ACTIVE_DIR).filter(d => {
      const s = fs.statSync(path.join(ACTIVE_DIR, d));
      return s.isDirectory() && (d.startsWith('alt-') || d.startsWith('zhuang-') || d.startsWith('cycle-'));
    });

    for (const dir of dirs) {
      const age = parseAgeHours(dir);
      if (age === null || age < MAX_AGE_HOURS) continue;
      if (hasPosition(dir)) continue;

      const dec = getLatestDecision(dir);
      if (!dec || dec.action !== 'wait') continue;

      // 必须等 24h 之后新生成的报告来定生死，不用旧报告判
      const reportTime = parseReportTime(dec._fileName);
      const deadlineMs = Date.now() - MAX_AGE_HOURS * 3600000;
      if (reportTime && reportTime < deadlineMs) {
        // 最新报告在 24h 之前生成 → 等下一篇
        continue;
      }

      const coin = dec.coin || dir.split('-')[1] || dir;
      const reportAge = reportTime ? ((Date.now() - reportTime) / 3600000).toFixed(1) : '?';
      log(`🔍 僵尸: ${dir} | coin=${coin} | age=${age.toFixed(1)}h | report=${reportAge}h前 | → 归档`);

      try {
        execSync(
          `node "${ARCHIVE_SCRIPT}" --cycle ${dir} --by lifetime-expired --reason "24h超时无入场机会" --close-type "手动归档" --no-sync`,
          { encoding: 'utf8', timeout: 30000, cwd: WORKSPACE }
        );
        log(`  📦 已归档: ${dir}`);

        writeCooldown(coin, `24h超时无入场机会 (cycle: ${dir})`);
        log(`  🧊 冷却: ${coin} → ${COOLDOWN_HOURS}h`);

        archived++;
      } catch (e) {
        log(`  ⛔ 失败: ${dir} → ${e.message?.slice(0, 120)}`);
      }
    }
  } catch (e) {
    log(`扫描异常: ${e.message}`, 'ERROR');
  }

  log(`========== 结束 | 归档: ${archived} ==========`);
}

log('🚀 启动 | 间隔: 15min | 年龄阈值: 24h | 冷却: 72h');
scan();
setInterval(scan, SCAN_INTERVAL_MS);
