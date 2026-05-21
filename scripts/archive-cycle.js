#!/usr/bin/env node
/**
 * 周期归档统一工具 v2
 *
 * 将周期归档的三个步骤统一为一个脚本：
 *   1. 同步实盘平仓盈亏 → 更新 positions.json
 *   2. 归档该周期的所有警报规则
 *   3. 移动周期目录 (active/ → archived/)
 *
 * 盈亏同步原理：
 *   调用 OKX `positions-history` API → 获取该币种最新已平仓记录
 *   从中提取 openAvgPx / closeAvgPx / pnl / fee / uTime
 *   写入 positions.json 的「最近平仓」字段
 *
 * 用法:
 *   # 归档 BTC 周期（默认同步实盘盈亏）
 *   node scripts/archive-cycle.js --cycle cycle-20260518-001
 *
 *   # 归档山寨币周期
 *   node scripts/archive-cycle.js --cycle alt-CHZ-20260519-1304
 *
 *   # 预览（不实际执行）
 *   node scripts/archive-cycle.js --cycle alt-CHZ-20260519-1304 --dry-run
 *
 *   # 强制归档（跳过持仓验证）
 *   node scripts/archive-cycle.js --cycle alt-BOME-20260518-2356 --force
 *
 *   # 跳过规则归档
 *   node scripts/archive-cycle.js --cycle cycle-20260518-001 --no-rules
 *
 *   # 跳过实盘同步（positions.json 已是最新）
 *   node scripts/archive-cycle.js --cycle cycle-20260518-001 --no-sync
 *
 *   # 自定义归档来源和原因
 *   node scripts/archive-cycle.js --cycle alt-CHZ-xxx --by manual --reason "人工触发周期归档"
 *
 *   # 覆盖平仓类型
 *   node scripts/archive-cycle.js --cycle alt-CHZ-xxx --close-type "止盈触发"
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = path.join(__dirname, '..');
const ACTIVE_DIR = path.join(WORKSPACE, 'active');
const ARCHIVED_DIR = path.join(WORKSPACE, 'archived');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'cycle-archive.log');
const ARCHIVE_RULES_SCRIPT = path.join(__dirname, 'archive-rules.js');
const PROXY_SCRIPT = path.join(__dirname, 'okx-proxy.sh');

// ════════════════════════════════════════════════════════════
// 枚举常量
// ════════════════════════════════════════════════════════════

// 规则归档来源（与 archive-rules.js 保持一致）
const VALID_BY = [
  'stage4-cleanup',
  'trigger-fired',
  'cycle-archived',
  'cycle-health-check',
  'manual',
  'lifetime-expired',
];

// 平仓类型枚举
const CLOSE_TYPES = [
  '止损触发',
  '止盈触发',
  '手动平仓',
  '部分止盈',
  '追踪止损',
  '强制平仓',
  '手动归档',
  '价格监控专用',
];

// ============================================================
// 参数解析
// ============================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cycle' && i + 1 < args.length) { opts.cycle = args[++i]; continue; }
    if (a === '--by' && i + 1 < args.length) { opts.by = args[++i]; continue; }
    if (a === '--reason' && i + 1 < args.length) { opts.reason = args[++i]; continue; }
    if (a === '--close-type' && i + 1 < args.length) { opts.closeType = args[++i]; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--force') { opts.force = true; continue; }
    if (a === '--no-sync') { opts.noSync = true; continue; }
    if (a === '--no-rules') { opts.noRules = true; continue; }
    if (a === '--help' || a === '-h') { showHelp(); process.exit(0); }
  }

  return opts;
}

function showHelp() {
  console.log(`
周期归档统一工具 v2
────────────────────
统一执行: 实盘盈亏同步 → 规则归档 → 目录移动

选项:
  --cycle <周期ID>     要归档的周期（必填）
                         BTC:   cycle-YYYYMMDD-NNN
                         山寨:  alt-{COIN}-YYYYMMDD-HHMM

  --by <来源>           规则归档来源枚举（默认: cycle-archived）
                         可选: ${VALID_BY.join(' | ')}

  --reason <原因>        规则归档原因（默认: "{币种}周期归档，警报清零"）

  --close-type <类型>    覆盖平仓类型（默认从 OKX 或 positions.json 读取）
                         常用: ${CLOSE_TYPES.join(' | ')}

  --dry-run             预览模式，不实际执行
  --force               强制归档（跳过持仓验证）
  --no-sync             跳过 OKX 实盘同步（positions.json 已是最新）
  --no-rules            跳过规则归档（规则已单独处理）
  --help, -h            显示帮助

示例:
  # 标准归档（同步盈亏 + 归档规则 + 移动目录）
  node scripts/archive-cycle.js --cycle cycle-20260518-001

  # 预览
  node scripts/archive-cycle.js --cycle alt-CHZ-20260519-1304 --dry-run

  # 强制归档 + 自定义原因
  node scripts/archive-cycle.js --cycle alt-BOME-20260518-2356 --force --close-type "价格监控专用"

  # 手动归档（跳过同步，自定义来源）
  node scripts/archive-cycle.js --cycle alt-DYDX-xxx --no-sync --by manual --reason "人工周期归档"
`);
}

// ============================================================
// 日志
// ============================================================
function timestamp() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg, level) {
  const prefix = level === 'WARN' ? '⚠️  ' :
                 level === 'ERROR' ? '❌ ' :
                 level === 'SUCCESS' ? '✅ ' :
                 level === 'INFO' ? '📋 ' : '';
  const line = `[${timestamp()}] ${prefix}${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ============================================================
// 周期类型检测
// ============================================================
function detectCycleType(cycleId) {
  if (cycleId.startsWith('alt-')) return 'altcoin';
  if (cycleId.startsWith('cycle-')) return 'btc';
  return 'unknown';
}

function extractCoin(cycleId) {
  const type = detectCycleType(cycleId);
  if (type === 'btc') return 'BTC';
  if (type === 'altcoin') {
    const match = cycleId.match(/^alt-([A-Z0-9]+)-\d{8}-\d{4}$/);
    if (match) return match[1];
    const parts = cycleId.split('-');
    if (parts.length >= 2) return parts[1];
  }
  return null;
}

// ============================================================
// OKX API 调用（通过代理，返回 JSON）
// ============================================================
function callOKX(subcommand) {
  const cmd = `bash "${PROXY_SCRIPT}" --profile live --json --env ${subcommand} 2>/dev/null`;
  try {
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
    const parsed = JSON.parse(raw);
    // --env 模式返回 { env, profile, data }
    if (parsed && parsed.data) return parsed.data;
    // 直接数组返回（旧版）
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// 步骤1: 同步仓位 — 从 OKX 实盘获取平仓盈亏
// ============================================================
function syncPositions(cycleDir, cycleId, coin, opts) {
  const positionsFile = path.join(cycleDir, 'positions.json');
  const instId = coin === 'BTC' ? 'BTC-USDT-SWAP' : `${coin}-USDT-SWAP`;

  log(`同步实盘仓位: ${instId}`, 'INFO');

  // ── 1a. 获取当前持仓 ──
  const currentData = callOKX(`account positions --instType SWAP --instId ${instId}`);
  const currentPositions = (currentData || []).filter(p =>
    (p.pos || 0) !== '0' && (parseFloat(p.pos) || 0) > 0
  );

  // ── 1b. 获取已平仓历史（最近 5 条） ──
  const historyData = callOKX(`account positions-history --instType SWAP --instId ${instId} --limit 5`);
  const closedPositions = (historyData || []).filter(p => String(p.type) === '2');

  // ── 1c. 读取现有 positions.json ──
  const existing = fs.existsSync(positionsFile)
    ? JSON.parse(fs.readFileSync(positionsFile, 'utf8'))
    : { '周期ID': cycleId, '币种': coin };

  // ── 1d. 判断平仓类型 ──
  function inferCloseType(histPos) {
    // 优先级: --close-type 参数 > 现有 positions.json > API 推断
    if (opts.closeType) return opts.closeType;

    // 保留现有的平仓类型
    const oldClosed = existing['最近平仓'];
    if (oldClosed && oldClosed['平仓类型'] && oldClosed['平仓类型'] !== 'unknown') {
      return oldClosed['平仓类型'];
    }

    // 从 API 数据推断
    if (histPos.closeOrderAlgo && histPos.closeOrderAlgo.length > 0) {
      const algo = histPos.closeOrderAlgo[0];
      const algoType = algo.ordType || '';
      if (algoType.includes('move_order')) return '追踪止损';
      if (algoType.includes('conditional') || algoType.includes('oco')) {
        // OCO 可能是 TP 或 SL — 按盈亏方向推断
        const pnl = parseFloat(histPos.pnl || 0);
        return pnl >= 0 ? '止盈触发' : '止损触发';
      }
    }

    // 默认: 手动/交易平仓
    return '手动平仓';
  }

  // ── 1e. 构建最近平仓 ──
  let recentlyClosed = existing['最近平仓'] || null;

  // 如果当前无持仓，尝试从 history API 获取最新平仓记录
  if (currentPositions.length === 0 && closedPositions.length > 0) {
    const latest = closedPositions[0];
    const closeTime = latest.uTime;
    const closeTimeStr = new Date(parseInt(closeTime)).toISOString();

    const newClosed = {
      '持仓ID': latest.posId,
      '合约': latest.instId,
      '保证金模式': latest.mgnMode || 'cross',
      '持仓方向': latest.posSide,
      '开仓均价': latest.openAvgPx,
      '平仓价格': latest.closeAvgPx,
      '平仓时间': closeTime,
      '平仓时间ISO': closeTimeStr,
      '平仓类型': inferCloseType(latest),
      '持仓张数': latest.closeTotalPos,
      '盈亏': parseFloat(latest.pnl || 0),
      '盈亏比例': parseFloat(latest.pnlRatio || 0),
      '已实现盈亏': parseFloat(latest.realizedPnl || 0),
      '手续费': parseFloat(latest.fee || 0),
      '资金费': parseFloat(latest.fundingFee || 0),
      '杠杆': parseFloat(latest.lever || 10),
      '来源': 'OKX positions-history API',
    };

    // 如果已有平仓记录且仓位ID相同 → 保留人工写入的信息
    if (recentlyClosed && recentlyClosed['持仓ID'] === latest.posId) {
      newClosed['平仓类型'] = recentlyClosed['平仓类型'] || newClosed['平仓类型'];
      newClosed['备注'] = recentlyClosed['备注'] || '';
    }

    recentlyClosed = newClosed;
    log(`检测到已平仓: ${instId} | 方向=${latest.posSide} | PnL=${latest.pnl} USDT | 类型=${newClosed['平仓类型']}`, 'SUCCESS');
  } else if (currentPositions.length === 0 && closedPositions.length === 0) {
    // 既无当前持仓也无历史平仓 → 可能从未交易
    if (!recentlyClosed) {
      log('无持仓且无平仓历史（非交易周期）', 'INFO');
    }
  }

  // ── 1f. 汇总已实现盈亏 ──
  // 优先用 history API 的 realizedPnl，否则用当前持仓的 realizedPnl
  let totalRealizedPnl = 0;
  if (recentlyClosed && recentlyClosed['已实现盈亏'] !== undefined) {
    totalRealizedPnl = parseFloat(recentlyClosed['已实现盈亏']) || 0;
  }
  // 加上当前持仓的已实现盈亏
  totalRealizedPnl += currentPositions.reduce((sum, p) => sum + parseFloat(p.realizedPnl || 0), 0);

  // ── 1g. 构建更新后的 positions.json ──
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const syncTime = bj.toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');

  const updated = {
    '周期ID': cycleId,
    '币种': coin,
    '同步时间': syncTime,
    '数据来源': 'OKX实盘账户 (archive-cycle sync)',
    '当前持仓': currentPositions.map(pos => ({
      '持仓ID': pos.posId,
      '合约': pos.instId,
      '保证金模式': pos.mgnMode,
      '持仓方向': pos.posSide,
      '持仓张数': pos.pos,
      '可用张数': pos.availPos,
      '名义价值USD': pos.notionalUsd,
      '平均入场价': pos.avgPx,
      '杠杆': pos.lever,
      '保证金': pos.margin || '0',
      '未实现盈亏': pos.upl,
      '盈亏比例': pos.uplRatio,
      '已实现盈亏': pos.realizedPnl,
      '手续费': pos.fee,
      '资金费': pos.fundingFee,
      '强平价': pos.liqPx || '',
      '保本价': pos.bePx,
      '开仓时间': pos.cTime,
      '最后更新': pos.uTime,
      '标记价格': pos.markPx,
      '指数价格': pos.idxPx,
      '最新成交价': pos.last,
      '委托订单': existing['当前持仓']?.find(
        old => old['持仓ID'] === pos.posId
      )?.['委托订单'] || [],
      '操作记录': existing['当前持仓']?.find(
        old => old['持仓ID'] === pos.posId
      )?.['操作记录'] || [],
    })),
    '最近平仓': recentlyClosed,
    '汇总': {
      '当前持仓数': currentPositions.length,
      '未实现盈亏总计': currentPositions.reduce((sum, p) => sum + parseFloat(p.upl || 0), 0),
      '已实现盈亏总计': totalRealizedPnl,
    },
  };

  // 保留备注
  if (existing['备注'] && !updated['备注']) {
    updated['备注'] = existing['备注'];
  }

  if (opts.dryRun) {
    log(`[DRY RUN] 将更新 positions.json | 持仓=${currentPositions.length} | 已实现盈亏=${totalRealizedPnl} USDT`, 'INFO');
  } else {
    fs.writeFileSync(positionsFile, JSON.stringify(updated, null, 2));
    log(`positions.json 已更新 | 持仓=${currentPositions.length} | 已实现盈亏=${totalRealizedPnl} USDT`, 'SUCCESS');
  }

  return true;
}

// ============================================================
// 步骤2: 读取并验证仓位文件
// ============================================================
function readAndValidatePositions(cycleDir, cycleId, opts) {
  const positionsFile = path.join(cycleDir, 'positions.json');

  if (!fs.existsSync(positionsFile)) {
    return { valid: true, reason: '无 positions.json（非交易周期）', pnl: null, hasOpen: false };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(positionsFile, 'utf8'));
  } catch (e) {
    log(`positions.json 解析失败: ${e.message}`, 'ERROR');
    return { valid: false, reason: 'positions.json 解析失败', pnl: null };
  }

  const summary = data['汇总'] || {};
  const currentCount = summary['当前持仓数'] || 0;
  const closedPos = data['最近平仓'] || null;
  const realizedPnl = summary['已实现盈亏总计'] || 0;

  const pnl = {
    currentPositions: currentCount,
    realizedPnl: realizedPnl,
    hasClosed: closedPos !== null,
    closedInfo: closedPos ? {
      direction: closedPos['持仓方向'] || 'unknown',
      entryPrice: closedPos['开仓均价'] || 'N/A',
      exitPrice: closedPos['平仓价格'] || closedPos['平仓价'] || 'N/A',
      profit: closedPos['盈亏'] || 0,
      type: closedPos['平仓类型'] || 'unknown',
      fee: closedPos['手续费'] || 0,
      time: closedPos['平仓时间'] || closedPos['平仓时间ISO'] || 'N/A',
      source: closedPos['来源'] || 'positions.json',
    } : null,
    note: data['备注'] || null,
  };

  // 验证
  if (!opts.force && currentCount > 0) {
    return {
      valid: false,
      reason: `仍有 ${currentCount} 个活跃持仓（需 --force 强制归档）`,
      pnl,
      hasOpen: true,
    };
  }

  return {
    valid: true,
    reason: opts.force ? '强制归档' : 'OK',
    pnl,
    hasOpen: currentCount > 0,
  };
}

// ============================================================
// 步骤3: 归档警报规则
// ============================================================
function archiveRules(cycleId, coin, opts) {
  if (opts.noRules) {
    log('跳过规则归档 (--no-rules)', 'INFO');
    return { success: true, skipped: true, count: 0 };
  }

  const by = opts.by || 'cycle-archived';
  const reason = opts.reason || `${coin}周期归档，警报清零`;

  log(`归档警报规则: ${coin} | by=${by} | reason=${reason}`, 'INFO');

  try {
    const escapedReason = reason.replace(/'/g, "'\\''");
    const cmd = `node "${ARCHIVE_RULES_SCRIPT}" --cycle ${cycleId} --by ${by} --reason '${escapedReason}'`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    console.log(result);

    const archivedMatch = result.match(/已归档:\s*(\d+)/);
    const count = archivedMatch ? parseInt(archivedMatch[1]) : 0;

    return { success: true, skipped: false, count, output: result };
  } catch (err) {
    log(`规则归档失败: ${err.message}`, 'ERROR');
    if (err.stdout) console.log(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    return { success: false, skipped: false, count: 0, error: err.message };
  }
}

// ============================================================
// 步骤4: 移动周期目录
// ============================================================
function moveCycle(cycleId, srcDir, opts) {
  const dstDir = path.join(ARCHIVED_DIR, cycleId);

  // 处理重名
  if (fs.existsSync(dstDir)) {
    const ts = Date.now();
    const newId = `${cycleId}-archived-${ts}`;
    const newDst = path.join(ARCHIVED_DIR, newId);
    log(`目标已存在，使用新名称: ${newId}`, 'WARN');

    if (opts.dryRun) {
      log(`[DRY RUN] mv ${srcDir} → ${newDst}`, 'INFO');
      return { success: true, dstPath: `archived/${newId}`, renamed: true };
    }

    try {
      if (!fs.existsSync(ARCHIVED_DIR)) fs.mkdirSync(ARCHIVED_DIR, { recursive: true });
      fs.renameSync(srcDir, newDst);
      return { success: true, dstPath: `archived/${newId}`, renamed: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (opts.dryRun) {
    log(`[DRY RUN] mv ${srcDir} → ${dstDir}`, 'INFO');
    return { success: true, dstPath: `archived/${cycleId}`, renamed: false };
  }

  try {
    if (!fs.existsSync(ARCHIVED_DIR)) fs.mkdirSync(ARCHIVED_DIR, { recursive: true });
    fs.renameSync(srcDir, dstDir);
    return { success: true, dstPath: `archived/${cycleId}`, renamed: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// 步骤0: 定位周期目录
// ============================================================
function locateCycle(cycleId) {
  const activePath = path.join(ACTIVE_DIR, cycleId);
  const archivedPath = path.join(ARCHIVED_DIR, cycleId);

  if (fs.existsSync(activePath) && fs.statSync(activePath).isDirectory()) {
    return { dir: activePath, status: 'active', path: `active/${cycleId}` };
  }
  if (fs.existsSync(archivedPath) && fs.statSync(archivedPath).isDirectory()) {
    return { dir: archivedPath, status: 'already-archived', path: `archived/${cycleId}` };
  }
  return null;
}

// ============================================================
// 主流程
// ============================================================
function main() {
  const opts = globalThis.opts = parseArgs();

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showHelp();
    return;
  }

  if (!opts.cycle) {
    console.error('❌ 必须指定 --cycle');
    process.exit(1);
  }

  // 参数校验
  if (opts.by && !VALID_BY.includes(opts.by)) {
    console.error(`❌ --by 非法值 "${opts.by}"，合法: ${VALID_BY.join(', ')}`);
    process.exit(1);
  }

  const cycleId = opts.cycle;
  const coin = extractCoin(cycleId);
  const type = detectCycleType(cycleId);

  if (type === 'unknown') {
    console.error(`❌ 无法识别周期类型: "${cycleId}"`);
    console.error('   BTC: cycle-YYYYMMDD-NNN  |  山寨: alt-{COIN}-YYYYMMDD-HHMM');
    process.exit(1);
  }
  if (!coin) {
    console.error(`❌ 无法提取币种: "${cycleId}"`);
    process.exit(1);
  }

  const dryTag = opts.dryRun ? '[DRY RUN] ' : '';
  const typeLabel = type === 'btc' ? 'BTC周期' : `山寨币周期 (${coin})`;
  const by = opts.by || 'cycle-archived';
  const reason = opts.reason || `${coin}周期归档，警报清零`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(` ${dryTag}周期归档: ${cycleId}`);
  console.log(` 类型: ${typeLabel}`);
  console.log(` 币种: ${coin}`);
  console.log(` 来源: ${by}  |  原因: ${reason}`);
  if (opts.closeType) console.log(` 平仓类型覆盖: ${opts.closeType}`);
  console.log(`${'='.repeat(60)}\n`);

  log(`开始 | ${dryTag}周期=${cycleId} 币种=${coin} by=${by} force=${!!opts.force} noRules=${!!opts.noRules} closeType=${opts.closeType || '(auto)'}`);

  // ═══ 步骤0: 定位 ═══
  const cycle = locateCycle(cycleId);
  if (!cycle) {
    console.error(`❌ 周期目录不存在: active/${cycleId} 或 archived/${cycleId}`);
    log(`失败: 目录不存在`, 'ERROR');
    process.exit(1);
  }
  if (cycle.status === 'already-archived') {
    console.log(`⏭️  已在 archived/ 中，跳过`);
    log(`跳过: 已归档`, 'INFO');
    process.exit(0);
  }

  console.log(`📂 路径: ${cycle.path}\n`);

  // ═══ 步骤1: 实盘盈亏同步 ═══
  if (!opts.noSync) {
    console.log(`--- 步骤1: 同步实盘盈亏 (OKX positions-history API) ---`);
    syncPositions(cycle.dir, cycleId, coin, opts);
    console.log();
  } else {
    console.log(`--- 步骤1: 跳过实盘同步 (--no-sync) ---\n`);
  }

  // ═══ 步骤2: 验证 & 盈亏摘要 ═══
  console.log(`--- 步骤2: 验证仓位 & 盈亏摘要 ---`);
  const validation = readAndValidatePositions(cycle.dir, cycleId, opts);

  if (!validation.valid) {
    console.error(`\n❌ ${validation.reason}`);
    if (validation.pnl?.closedInfo) {
      console.log(`⚠️  有平仓记录但仍有活跃持仓。用 --force 强制归档。`);
    }
    log(`中止: ${validation.reason}`, 'ERROR');
    process.exit(1);
  }

  const pnl = validation.pnl;
  if (pnl) {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    if (pnl.closedInfo) {
      const ci = pnl.closedInfo;
      const profitIcon = parseFloat(ci.profit) >= 0 ? '📈' : '📉';
      const profitStr = parseFloat(ci.profit) >= 0 ? `+${ci.profit}` : `${ci.profit}`;
      console.log(`  ║  ${profitIcon} 平仓盈亏: ${profitStr} USDT`);
      console.log(`  ║  方向: ${ci.direction}  |  入场: ${ci.entryPrice}  |  出场: ${ci.exitPrice}`);
      console.log(`  ║  类型: ${ci.type}  |  手续费: ${ci.fee}`);
      console.log(`  ║  数据源: ${ci.source}`);
      if (pnl.note) console.log(`  ║  📝 ${pnl.note}`);
    } else {
      console.log(`  ║  📊 已实现盈亏: ${pnl.realizedPnl} USDT`);
      console.log(`  ║  无平仓记录（非交易周期）`);
      if (pnl.note) console.log(`  ║  📝 ${pnl.note}`);
    }
    if (opts.force && pnl.hasOpen) {
      console.log(`  ║  ⚠️  强制归档（跳过持仓验证）`);
    }
    console.log(`  ╚══════════════════════════════════════╝`);
  }
  console.log();

  // ═══ 步骤3: 规则归档 ═══
  console.log(`--- 步骤3: 归档警报规则 ---`);
  const rulesResult = archiveRules(cycleId, coin, opts);
  if (!rulesResult.success && !opts.dryRun) {
    log(`规则归档失败，继续移动目录`, 'WARN');
  }
  console.log();

  // ═══ 步骤4: 移动目录 ═══
  console.log(`--- 步骤4: 移动周期目录 ---`);
  const moveResult = moveCycle(cycleId, cycle.dir, opts);

  if (!moveResult.success) {
    console.error(`\n❌ 移动失败: ${moveResult.error}`);
    log(`失败: 移动失败 - ${moveResult.error}`, 'ERROR');
    process.exit(1);
  }

  console.log(`   ${cycle.path} → ${moveResult.dstPath}`);
  if (moveResult.renamed) console.log(`   ⚠️  已重命名（避开同名目录）`);
  console.log();

  // ═══ 完成 ═══
  console.log(`${'='.repeat(60)}`);
  console.log(` ${dryTag}✅ 周期归档完成`);
  console.log(`${'='.repeat(60)}`);

  const summary = [
    `周期ID: ${cycleId}`,
    `币种: ${coin}`,
    `新路径: ${moveResult.dstPath}`,
  ];
  if (pnl?.closedInfo) {
    summary.push(`盈亏: ${pnl.closedInfo.profit} USDT (${pnl.closedInfo.type})`);
  }
  if (moveResult.renamed) summary.push('⚠️ 已重命名');
  summary.push(`规则: ${rulesResult.skipped ? '已跳过' : `${rulesResult.count} 个`}`);

  console.log(`\n摘要:`);
  summary.forEach(s => console.log(`  • ${s}`));
  console.log();

  log(`完成 | ${summary.join(' | ')}`);
}

main();
