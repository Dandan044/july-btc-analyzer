#!/usr/bin/env node
/**
 * stage1-prep.js — 阶段一预处理脚本（步骤 1~9）
 *
 * 用法: node stage1-prep.js <COIN>
 *
 * 功能:
 *   步骤1: 日志开始
 *   步骤2: 上线时间检查（<30天 → 黑名单）
 *   步骤3: 周期创建/复用
 *   步骤4: 持仓同步
 *   步骤5: 历史报告路径收集
 *
 * 输出: JSON 到 stdout（最后一行）
 * 日志: 追加到 logs/alt-{COIN}-process.log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const COIN = process.argv[2];
if (!COIN) {
  console.error('用法: node stage1-prep.js <COIN> [--mode zhuang]');
  process.exit(1);
}

// --mode zhuang: 强庄模式，使用 zhuang- 前缀
const MODE = (process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1]) || 'alt';
const PREFIX = MODE === 'zhuang' ? 'zhuang-' : 'alt-';
const LOG_PREFIX = MODE === 'zhuang' ? 'zhuang-' : 'alt-';
const REPORT_PREFIX = MODE === 'zhuang' ? 'zhuang-report-' : 'alt-report-';

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', `${LOG_PREFIX}${COIN}-process.log`);
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const INST_ID = `${COIN}-USDT-SWAP`;
const SYNC_SCRIPT = path.join(WORKSPACE, 'scripts', 'sync-alt-positions.js');

// ─── 工具函数 ───
function nowTs() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level = 'INFO') {
  const ts = nowTs();
  let line;
  if (level === 'WARN') line = `[${ts}] [阶段一] ⚠️ WARN: ${msg}`;
  else if (level === 'ERROR') line = `[${ts}] [阶段一] ⛔ ERROR: ${msg}`;
  else line = `[${ts}] [阶段一] ${msg}`;
  console.error(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function runCmd(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = out.trim();
    if (!trimmed || trimmed === '[]') return [];
    let parsed = JSON.parse(trimmed);
    // OKX API 返回 {code:"0", data:[...]}，自动解包
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    if (parsed && parsed.code === '0') return parsed;
    return parsed;
  } catch (e) {
    const stderr = (e.stderr || '').toString();
    if (stderr.includes("doesn't exist") || stderr.includes('does not exist') || stderr.includes('invalid')) {
      return [];
    }
    return null;
  }
}

function output(data) {
  console.log('__PREP_OUTPUT__');
  console.log(JSON.stringify(data));
}

const COOLDOWN_PATH = path.join(WORKSPACE, 'data', 'coin-cooldown.json');

function writeCooldown(coin, cooldownUntil, reason) {
  try {
    let data = { entries: {}, updated: '' };
    if (fs.existsSync(COOLDOWN_PATH)) {
      data = JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
    }
    data.entries[coin] = {
      cooldown_until: cooldownUntil,
      reason: reason,
      added_at: new Date().toISOString(),
    };
    data.updated = new Date().toISOString();
    fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(data, null, 2), 'utf8');
    log(`冷却名单已写入: ${coin} → ${cooldownUntil.slice(0, 10)}`);
  } catch (e) {
    log(`冷却名单写入失败: ${e.message}`, 'ERROR');
  }
}

// ════════════════════════════════════════════
// 步骤 1: 日志开始
// ════════════════════════════════════════════
log(`========== 山寨币分析启动 | 币种: ${COIN} ==========`);
log('开始执行 - 三维信息收集（预处理阶段）');

// ════════════════════════════════════════════
// 步骤 2: 上线时间检查
// ════════════════════════════════════════════
log(`上线时间检查: 查询 ${INST_ID} 上线时间...`);

let onlineDays = null;
try {
  const instrumentsRaw = runCmd(
    `curl -s --max-time 10 --proxy ${PROXY_URL} "https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${INST_ID}"`
  );

  if (instrumentsRaw === null || !Array.isArray(instrumentsRaw) || instrumentsRaw.length === 0) {
    log('上线时间 API 调用失败，跳过检查继续', 'WARN');
  } else {
    const listTimeMs = parseInt(instrumentsRaw[0].listTime);
    if (isNaN(listTimeMs)) {
      log('上线时间字段无效，跳过检查继续', 'WARN');
    } else {
      const nowSec = Math.floor(Date.now() / 1000);
      const listTimeSec = listTimeMs / 1000;
      onlineDays = Math.floor((nowSec - listTimeSec) / 86400);

      if (onlineDays < 30) {
        // 新上线 → 写入冷却名单，冷却至 30 天期满
        const daysUntilMature = 30 - onlineDays;
        const cooldownUntil = new Date(Date.now() + daysUntilMature * 86400000).toISOString();

        log(`🔴 COOLDOWN: ${COIN} → 上线 ${onlineDays} 天（不足30天），冷却至 ${cooldownUntil.slice(0,10)}（${daysUntilMature}天）`, 'ERROR');

        writeCooldown(COIN, cooldownUntil, `新上线币种，上线 ${onlineDays} 天（不足30天），需 ${daysUntilMature} 天后才能进入扫描`);

        output({
          status: 'blacklisted',
          coin: COIN,
          reason: `上线不足30日（${onlineDays}天），已写入冷却名单至 ${cooldownUntil.slice(0,10)}`,
        });
        process.exit(0);
      } else {
        log(`上线时间检查: ${COIN} 已上线 ${onlineDays} 天 — 通过`);
      }
    }
  }
} catch (e) {
  log(`上线时间检查异常: ${e.message}`, 'WARN');
}

// ════════════════════════════════════════════
// 步骤 3: 周期创建/复用
// ════════════════════════════════════════════
const now = new Date();
const dateStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
const timeStr = new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 16).replace(':', '');

// 检查是否已有活跃周期
const activeDir = path.join(WORKSPACE, 'active');
let cycleDir = null;
let cycleAction = null;

try {
  // ⚠️ 检查所有画像前缀，防止 alt/zhuang 双画像共存同一币种
  const allPrefixes = ['alt', 'zhuang'].includes(PREFIX) ? ['alt', 'zhuang'] : [PREFIX];
  const existing = fs.readdirSync(activeDir)
    .filter(d => allPrefixes.some(p => d.startsWith(`${p}${COIN}-`)))
    .sort()
    .reverse();

  if (existing.length > 0) {
    cycleDir = existing[0];
    cycleAction = 'reused';
  } else {
    cycleDir = `${PREFIX}${COIN}-${dateStr}-${timeStr}`;
    cycleAction = 'created';
    fs.mkdirSync(path.join(activeDir, cycleDir, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(activeDir, cycleDir, 'data-context'), { recursive: true });
  }
} catch (e) {
  log(`周期文件夹创建失败: ${e.message}`, 'ERROR');
  output({
    status: 'error',
    coin: COIN,
    reason: `周期文件夹创建失败: ${e.message}`,
  });
  process.exit(1);
}

log(`周期状态: active/${cycleDir} (${cycleAction === 'created' ? '新建' : '复用'})`);

// ════════════════════════════════════════════
// 步骤 4: 持仓同步
// ════════════════════════════════════════════
log(`持仓同步: 调用 sync-alt-positions.js (${COIN}, cross)`);

const syncCmd = `node "${SYNC_SCRIPT}" ${COIN} ${cycleDir} "${LOG_FILE}"`;
let syncResult = null;
let positionsCount = 0;
let hasExisting = false;

try {
  const syncOutput = execSync(syncCmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  // 最后一行是 JSON
  const lines = syncOutput.trim().split('\n');
  for (const line of lines.reverse()) {
    if (line.startsWith('{')) {
      syncResult = JSON.parse(line);
      break;
    }
  }

  if (syncResult && syncResult.sync_status === 'success') {
    positionsCount = syncResult.live_positions_count || syncResult.current_positions_count || 0;
    hasExisting = positionsCount > 0;
    log(`持仓同步: ${positionsCount} 个仓位 (${hasExisting ? '有持仓' : '无持仓'})`);
  } else {
    log('持仓同步失败，标记无持仓', 'WARN');
  }
} catch (e) {
  log(`持仓同步异常: ${e.message}`, 'WARN');
}

// ════════════════════════════════════════════
// 步骤 5: 历史报告路径收集
// ════════════════════════════════════════════
const reportsDir = path.join(activeDir, cycleDir, 'reports');
const reportPaths = [];

try {
  // 直接搜当前周期 reports/ 下的历史报告（此时本篇报告尚未生成，目录内均为历史）
  if (fs.existsSync(reportsDir)) {
    const allReports = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith(`${REPORT_PREFIX}${COIN}-`) && f.endsWith('.md'))
      .sort();  // 按文件名排序（时间升序）
    const firstReport = allReports[0] || null;
    const recentReports = allReports.reverse().slice(0, 5);  // 最近 5 篇
    // 确保第一篇始终在收集列表中（方向承诺在首篇报告）
    if (firstReport && !recentReports.includes(firstReport)) {
      recentReports.unshift(firstReport);
    }
    for (const r of recentReports) {
      reportPaths.push(`active/${cycleDir}/reports/${r}`);
    }
  }

  log(`历史报告收集: ${COIN} 找到 ${reportPaths.length} 篇`);
} catch (e) {
  log(`历史报告收集失败: ${e.message}`, 'WARN');
}

// ════════════════════════════════════════════
// 步骤 7: 合约数据获取
// ════════════════════════════════════════════
log('合约数据获取: 调用 get_altcoin_analysis.js...');

const getScript = path.join(WORKSPACE, 'skills', 'btc-market-lite', 'scripts', 'get_altcoin_analysis.js');

// ─── 合约数据获取（带退避重试） ───
const CONTRACT_MAX_RETRIES = 3;       // 最多重试 3 次（共 4 次尝试）
const CONTRACT_TIMEOUT_MS = 30000;    // 单次超时 30s
const CONTRACT_RETRY_DELAYS = [10000, 20000, 60000]; // 退避：10s → 20s → 60s（最长 1min）

// ─── 链上数据获取（退避重试） ───
const ONCHAIN_MAX_RETRIES = 2;        // 最多重试 2 次（共 3 次尝试）
const ONCHAIN_RETRY_DELAYS = [15000, 30000]; // 退避：15s → 30s

let contractOk = false;

// 日期格式化：YYYYMMDD → YYYY-MM-DD
const dateFormatted = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
const contractCmd = `node "${getScript}" --coin ${COIN} --json --save --proxy ${PROXY_URL}`;

for (let attempt = 0; attempt <= CONTRACT_MAX_RETRIES; attempt++) {
  try {
    execSync(contractCmd, { encoding: 'utf8', timeout: CONTRACT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });

    // 脚本保存到 data/YYYY-MM-DD_COIN.json，重命名为 data/{COIN}-YYYY-MM-DD.json
    const srcFile = path.join(WORKSPACE, 'data', `${dateFormatted}_${COIN}.json`);
    const destFile = path.join(WORKSPACE, 'data', `${COIN}-${dateFormatted}.json`);

    if (fs.existsSync(srcFile)) {
      fs.renameSync(srcFile, destFile);
      contractOk = true;
      log(`合约数据获取: 成功 → data/${COIN}-${dateFormatted}.json` + (attempt > 0 ? ` (第 ${attempt + 1} 次尝试)` : ''));
    } else {
      log(`合约数据获取: 脚本执行成功但未找到源文件 ${dateFormatted}_${COIN}.json`, 'WARN');
    }
    break; // 成功，跳出重试循环
  } catch (e) {
    if (attempt < CONTRACT_MAX_RETRIES) {
      const delay = CONTRACT_RETRY_DELAYS[attempt];
      log(`合约数据获取失败: ${e.message} — ${delay / 1000}s 后重试 (${attempt + 1}/${CONTRACT_MAX_RETRIES})`, 'WARN');
      execSync(`sleep ${delay / 1000}`, { timeout: delay + 5000 });
    } else {
      log(`合约数据获取失败（已重试 ${CONTRACT_MAX_RETRIES} 次）: ${e.message}`, 'ERROR');
    }
  }
}

// ════════════════════════════════════════════
// 步骤 8: 链上数据获取（refresh-onchain.js）
// ════════════════════════════════════════════
log('链上数据获取: 调用 refresh-onchain.js...');

const ONCHAIN_REFRESH_SCRIPT = path.join(WORKSPACE, 'scripts', 'refresh-onchain.js');
let onchainOk = false;

for (let attempt = 0; attempt <= ONCHAIN_MAX_RETRIES; attempt++) {
  try {
    const onchainCmd = `node "${ONCHAIN_REFRESH_SCRIPT}" ${COIN} --save --cycle-dir ${cycleDir}`;
    execSync(onchainCmd, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
    onchainOk = true;
    log(`链上数据获取: 成功` + (attempt > 0 ? ` (第 ${attempt + 1} 次尝试)` : ''));
    break;
  } catch (e) {
    if (attempt < ONCHAIN_MAX_RETRIES) {
      const delay = ONCHAIN_RETRY_DELAYS[attempt];
      log(`链上数据获取失败: ${e.message?.slice(0, 150)} — ${delay / 1000}s 后重试 (${attempt + 1}/${ONCHAIN_MAX_RETRIES})`, 'WARN');
      execSync(`sleep ${delay / 1000}`, { timeout: delay + 5000 });
    } else {
      log(`链上数据获取失败（已重试 ${ONCHAIN_MAX_RETRIES} 次）: ${e.message?.slice(0, 150)}`, 'ERROR');
    }
  }
}

// ════════════════════════════════════════════
// 步骤 9: BTC 跟踪度计算
// ════════════════════════════════════════════
log('BTC 跟踪度: 调用 calc-btc-correlation.js...');

const CORR_SCRIPT = path.join(WORKSPACE, 'scripts', 'calc-btc-correlation.js');
const trackingFile = path.join(activeDir, cycleDir, 'data-context', 'btc-tracking.json');
let trackingOk = false;

try {
  const corrCmd = `node "${CORR_SCRIPT}" --coin ${COIN}`;
  const corrOutput = execSync(corrCmd, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
  const jsonStart = corrOutput.indexOf('[');
  if (jsonStart >= 0) {
    const parsed = JSON.parse(corrOutput.slice(jsonStart));
    const coinData = parsed.find(r => r.coin === COIN);
    if (coinData && coinData.timeframes) {
      fs.writeFileSync(trackingFile, JSON.stringify(coinData, null, 2), 'utf8');
      trackingOk = true;
      const tf1h = coinData.timeframes['1H(3天)'] || {};
      log(`BTC 跟踪度: corr=${tf1h.correlation} beta=${tf1h.beta} down_corr=${tf1h.downside_corr} -> ${trackingFile}`);
    } else {
      log('BTC 跟踪度: 未找到币种数据', 'WARN');
    }
  } else {
    log('BTC 跟踪度: 无法解析 JSON 输出', 'WARN');
  }
} catch (e) {
  log(`BTC 跟踪度计算失败: ${e.message?.slice(0, 150)}`, 'WARN');
}


// ════════════════════════════════════════════
// 输出结果
// ════════════════════════════════════════════
log(`预处理阶段完成`);
log(`========== 预处理阶段结束 ==========`);

output({
  status: 'success',
  coin: COIN,
  cycle_dir: cycleDir,
  mode: MODE,
  cycle_action: cycleAction,
  online_days: onlineDays,
  positions_count: positionsCount,
  has_existing: hasExisting,
  report_paths: reportPaths.slice(0, 5),
  report_count: reportPaths.slice(0, 5).length,
  contract_ok: contractOk,
  onchain_ok: onchainOk,
});
