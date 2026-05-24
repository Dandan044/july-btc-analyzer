#!/usr/bin/env node
/**
 * stage1-prep.js — 阶段一预处理脚本（步骤 1~5）
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
  console.error('用法: node stage1-prep.js <COIN>');
  process.exit(1);
}

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', `alt-${COIN}-process.log`);
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const INST_ID = `${COIN}-USDT-SWAP`;
const BLACKLIST_PATH = path.join(WORKSPACE, 'data', 'altcoin-blacklist.json');
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
    `curl -s --max-time 10 --proxy http://127.0.0.1:7890 "https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${INST_ID}"`
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
        // 新上线 → 加入黑名单
        log(`🔴 BLACKLIST: ${COIN} → 新上线币种（上线 ${onlineDays} 天），不符合趋势交易条件`, 'ERROR');

        try {
          let bl = { blacklist: [], reason: {} };
          if (fs.existsSync(BLACKLIST_PATH)) {
            bl = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8'));
          }
          if (!bl.blacklist.includes(COIN)) {
            bl.blacklist.push(COIN);
          }
          bl.reason[COIN] = `新上线币种，历史数据不足30日（上线${onlineDays}天），缺少足够K线数据支撑技术分析`;
          bl.updated = new Date(Date.now() + 8 * 3600000).toISOString();
          fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(bl, null, 2) + '\n', 'utf8');
        } catch (e) {
          log(`黑名单写入失败: ${e.message}`, 'ERROR');
        }

        output({
          status: 'blacklisted',
          coin: COIN,
          reason: `上线不足30日（${onlineDays}天）`,
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
  const existing = fs.readdirSync(activeDir)
    .filter(d => d.startsWith(`alt-${COIN}-`))
    .sort()
    .reverse();

  if (existing.length > 0) {
    cycleDir = existing[0];
    cycleAction = 'reused';
  } else {
    cycleDir = `alt-${COIN}-${dateStr}-${timeStr}`;
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
    const reports = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith(`alt-report-${COIN}-`) && f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 5);
    for (const r of reports) {
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

let contractOk = false;

// 日期格式化：YYYYMMDD → YYYY-MM-DD
const dateFormatted = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
const contractCmd = `node "${getScript}" --coin ${COIN} --json --save --proxy http://127.0.0.1:7890`;

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
// 输出结果
// ════════════════════════════════════════════
log(`预处理阶段完成`);
log(`========== 预处理阶段结束 ==========`);

output({
  status: 'success',
  coin: COIN,
  cycle_dir: cycleDir,
  cycle_action: cycleAction,
  online_days: onlineDays,
  positions_count: positionsCount,
  has_existing: hasExisting,
  report_paths: reportPaths.slice(0, 5),
  report_count: reportPaths.slice(0, 5).length,
  contract_ok: contractOk,
});
