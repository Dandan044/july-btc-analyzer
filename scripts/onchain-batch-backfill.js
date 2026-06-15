#!/usr/bin/env node
/**
 * onchain-batch-backfill.js — 一次性脚本：为所有老周期补建链上 JSON
 *
 * 扫描 active/ 下所有周期，对没有 onchain JSON 的币种逐个运行 refresh-onchain.js
 * 串行执行，币种级别去重，带退避重试和限速间隔。
 *
 * 日志: logs/onchain-refresh.log
 * 用法: node scripts/onchain-batch-backfill.js [--dry-run]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'onchain-refresh.log');
const DRY_RUN = process.argv.includes('--dry-run');
const RATE_LIMIT_GAP_MS = 5000; // 每币种间隔 5 秒，防限流
const MAX_RETRIES = 2;
const RETRY_DELAYS = [15000, 30000];

function log(msg, level = 'INFO') {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const prefix = level === 'WARN' ? '⚠️ WARN: ' : level === 'ERROR' ? '⛔ ERROR: ' : '';
  const line = `[${ts}] [backfill] ${prefix}${msg}`;
  console.error(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`, { timeout: ms + 2000 });
}

function main() {
  log('========== 老周期补建开始 ==========');

  const activeDir = path.join(WORKSPACE, 'active');
  if (!fs.existsSync(activeDir)) {
    log('active/ 目录不存在', 'ERROR');
    return;
  }

  const cycles = fs.readdirSync(activeDir)
    .filter(d => d.startsWith('alt-') || d.startsWith('zhuang-'))
    .sort();

  // 从目录名提取币种（alt-XXX-YYYYMMDD-HHMM → XXX）
  const seenCoins = new Set();
  const toProcess = [];

  for (const dir of cycles) {
    const parts = dir.split('-');
    // alt-{COIN}-{DATE}-{TIME} 或 zhuang-{COIN}-{DATE}-{TIME}
    const coin = parts[1];
    if (!coin || seenCoins.has(coin)) continue;

    // 检查是否已有链上 JSON
    const dataDir = path.join(WORKSPACE, 'data');
    const hasJson = fs.existsSync(dataDir) && fs.readdirSync(dataDir)
      .some(f => f.startsWith(`onchain-${coin}-`) && f.endsWith('.json'));

    if (!hasJson) {
      seenCoins.add(coin);
      toProcess.push({ coin, dir });
    }
  }

  log(`共 ${cycles.length} 个周期，去重后 ${toProcess.length} 个币种需补建`);

  if (DRY_RUN) {
    log('--dry-run 模式，仅列出：');
    for (const item of toProcess) {
      log(`  → ${item.coin} (周期: ${item.dir})`);
    }
    log('========== 预览完成 ==========');
    return;
  }

  let success = 0, failed = 0;
  const failedCoins = [];

  for (let i = 0; i < toProcess.length; i++) {
    const { coin, dir } = toProcess[i];
    log(`[${i + 1}/${toProcess.length}] ${coin}...`);

    let ok = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const cmd = `node "${path.join(WORKSPACE, 'scripts', 'refresh-onchain.js')}" ${coin} --save --cycle-dir ${dir}`;
        execSync(cmd, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
        ok = true;
        success++;
        log(`  ✅ ${coin}: 完成` + (attempt > 0 ? ` (第 ${attempt + 1} 次)` : ''));
        break;
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt];
          log(`  ⚠️ ${coin}: 失败 — ${(e.message || '').slice(0, 120)} — ${delay / 1000}s 后重试`, 'WARN');
          sleep(delay);
        } else {
          failed++;
          failedCoins.push(coin);
          log(`  ❌ ${coin}: 最终失败 — ${(e.message || '').slice(0, 200)}`, 'ERROR');
        }
      }
    }

    // 限速间隔（最后一个不 sleep）
    if (i < toProcess.length - 1 && ok) {
      sleep(RATE_LIMIT_GAP_MS);
    }
  }

  log(`========== 补建完成 | 成功 ${success}, 失败 ${failed} | 失败币种: ${failedCoins.join(', ') || '无'} ==========`);
}

main();
