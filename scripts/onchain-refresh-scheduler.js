#!/usr/bin/env node
/**
 * onchain-refresh-scheduler.js — 链上数据定时刷新调度器
 *
 * 由系统 cron 每 6 小时触发，单次执行后退出。
 * 扫描所有活跃周期，检查链上 JSON 是否过期（超过 TTL），过期则触发刷新。
 *
 * 日志: logs/onchain-refresh.log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'onchain-refresh.log');
const TTL_MINUTES = 240; // 4 小时

// ═══ 日志 ═══
function log(msg, level = 'INFO') {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  let line;
  if (level === 'WARN') line = `[${ts}] [scheduler] ⚠️ WARN: ${msg}`;
  else if (level === 'ERROR') line = `[${ts}] [scheduler] ⛔ ERROR: ${msg}`;
  else line = `[${ts}] [scheduler] ${msg}`;
  console.error(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
}

// ═══ 退避重试 ═══
function runWithRetry(cmd, maxRetries = 2) {
  const delays = [15000, 30000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      execSync(cmd, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { ok: true, attempts: attempt + 1 };
    } catch (e) {
      if (attempt < maxRetries) {
        const delay = delays[attempt];
        log(`  重试 ${attempt + 1}/${maxRetries}: ${delay / 1000}s 后`, 'WARN');
        execSync(`sleep ${delay / 1000}`, { timeout: delay + 5000 });
      } else {
        return { ok: false, error: e.message?.slice(0, 200) };
      }
    }
  }
}

// ═══ 扫描 + 刷新 ═══
function scanAndRefresh() {
  const startTime = Date.now();
  log('========== 开始扫描 ==========');

  const activeDir = path.join(WORKSPACE, 'active');
  if (!fs.existsSync(activeDir)) {
    log('active/ 目录不存在', 'WARN');
    return;
  }

  const cycles = fs.readdirSync(activeDir).filter(d => d.startsWith('alt-') || d.startsWith('zhuang-'));
  log(`找到 ${cycles.length} 个活跃周期`);

  // 收集需要刷新的币种（去重）
  const toRefresh = new Set();
  let skipped = 0;
  let noData = 0;

  for (const cycleDir of cycles) {
    const manifestDir = path.join(activeDir, cycleDir, 'data-context');
    if (!fs.existsSync(manifestDir)) { noData++; continue; }

    try {
      const manifestFiles = fs.readdirSync(manifestDir)
        .filter(f => f.startsWith('data-manifest-') && f.endsWith('.json'))
        .sort().reverse();
      if (manifestFiles.length === 0) { noData++; continue; }

      const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, manifestFiles[0]), 'utf8'));
      const onchain = manifest.data_collected?.sentiment_onchain;
      if (!onchain || !onchain.json_file) { noData++; continue; }

      // 检查是否过期
      const updatedAt = onchain.json_updated_at;
      if (!updatedAt) { noData++; continue; }

      const ageMs = Date.now() - new Date(updatedAt).getTime();
      const ageMin = Math.round(ageMs / 60000);
      const ttl = onchain.json_ttl_minutes || TTL_MINUTES;

      if (ageMin >= ttl) {
        // 从 manifest 提取币种
        const coin = manifest.coin?.symbol;
        if (coin && !toRefresh.has(coin)) {
          toRefresh.add(coin);
          log(`  ⏰ 过期: ${coin} (周期 ${cycleDir}, ${ageMin}min > ${ttl}min TTL)`);
        }
      } else {
        skipped++;
      }
    } catch (e) {
      log(`  解析 manifest 失败: ${cycleDir} - ${e.message}`, 'WARN');
    }
  }

  log(`汇总: ${toRefresh.size} 个币种需刷新, ${skipped} 个未过期, ${noData} 个无数据`);

  if (toRefresh.size === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`========== 扫描完成（无过期） | 耗时 ${elapsed}s ==========`);
    return;
  }

  // 逐个刷新
  let success = 0, failed = 0;
  for (const coin of toRefresh) {
    log(`  刷新: ${coin}...`);
    const cmd = `node "${path.join(WORKSPACE, 'scripts', 'refresh-onchain.js')}" ${coin} --save`;
    const result = runWithRetry(cmd, 2);

    if (result.ok) {
      success++;
      log(`  ✅ ${coin}: 完成 (尝试 ${result.attempts} 次)`);
    } else {
      failed++;
      log(`  ❌ ${coin}: 失败 — ${result.error}`, 'ERROR');
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`========== 扫描完成 | 成功 ${success}, 失败 ${failed} | 耗时 ${elapsed}s ==========`);
}

// ═══ 单次执行 ═══
log('调度器启动（单次执行）');
scanAndRefresh();
log('调度器退出');
