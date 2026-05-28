#!/usr/bin/env node
/**
 * stage1-instant.js — 即时分析阶段一全流程脚本
 *
 * 用法: node stage1-instant.js '<警报JSON>'
 *
 * 功能:
 *   步骤1: 解析警报数据 + 日志开始
 *   步骤2: 定位活跃周期（必须存在）
 *   步骤2.5: 同步持仓
 *   步骤3: 获取即时合约数据
 *   步骤4: 复用已有媒体/链上数据（检查存在性）
 *   步骤5: 收集历史报告路径
 *   步骤6: 输出即时数据清单 JSON
 *   步骤7: 记录阶段结束
 *
 * 输出: JSON 到 stdout（最后一行 __INSTANT_OUTPUT__）
 * 日志: 追加到 logs/alt-{COIN}-process.log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── 参数解析 ───
const alertJsonStr = process.argv[2];
if (!alertJsonStr) {
  console.error('用法: node stage1-instant.js "<警报JSON>"');
  process.exit(1);
}

let alertData;
try {
  alertData = JSON.parse(alertJsonStr);
} catch (e) {
  console.error(`⛔ 警报 JSON 解析失败: ${e.message}`);
  process.exit(1);
}

const COIN = alertData.coin;
if (!COIN) {
  console.error('⛔ 警报数据缺少 coin 字段');
  process.exit(1);
}

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', `alt-${COIN}-process.log`);
const SYNC_SCRIPT = path.join(WORKSPACE, 'scripts', 'sync-alt-positions.js');
const GET_SCRIPT = path.join(WORKSPACE, 'skills', 'btc-market-lite', 'scripts', 'get_altcoin_analysis.js');
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';

// ─── 工具函数 ───
function nowTs() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level = 'INFO') {
  const ts = nowTs();
  let line;
  if (level === 'WARN') line = `[${ts}] [即时分析阶段一] ⚠️ WARN: ${msg}`;
  else if (level === 'ERROR') line = `[${ts}] [即时分析阶段一] ⛔ ERROR: ${msg}`;
  else line = `[${ts}] [即时分析阶段一] ${msg}`;
  console.error(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function output(data) {
  console.log('__INSTANT_OUTPUT__');
  console.log(JSON.stringify(data));
}

// ════════════════════════════════════════════
// 步骤 1: 记录阶段开始
// ════════════════════════════════════════════
const alertName = alertData.alertName || 'unknown';
log(`========== 山寨即时分析启动 | 币种: ${COIN} | 警报: ${alertName} ==========`);
log('开始执行 - 警报数据解析');

// ════════════════════════════════════════════
// 步骤 2: 定位活跃周期
// ════════════════════════════════════════════
const activeDir = path.join(WORKSPACE, 'active');
let cycleDir = null;

try {
  const existing = fs.readdirSync(activeDir)
    .filter(d => d.startsWith(`alt-${COIN}-`))
    .sort()
    .reverse();

  if (existing.length === 0) {
    log(`⛔ ERROR: 未找到活跃周期 active/alt-${COIN}-*，无法执行即时分析`, 'ERROR');
    output({ status: 'error', coin: COIN, reason: '无活跃周期' });
    process.exit(1);
  }

  cycleDir = existing[0];
  log(`周期定位: active/${cycleDir} (复用)`);
} catch (e) {
  log(`周期定位失败: ${e.message}`, 'ERROR');
  output({ status: 'error', coin: COIN, reason: `周期定位失败: ${e.message}` });
  process.exit(1);
}

// ════════════════════════════════════════════
// 步骤 2.5: 同步持仓
// ════════════════════════════════════════════
log(`持仓同步路由: sync-alt-positions.js (${COIN}, cross)`);

let positionsCount = 0;
try {
  const syncCmd = `node "${SYNC_SCRIPT}" ${COIN} ${cycleDir} "${LOG_FILE}"`;
  const syncOutput = execSync(syncCmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = syncOutput.trim().split('\n');
  for (const line of lines.reverse()) {
    if (line.startsWith('{')) {
      const syncResult = JSON.parse(line);
      if (syncResult.sync_status === 'success') {
        positionsCount = syncResult.live_positions_count || syncResult.current_positions_count || 0;
        log(`持仓同步: ${positionsCount} 个仓位`);
      } else {
        log('持仓同步失败，标记无持仓', 'WARN');
      }
      break;
    }
  }
} catch (e) {
  log(`持仓同步异常: ${e.message}`, 'WARN');
}

// ════════════════════════════════════════════
// 步骤 3: 获取即时合约数据
// ════════════════════════════════════════════
log('合约数据获取: 调用 get_altcoin_analysis.js（即时）...');

const now = new Date();
const dateStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
const timeStr = new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 16).replace(':', '');
const dateFormatted = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
const instantDataFile = `${COIN}-instant-${dateStr}-${timeStr}.json`;

// ─── 合约数据获取（带退避重试） ───
// REQUIRE_CONTRACT=1 时失败即退出，不派发 stage2（静默检查等场景用）
const REQUIRE_CONTRACT = process.env.REQUIRE_CONTRACT === '1';
const CONTRACT_MAX_RETRIES = 1;       // 最多重试 1 次（共 2 次尝试）
const CONTRACT_TIMEOUT_MS = 120000;   // 单次超时 120s（脚本需 9+ 次 OKX API 调用）
const CONTRACT_RETRY_DELAYS = [30000]; // 退避：30s

let contractOk = false;
const contractCmd = `node "${GET_SCRIPT}" --coin ${COIN} --json --save --proxy ${PROXY_URL}`;

for (let attempt = 0; attempt <= CONTRACT_MAX_RETRIES; attempt++) {
  try {
    execSync(contractCmd, { encoding: 'utf8', timeout: CONTRACT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });

    // 重命名：data/YYYY-MM-DD_COIN.json → data/{COIN}-instant-YYYYMMDD-HHMM.json
    const srcFile = path.join(WORKSPACE, 'data', `${dateFormatted}_${COIN}.json`);
    const destFile = path.join(WORKSPACE, 'data', instantDataFile);

    if (fs.existsSync(srcFile)) {
      fs.renameSync(srcFile, destFile);
      contractOk = true;
      log(`合约数据获取: 成功 → data/${instantDataFile}` + (attempt > 0 ? ` (第 ${attempt + 1} 次尝试)` : ''));
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
// 步骤 4: 复用已有媒体和链上数据
// ════════════════════════════════════════════
const mediaFile = path.join(activeDir, cycleDir, 'data-context', 'sentiment-media.md');
const onchainFile = path.join(activeDir, cycleDir, 'data-context', 'sentiment-onchain.md');

const mediaExists = fs.existsSync(mediaFile);
const onchainExists = fs.existsSync(onchainFile);

log(`已有数据复用: 媒体=${mediaExists ? '存在' : '缺失'}, 链上=${onchainExists ? '存在' : '缺失'}`);

// ════════════════════════════════════════════
// 步骤 5: 收集历史报告路径
// ════════════════════════════════════════════
const reportPaths = [];
try {
  // 直接搜当前周期 reports/ 下的历史报告（此时本篇报告尚未生成，目录内均为历史）
  const reportsDir = path.join(activeDir, cycleDir, 'reports');
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
// 步骤 6: 输出即时数据清单 JSON
// ════════════════════════════════════════════
const nowISO = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';

const manifest = {
  manifest_version: '1.0',
  stage: 'altcoin-instant',
  generated_at: nowISO,

  alert_context: {
    alert_name: alertName,
    alert_time: nowISO,
    alert_type: alertData.alertType || 'price',
    trigger_price: alertData.triggerPrice || null,
    current_price: alertData.currentPrice || null,
    raw_data: alertData,
  },

  coin: {
    symbol: COIN,
    cycle_dir: cycleDir,
  },

  positions: {
    file: `active/${cycleDir}/positions.json`,
    synced_at: nowISO,
    current_count: positionsCount,
    has_existing: positionsCount > 0,
  },

  data_collected: {
    contract: {
      status: contractOk ? 'success' : 'failed',
      data_file: `data/${instantDataFile}`,
      source: 'OKX API (即时获取)',
      generated_at: nowISO,
    },
    sentiment_media: {
      file: `active/${cycleDir}/data-context/sentiment-media.md`,
      status: mediaExists ? 'reused' : 'missing',
      note: '复用周期创建时数据',
    },
    sentiment_onchain: {
      file: `active/${cycleDir}/data-context/sentiment-onchain.md`,
      status: onchainExists ? 'reused' : 'missing',
      note: '复用周期创建时数据',
    },
  },

  history_reports: {
    coin: COIN,
    reports: reportPaths.slice(0, 5).map(rp => {
      const parts = rp.split('/');
      return { path: rp, cycle_id: parts[1] || '', date: dateFormatted };
    }),
    total_count: reportPaths.length,
  },

  next_stage: {
    task_file: 'tasks/alt-pipeline/alt-intel-stage2.live.md',
    spawn_instruction: '阶段一即时数据获取已完成，请读取 data-manifest 开始阶段二交叉验证分析。',
  },
};

// 写入 manifest 文件
const manifestDir = path.join(activeDir, cycleDir, 'data-context');
if (!fs.existsSync(manifestDir)) {
  fs.mkdirSync(manifestDir, { recursive: true });
}

const manifestFile = `data-manifest-instant-${COIN}-${dateStr}-${timeStr}.json`;
const manifestPath = path.join(manifestDir, manifestFile);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

log(`数据清单已生成: data-context/${manifestFile}`);

// ════════════════════════════════════════════
// 步骤 7: 记录阶段结束
// ════════════════════════════════════════════
log(`========== 阶段一结束 ==========`);

output({
  status: 'success',
  coin: COIN,
  cycle_dir: cycleDir,
  positions_count: positionsCount,
  contract_ok: contractOk,
  media_reused: mediaExists,
  onchain_reused: onchainExists,
  report_count: reportPaths.length,
  manifest_file: manifestPath,
});

// ════════════════════════════════════════════
// 步骤 7.5: 合约数据必须性检查
// ════════════════════════════════════════════
if (REQUIRE_CONTRACT && !contractOk) {
  log('⛔ ERROR: REQUIRE_CONTRACT=1 且合约数据获取失败，终止流程，不派发阶段二', 'ERROR');
  output({ status: 'error', coin: COIN, reason: '合约数据获取失败（强制模式）', contract_ok: false });
  process.exit(1);
}

// ════════════════════════════════════════════
// 步骤 8: 通过调度器派发阶段二分析任务
// ════════════════════════════════════════════

const stage2Message = `[警报触发即时分析]
币种: ${COIN}
周期目录: active/${cycleDir}
数据清单: ${manifestPath}
持仓数: ${positionsCount}
合约数据: ${contractOk ? 'OK' : 'FAILED'}

警报上下文:
${JSON.stringify(alertData, null, 2)}

请读取 tasks/alt-pipeline/alt-intel-stage2.live.md 执行交叉验证分析。`;

const jobName = `alt-instant-${COIN}-${Date.now()}`;

// 从警报数据中读取优先级，默认 high-1（后续警报引擎补充 priority 字段后自动分流）
const instantPriority = alertData.priority || 'high-1';

// 写消息到临时文件
const msgFile = `/tmp/dispatch-msg-${jobName}.txt`;
fs.writeFileSync(msgFile, stage2Message, 'utf8');

const dispatchScript = path.join(WORKSPACE, 'scripts', 'dispatch.js');

let dispatched = false;
try {
  execSync(
    `node "${dispatchScript}" --priority "${instantPriority}" --source instant --coin "${COIN}" --name "${jobName}" --at "1m" --message-file "${msgFile}"`,
    { encoding: 'utf8', timeout: 15000 }
  );
  log(`阶段二分析任务已提交调度器: ${jobName} (priority=${instantPriority})`);
  dispatched = true;
} catch (e) {
  log(`调度器提交失败: ${e.message}`, 'WARN');
}

// 清理临时文件
try { fs.unlinkSync(msgFile); } catch (_) {}

// 降级直连
if (!dispatched && process.env.DISPATCHER_FALLBACK === '1') {
  try {
    execSync(
      `openclaw cron add --name "${jobName}" --agent july --at "1m" --message '${stage2Message.replace(/'/g, "'\\''")}' --session isolated --delete-after-run --no-deliver`,
      { encoding: 'utf8', timeout: 10000 }
    );
    log(`阶段二分析任务已降级直连: ${jobName}`);
  } catch (e2) {
    log(`阶段二任务派发失败（直连也失败）: ${e2.message}`, 'ERROR');
  }
}

log(`========== 即时分析启动完成 ==========`);
