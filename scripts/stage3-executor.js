#!/usr/bin/env node
/**
 * stage3-executor.js — 山寨币阶段三：仓位执行（全脚本化）
 *
 * 用法: node stage3-executor.js <COIN> <CYCLE_DIR>
 *
 * 输入:
 *   1. reports/trade-decision-{COIN}-*.json（阶段二输出）
 *   2. positions.json（当前持仓）
 *
 * 输出: JSON 到 stdout（最后一行 __STAGE3_OUTPUT__）
 * 日志: 追加到 logs/alt-{COIN}-process.log
 *
 * ⚠️ 步骤 7 操作使用特殊标识: 💰 OPEN / 💰 ADD / 💰 REDUCE / 💰 CLOSE / 💰 ADJUST
 * ⚠️ 归档操作使用标识: 📦 ARCHIVE
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── 参数 ───
const COIN = process.argv[2];
let CYCLE_DIR = process.argv[3];

if (!COIN || !CYCLE_DIR) {
  console.error('用法: node stage3-executor.js <COIN> <CYCLE_DIR>');
  process.exit(1);
}

// 容错：去除可能的 active/ 前缀
CYCLE_DIR = CYCLE_DIR.replace(/^active\//, '');

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', `alt-${COIN}-process.log`);
const CYCLE_PATH = path.join(WORKSPACE, 'active', CYCLE_DIR);
const POSITIONS_FILE = path.join(CYCLE_PATH, 'positions.json');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const INST_ID = `${COIN}-USDT-SWAP`;
const HEDGE_SCRIPT = path.join(WORKSPACE, 'scripts', 'calc-alt-hedge-y.sh');
const SYNC_SCRIPT = path.join(WORKSPACE, 'scripts', 'sync-alt-positions.js');
const ARCHIVE_SCRIPT = path.join(WORKSPACE, 'scripts', 'archive-cycle.js');

// 偏移配置
const TP_SHIFT_PCT = 5;
const SL_SHIFT_PCT = 5;
const MAX_SHIFT_PCT = 20;

// ─── 工具函数 ───
function nowTs() {
  // GMT+8
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level = 'INFO') {
  const ts = nowTs();
  let line;
  if (level === 'WARN') line = `[${ts}] [阶段三] ⚠️ WARN: ${msg}`;
  else if (level === 'ERROR') line = `[${ts}] [阶段三] ⛔ ERROR: ${msg}`;
  else line = `[${ts}] [阶段三] ${msg}`;
  console.error(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function logOp(msg) {
  // 步骤 7 特殊操作日志
  log(msg, 'OP');
}

function output(data) {
  console.log('__STAGE3_OUTPUT__');
  console.log(JSON.stringify(data));
}

function runOkxCmd(args) {
  try {
    // 检查 args 是否已包含 --json
    const jsonFlag = args.includes('--json') ? '' : ' --json';
    const cmd = `bash "${PROXY}" --profile live ${args}${jsonFlag} 2>/dev/null`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
    // 提取 JSON：多行输出，直接解析全部
    const trimmed = out.trim();
    if (!trimmed || trimmed === '[]') return [];
    // 找到第一个 [ 或 { 的位置
    let jsonStart = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '[' || trimmed[i] === '{') {
        jsonStart = i;
        break;
      }
    }
    if (jsonStart < 0) {
      log(`OKX 命令无 JSON 输出: ${args}`, 'ERROR');
      return null;
    }
    const jsonStr = trimmed.slice(jsonStart);
    return JSON.parse(jsonStr);
  } catch (e) {
    log(`OKX 命令异常: ${args} → ${e.message}`, 'ERROR');
    return null;
  }
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function round(v, d = 2) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

// ─── 盈亏比偏移函数 ───
function calcPnlOffset(entry, target, type, direction, tickSz) {
  const tick = num(tickSz) || 0.00001;
  const origDist = Math.abs(target - entry);
  const shiftPct = type === 'tp' ? TP_SHIFT_PCT : SL_SHIFT_PCT;

  let newDist;
  if (type === 'tp') {
    newDist = origDist * (1 - shiftPct / 100);
  } else {
    newDist = origDist * (1 + shiftPct / 100);
  }

  // 约束
  newDist = Math.max(newDist, tick);
  newDist = Math.min(newDist, origDist * (1 + MAX_SHIFT_PCT / 100));

  let newPrice;
  if (direction === 'long') {
    newPrice = type === 'tp' ? entry + newDist : entry - newDist;
  } else {
    newPrice = type === 'tp' ? entry - newDist : entry + newDist;
  }

  // 穿透检查
  if (type === 'tp' && direction === 'long' && newPrice <= entry) newPrice = entry + tick;
  if (type === 'tp' && direction === 'short' && newPrice >= entry) newPrice = entry - tick;

  // 取整到 tick 精度
  if (tick > 0) {
    newPrice = Math.round(newPrice / tick) * tick;
  }

  return round(newPrice, 8);
}

// ─── BTC 趋势识别（正则提取） ───
function extractBtcTrend() {
  try {
    const activeDir = path.join(WORKSPACE, 'active');
    const btcCycles = fs.readdirSync(activeDir)
      .filter(d => d.startsWith('cycle-'))
      .sort()
      .reverse();

    if (btcCycles.length === 0) {
      log('无法定位 BTC 周期，视为 sideways', 'WARN');
      return 'sideways';
    }

    const btcCycle = btcCycles[0];
    const reportsDir = path.join(activeDir, btcCycle, 'reports');
    const reports = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith('btc-report-') && f.endsWith('.md'))
      .sort()
      .reverse();

    if (reports.length === 0) {
      log('BTC 报告不存在，视为 sideways', 'WARN');
      return 'sideways';
    }

    const reportContent = fs.readFileSync(path.join(reportsDir, reports[0]), 'utf8');

    // 从方向判断部分提取趋势
    const bearish = /偏空|做空|下行|利空|空头主导|bearish/i;
    const bullish = /偏多|做多|上行|利多|多头主导|bullish/i;
    const sideways = /震荡|观望|方向不明|信号矛盾|sideways/i;

    // 优先找明确的"方向判断"段落
    const dirMatch = reportContent.match(/(?:方向判断|方向判断[:：]|趋势判断)[:：\s]*([^\n]{5,50})/);
    if (dirMatch) {
      const text = dirMatch[1];
      if (bearish.test(text)) return 'bearish';
      if (bullish.test(text)) return 'bullish';
      if (sideways.test(text)) return 'sideways';
    }

    // 全文扫描
    if (bearish.test(reportContent) && !bullish.test(reportContent)) return 'bearish';
    if (bullish.test(reportContent) && !bearish.test(reportContent)) return 'bullish';
    return 'sideways';
  } catch (e) {
    log(`BTC 趋势识别失败: ${e.message}`, 'WARN');
    return 'sideways';
  }
}

// ════════════════════════════════════════════
// 主入口（异步包装）
// ════════════════════════════════════════════
(async function main() {

// ════════════════════════════════════════════
// 步骤 1: 记录阶段开始
// ════════════════════════════════════════════
log('开始执行 - 仓位管理');

// ════════════════════════════════════════════
// 步骤 2: 读取 trade-decision.json + positions.json
// ════════════════════════════════════════════
const reportsDir = path.join(CYCLE_PATH, 'reports');
let decisionFile = null;

try {
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith(`trade-decision-${COIN}-`) && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(reportsDir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.name);
  if (files.length === 0) {
    log('⛔ ERROR: 未找到 trade-decision JSON 文件', 'ERROR');
    output({ status: 'error', reason: 'no trade-decision json' });
    process.exit(1);
  }
  decisionFile = path.join(reportsDir, files[0]);
} catch (e) {
  log(`决策文件定位失败: ${e.message}`, 'ERROR');
  output({ status: 'error', reason: e.message });
  process.exit(1);
}

let decision;
try {
  decision = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  log(`决策文件读取: ${path.basename(decisionFile)}`);
} catch (e) {
  log(`决策文件解析失败: ${e.message}`, 'ERROR');
  output({ status: 'error', reason: 'decision json parse error' });
  process.exit(1);
}

// 读取持仓
let positionsData = null;
let posCount = 0;
let hasPosition = false;
let positionDirection = null;

try {
  if (fs.existsSync(POSITIONS_FILE)) {
    positionsData = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    posCount = (positionsData['当前持仓'] || []).length;
    hasPosition = posCount > 0;
    if (hasPosition) {
      positionDirection = positionsData['当前持仓'][0]['持仓方向'];
    }
  }
  log(`持仓文件读取: ${posCount} 个仓位 (${hasPosition ? positionDirection : '无持仓'})`);
} catch (e) {
  log(`持仓文件读取失败: ${e.message}`, 'WARN');
}

// ════════════════════════════════════════════
// 步骤 5: 验证操作合理性
// ════════════════════════════════════════════
const { action, direction, entry_condition, nominal_base, stop_loss, take_profit1, take_profit2, tp1_ratio, reject_reason, reduce_ratio, observation_conditions } = decision;

// 验证
let skipExecution = false;
let skipReason = '';
let adjustedAction = action;

if (reject_reason) {
  skipExecution = true;
  skipReason = `阶段二拒绝: ${reject_reason}`;
  log(`操作被阶段二拒绝: ${reject_reason}`);
} else if (!hasPosition && (action === 'reduce' || action === 'close')) {
  skipExecution = true;
  skipReason = '无仓位可操作';
  log('⚠️ 无仓位但建议减仓/平仓，跳过执行', 'WARN');
} else if (!hasPosition && action === 'add') {
  adjustedAction = 'open';
  log('无仓位但建议加仓 → 转为开仓', 'WARN');
} else if (hasPosition && action === 'open' && direction === positionDirection) {
  adjustedAction = 'add';
  log('已有同方向仓位且建议开仓 → 视为加仓', 'WARN');
} else if (hasPosition && action === 'open' && direction !== positionDirection) {
  skipExecution = true;
  skipReason = '方向冲突（已有仓位与开仓方向相反）';
  log('⚠️ 方向冲突，跳过执行', 'WARN');
} else if (action === 'hold' || action === '观望') {
  skipExecution = true;
  skipReason = '观望';
  log('观望，跳过执行');
}

// ════════════════════════════════════════════
// 步骤 6: 执行判断
// ════════════════════════════════════════════
if (!skipExecution && entry_condition !== 'immediate') {
  skipExecution = true;
  skipReason = `等待触发: ${entry_condition}`;
  log(`等待触发条件: ${entry_condition}，跳过执行`);
}

// ════════════════════════════════════════════
// 步骤 6.X: BTC 趋势对冲（仅开仓/加仓）
// ════════════════════════════════════════════
let nominalFinal = nominal_base || 30;

if (!skipExecution && (adjustedAction === 'open' || adjustedAction === 'add')) {
  const btcTrend = extractBtcTrend();

  if (btcTrend !== 'sideways') {
    log(`BTC趋势识别: ${btcTrend}`);

    try {
      const hedgeCmd = `bash "${HEDGE_SCRIPT}" ${COIN} ${direction} ${btcTrend}`;
      const hedgeOut = execSync(hedgeCmd, { encoding: 'utf8', timeout: 15000 });
      const hedgeJson = JSON.parse(hedgeOut);
      const y = hedgeJson.y;
      const isCounter = hedgeJson.is_counter;
      const corr = hedgeJson.corr;

      nominalFinal = Math.round(nominalFinal * y);
      if (nominalFinal < 20) {
        log(`对冲后仓位 ${nominalFinal}u < 20u，终止执行`, 'WARN');
        skipExecution = true;
        skipReason = `对冲后仓位过小 (${nominalFinal}u)`;
      }

      log(`BTC对冲 | ${COIN} dir=${direction} | BTC=${btcTrend} | 逆势=${isCounter ? 'YES' : 'NO'} | corr=${corr} | y=${y} | ${nominal_base}u→${nominalFinal}u`);
    } catch (e) {
      log(`对冲计算失败: ${e.message}，不调整仓位`, 'WARN');
    }
  } else {
    log('BTC趋势: sideways，顺势处理，y=1.0');
  }
}

// ════════════════════════════════════════════
// 步骤 7: 执行仓位操作
// ════════════════════════════════════════════
let executionResult = { action: adjustedAction, executed: !skipExecution };

if (!skipExecution) {
  try {
    await executeTrade(adjustedAction, direction, nominalFinal, stop_loss, take_profit1, take_profit2, tp1_ratio || 50, reduce_ratio, entry_condition);
    executionResult.executed = true;
  } catch (e) {
    log(`仓位执行失败: ${e.message}`, 'ERROR');
    executionResult.executed = false;
    executionResult.error = e.message;
  }
} else {
  log(`操作决策: ${adjustedAction} | 跳过执行 | 原因: ${skipReason}`);
}

// ════════════════════════════════════════════
// 步骤 8: 同步持仓
// ════════════════════════════════════════════
log('持仓同步路由: sync-alt-positions.js');

try {
  const syncCmd = `node "${SYNC_SCRIPT}" ${COIN} ${CYCLE_DIR} "${LOG_FILE}"`;
  const syncOutput = execSync(syncCmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  const syncLines = syncOutput.trim().split('\n');
  for (const line of syncLines.reverse()) {
    if (line.startsWith('{')) {
      const syncResult = JSON.parse(line);
      if (syncResult.sync_status === 'success') {
        const newCount = syncResult.live_positions_count || syncResult.current_positions_count || 0;
        log(`持仓文件已同步: 当前持仓 ${newCount} 个 | 最近平仓: ${syncResult.has_close_record ? '有' : '无'}`);
        executionResult.positions_after_sync = newCount;
      }
      break;
    }
  }
} catch (e) {
  log(`持仓同步失败: ${e.message}`, 'ERROR');
}

// ════════════════════════════════════════════
// 步骤 9: 判断归档
// ════════════════════════════════════════════
let archived = false;

try {
  const posData = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
  const currentCount = posData['汇总']?.['当前持仓数'] || 0;
  const recentClose = posData['最近平仓'];

  if (currentCount === 0 && recentClose !== null) {
    // 📦 ARCHIVE
    log('📦 ARCHIVE: 检测到归档条件（持仓=0, 最近平仓≠null）');

    try {
      const archiveCmd = `node "${ARCHIVE_SCRIPT}" --cycle ${CYCLE_DIR}`;
      const archiveOut = execSync(archiveCmd, { encoding: 'utf8', timeout: 30000 });
      archived = true;
      log(`📦 ARCHIVE: ${CYCLE_DIR} → archived/ | 使用 archive-cycle.js 统一归档`);

      // ─── 创建复盘 cron（24h后触发） ───
      const reviewAt = execSync('date -d "+24 hours" --iso-8601=seconds', { encoding: 'utf8', timeout: 5000 }).trim();
      const reviewDate = execSync('date -d "+24 hours" +%Y%m%d', { encoding: 'utf8', timeout: 5000 }).trim();
      const reviewTime = execSync('date -d "+24 hours" +%H%M', { encoding: 'utf8', timeout: 5000 }).trim();
      const nowIso = new Date(Date.now() + 8 * 3600000).toISOString();

      const reviewMsg = `周期路径: archived/${CYCLE_DIR}\n币种: ${COIN}\n归档时间: ${nowIso}\n请读取 tasks/trade-review.md 对该周期执行独立深度复盘。`;

      execSync(
        `openclaw cron add --name "review-${CYCLE_DIR}" --agent july --at "${reviewAt}" --message '${reviewMsg.replace(/'/g, "'\\''")}' --session isolated --delete-after-run --no-deliver`,
        { encoding: 'utf8', timeout: 10000 }
      );
      log(`📋 复盘cron已创建 | 任务: review-${CYCLE_DIR} | 触发时间: ${reviewAt} | 输出: learnings/review-${COIN}-${reviewDate}-${reviewTime}.md`);
    } catch (e) {
      log(`📦 ARCHIVE 失败: ${e.message}`, 'ERROR');
    }
  } else {
    log(`周期继续 | 当前持仓: ${currentCount} 个 | 状态: active`);
  }
} catch (e) {
  log(`归档判断失败: ${e.message}`, 'ERROR');
}

// ════════════════════════════════════════════
// 步骤 10: 记录阶段结束
// ════════════════════════════════════════════
log('========== 阶段三结束 ==========');

output({
  status: 'success',
  coin: COIN,
  cycle_dir: CYCLE_DIR,
  action: adjustedAction,
  executed: executionResult.executed,
  skip_reason: skipReason || null,
  nominal_base: nominal_base,
  nominal_final: nominalFinal,
  archived: archived,
  pipeline_end: archived,  // 归档时 pipeline_end=true → 不再进入阶段四
  error: executionResult.error || null,
});

// ─── 异步交易执行函数 ───
async function executeTrade(action, direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, reduceRatio) {
  switch (action) {
    case 'open':
      await executeOpen(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio);
      break;
    case 'add':
      await executeAdd(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio);
      break;
    case 'reduce':
      await executeReduce(reduceRatio, stopLoss, tp1, tp2);
      break;
    case 'close':
      await executeClose();
      break;
    case 'adjust':
      await executeAdjust(stopLoss, tp1, tp2, tp1Ratio);
      break;
    default:
      log(`未知操作类型: ${action}`, 'ERROR');
  }
}

// ─── 7.1 开仓 ───
async function executeOpen(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio) {
  logOp(`💰 OPEN: 开仓 | direction=${direction} | nominal=${nominalFinal}u`);

  // 7.1.1 余额检查
  const balance = runOkxCmd('account balance USDT');
  if (!balance || !balance[0] || !balance[0].details || !balance[0].details[0]) {
    throw new Error('获取余额失败');
  }
  const available = num(balance[0].details[0].availBal);
  log(`可用余额: ${available} USDT`);
  if (available < 5) {
    log(`⛔ ERROR: 可用余额不足，需要 ≥ 5 USDT，可用 ${available} USDT`, 'ERROR');
    return;
  }

  // 7.1.2 获取价格和合约信息
  const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
  if (!tickerData || !tickerData[0]) throw new Error('获取价格失败');
  const lastPrice = num(tickerData[0].last);

  // 合约信息需要遍历获取
  const instrumentsRaw = runOkxCmd('market instruments --instType SWAP');
  let contractInfo = null;
  if (instrumentsRaw && Array.isArray(instrumentsRaw)) {
    contractInfo = instrumentsRaw.find(i => i.instId === INST_ID);
  }
  if (!contractInfo) throw new Error('获取合约信息失败');

  const ctVal = num(contractInfo.ctVal);
  const minSz = num(contractInfo.minSz);
  const lotSz = num(contractInfo.lotSz);
  const maxLever = num(contractInfo.lever);
  const tickSz = num(contractInfo.tickSz) || 0.00001;
  const leverActual = Math.min(10, maxLever);

  log(`合约信息: ctVal=${ctVal}, minSz=${minSz}, lotSz=${lotSz}, maxLever=${maxLever}, tickSz=${tickSz}`);

  // 7.1.3 计算张数
  const rawSz = nominalFinal / (lastPrice * ctVal);
  let sz = rawSz;
  if (lotSz > 0) {
    sz = Math.round(rawSz / lotSz) * lotSz;
  }
  sz = round(sz, 4);

  log(`张数计算: ${nominalFinal} / (${lastPrice} × ${ctVal}) = ${rawSz} → 取整 ${sz}`);

  if (sz < minSz) {
    log(`⚠️ WARN: 计算张数 ${sz} < 最小下单张数 ${minSz}，跳过开仓`, 'WARN');
    return;
  }

  const actualNominal = sz * lastPrice * ctVal;
  log(`实际名义价值: ${sz} × ${lastPrice} × ${ctVal} = ${actualNominal} USDT`);

  // 7.1.4 下单
  const side = direction === 'long' ? 'buy' : 'sell';
  const posSide = direction;

  const placeCmd = `swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${sz} --tdMode cross --posSide ${posSide} --lever ${leverActual}`;
  logOp(`💰 OPEN: 下单 → ${placeCmd}`);

  const placeResult = runOkxCmd(placeCmd);
  if (!placeResult) throw new Error('下单失败');

  const ordId = placeResult[0]?.ordId;
  const avgPx = placeResult[0]?.avgPx || lastPrice;
  logOp(`💰 OPEN: 下单成功 | ordId=${ordId} | 成交价=${avgPx} | 张数=${sz}`);

  // 7.1.5 等待确认
  await new Promise(r => setTimeout(r, 2000));
  const posCheck = runOkxCmd(`account positions --instId ${INST_ID} --tdMode cross`);
  if (posCheck && posCheck[0]) {
    logOp(`💰 OPEN: 持仓确认 | 张数=${posCheck[0].pos} | 入场价=${posCheck[0].avgPx}`);
  }

  // 7.1.6 设置止盈止损（含偏移）
  const entryPx = num(avgPx) || lastPrice;
  const slOffset = calcPnlOffset(entryPx, stopLoss, 'sl', direction, tickSz);
  const tp1Offset = calcPnlOffset(entryPx, tp1, 'tp', direction, tickSz);

  logOp(`💰 OPEN: 止盈止损偏移 | SL: ${stopLoss}→${slOffset} | TP1: ${tp1}→${tp1Offset}${tp2 ? ' | TP2: ' + tp2 + '→' + calcPnlOffset(entryPx, tp2, 'tp', direction, tickSz) : ''}`);

  // OCO 下单：止损 + 止盈
  // OKX OCO: 一个算法单同时设置止盈和止损
  const algoCmd = `swap algo place --instId ${INST_ID} --side ${posSide === "long" ? "sell" : "buy"} --ordType oco --posSide ${posSide} --sz ${sz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`;
  logOp(`💰 OPEN: OCO下单 → ${algoCmd}`);

  const algoResult = runOkxCmd(algoCmd);
  if (algoResult) {
    logOp(`💰 OPEN: OCO设置成功 | algoId=${algoResult[0]?.algoId}`);
  } else {
    log('⚠️ OCO 设置失败', 'WARN');
  }

  // 7.1.7 核对
  logOp(`💰 OPEN: 开仓完成 | ${direction} ${sz}张 @ ${entryPx} | SL=${slOffset} | TP1=${tp1Offset}`);
}

// ─── 7.2 加仓 ───
async function executeAdd(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio) {
  logOp(`💰 ADD: 加仓 | direction=${direction} | nominal=${nominalFinal}u`);

  // 获取当前持仓
  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode cross`);
  if (!posData || !posData[0]) throw new Error('获取持仓失败');

  const balance = runOkxCmd('account balance USDT');
  const available = balance?.[0]?.details?.[0] ? num(balance[0].details[0].availBal) : 0;
  if (available < 5) {
    log(`⚠️ WARN: 可用余额不足 (${available} USDT)，跳过加仓`, 'WARN');
    return;
  }

  const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
  const lastPrice = num(tickerData[0].last);

  const instrumentsRaw = runOkxCmd('market instruments --instType SWAP');
  let contractInfo = null;
  if (instrumentsRaw && Array.isArray(instrumentsRaw)) {
    contractInfo = instrumentsRaw.find(i => i.instId === INST_ID);
  }
  if (!contractInfo) throw new Error('获取合约信息失败');

  const ctVal = num(contractInfo.ctVal);
  const minSz = num(contractInfo.minSz);
  const lotSz = num(contractInfo.lotSz);
  const maxLever = num(contractInfo.lever);
  const tickSz = num(contractInfo.tickSz) || 0.00001;
  const leverActual = Math.min(10, maxLever);

  const rawSz = nominalFinal / (lastPrice * ctVal);
  let sz = rawSz;
  if (lotSz > 0) sz = Math.round(rawSz / lotSz) * lotSz;
  sz = round(sz, 4);

  if (sz < minSz) {
    log(`⚠️ WARN: 加仓张数 ${sz} < minSz ${minSz}，跳过`, 'WARN');
    return;
  }

  const side = direction === 'long' ? 'buy' : 'sell';
  const posSide = direction;

  logOp(`💰 ADD: 下单 → ${sz}张`);
  const placeResult = runOkxCmd(`swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${sz} --tdMode cross --posSide ${posSide} --lever ${leverActual}`);
  if (!placeResult) throw new Error('加仓下单失败');

  logOp(`💰 ADD: 下单成功`);
  await new Promise(r => setTimeout(r, 2000));

  // 更新止盈止损：取消旧 + 设新
  const entryPx = lastPrice;
  const slOffset = calcPnlOffset(entryPx, stopLoss, 'sl', direction, tickSz);
  const tp1Offset = calcPnlOffset(entryPx, tp1, 'tp', direction, tickSz);

  logOp(`💰 ADD: 更新止盈止损 | SL→${slOffset} | TP1→${tp1Offset}`);

  const algoCmd = `swap algo place --instId ${INST_ID} --side ${posSide === "long" ? "sell" : "buy"} --ordType oco --posSide ${posSide} --sz ${sz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`;
  runOkxCmd(algoCmd);

  logOp(`💰 ADD: 加仓完成`);
}

// ─── 7.3 减仓 ───
async function executeReduce(reduceRatio, stopLoss, tp1, tp2) {
  logOp(`💰 REDUCE: 减仓 | ratio=${reduceRatio || 50}%`);

  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode cross`);
  if (!posData || !posData[0]) {
    log('⚠️ 无仓位可减仓', 'WARN');
    return;
  }

  const currentSz = num(posData[0].pos);
  const direction = posData[0].posSide;
  const reduceSz = Math.round(currentSz * (reduceRatio || 50) / 100 * 100) / 100;

  if (reduceSz <= 0) {
    log('⚠️ 减仓张数 ≤ 0，跳过', 'WARN');
    return;
  }

  // 反向市价单减仓（不能用 swap close）
  const side = direction === 'long' ? 'sell' : 'buy';
  logOp(`💰 REDUCE: 反向市价单 → ${side} ${reduceSz}张`);

  const placeResult = runOkxCmd(`swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${reduceSz} --tdMode cross --posSide ${direction} --reduceOnly true`);
  if (!placeResult) throw new Error('减仓下单失败');

  logOp(`💰 REDUCE: 减仓成功 | 减 ${reduceSz}张`);
  await new Promise(r => setTimeout(r, 2000));

  // 更新剩余仓位的止盈止损
  if (stopLoss && tp1) {
    const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
    const lastPrice = num(tickerData[0].last);
    const instrumentsRaw = runOkxCmd('market instruments --instType SWAP');
    let contractInfo = null;
    if (instrumentsRaw && Array.isArray(instrumentsRaw)) {
      contractInfo = instrumentsRaw.find(i => i.instId === INST_ID);
    }
    const tickSz = contractInfo ? num(contractInfo.tickSz) || 0.00001 : 0.00001;

    const slOffset = calcPnlOffset(lastPrice, stopLoss, 'sl', direction, tickSz);
    const tp1Offset = calcPnlOffset(lastPrice, tp1, 'tp', direction, tickSz);

    const remainingSz = currentSz - reduceSz;
    if (remainingSz > 0) {
      logOp(`💰 REDUCE: 更新止盈止损（剩余 ${remainingSz}张）| SL→${slOffset} | TP1→${tp1Offset}`);
      runOkxCmd(`swap algo place --instId ${INST_ID} --side ${direction === "long" ? "sell" : "buy"} --ordType oco --posSide ${direction} --sz ${remainingSz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`);
    }
  }

  logOp(`💰 REDUCE: 减仓完成`);
}

// ─── 7.4 平仓 ───
async function executeClose() {
  logOp(`💰 CLOSE: 全平仓位`);

  // 7.4.1 先取消止盈止损
  const algoOrders = runOkxCmd(`swap algo orders --instId ${INST_ID} --tdMode cross`);
  if (algoOrders && algoOrders.length > 0) {
    for (const order of algoOrders) {
      logOp(`💰 CLOSE: 取消算法单 → algoId=${order.algoId}`);
      runOkxCmd(`swap algo cancel --instId ${INST_ID} --algoId ${order.algoId}`);
    }
  }

  // 注：不检查限价委托单——本策略仅使用 OCO 算法单，已在上一步取消

  // 7.4.2 查询当前持仓并反向平仓
  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode cross`);
  if (posData && posData.length > 0) {
    for (const pos of posData) {
      const sz = num(pos.pos);
      const direction = pos.posSide;
      if (sz <= 0) continue;

      const side = direction === 'long' ? 'sell' : 'buy';
      logOp(`💰 CLOSE: 反向市价单 → ${side} ${sz}张 (${direction})`);
      runOkxCmd(`swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${sz} --tdMode cross --posSide ${direction} --reduceOnly true`);
    }
  }

  // 7.4.3 确认
  await new Promise(r => setTimeout(r, 2000));
  const posCheck = runOkxCmd(`account positions --instId ${INST_ID} --tdMode cross`);
  const stillHasPos = posCheck && posCheck.some(p => num(p.pos) > 0);
  logOp(`💰 CLOSE: 平仓确认 | ${stillHasPos ? '仍有仓位' : '已全部平仓'}`);
}

// ─── 7.5 调整止盈止损 ───
async function executeAdjust(stopLoss, tp1, tp2, tp1Ratio) {
  logOp(`💰 ADJUST: 调整止盈止损`);

  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode cross`);
  if (!posData || !posData[0]) {
    log('⚠️ 无仓位可调整止盈止损', 'WARN');
    return;
  }

  const direction = posData[0].posSide;
  const sz = num(posData[0].pos);

  // 7.5.1 获取旧订单
  const algoOrders = runOkxCmd(`swap algo orders --instId ${INST_ID} --tdMode cross`);

  // 7.5.2 取消旧订单
  if (algoOrders && algoOrders.length > 0) {
    for (const order of algoOrders) {
      logOp(`💰 ADJUST: 取消旧算法单 → algoId=${order.algoId}`);
      runOkxCmd(`swap algo cancel --instId ${INST_ID} --algoId ${order.algoId}`);
    }
  }

  // 7.5.3 设新（含偏移）
  const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
  const lastPrice = num(tickerData[0].last);
  const instrumentsRaw = runOkxCmd('market instruments --instType SWAP');
  let contractInfo = null;
  if (instrumentsRaw && Array.isArray(instrumentsRaw)) {
    contractInfo = instrumentsRaw.find(i => i.instId === INST_ID);
  }
  const tickSz = contractInfo ? num(contractInfo.tickSz) || 0.00001 : 0.00001;

  if (stopLoss && tp1) {
    const slOffset = calcPnlOffset(lastPrice, stopLoss, 'sl', direction, tickSz);
    const tp1Offset = calcPnlOffset(lastPrice, tp1, 'tp', direction, tickSz);

    logOp(`💰 ADJUST: 新止盈止损 | SL→${slOffset} | TP1→${tp1Offset}${tp2 ? ' | TP2→' + calcPnlOffset(lastPrice, tp2, 'tp', direction, tickSz) : ''}`);
    runOkxCmd(`swap algo place --instId ${INST_ID} --side ${direction === "long" ? "sell" : "buy"} --ordType oco --posSide ${direction} --sz ${sz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`);
  }

  logOp(`💰 ADJUST: 调整止盈止损完成`);
}

})(); // end main()
