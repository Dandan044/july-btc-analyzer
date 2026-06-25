#!/usr/bin/env node
/**
 * data-monitor.js — 实盘数据层 + 仓位变动监控
 *
 * 职责:
 *   1. 每 5s 轮询 live 账户仓位 + algo 订单
 *   2. 写入 okx-positions-cache.json（供 Dashboard + mirror-bot 读取）
 *   3. 比对持仓快照，检测仓位减少/归零
 *   4. 通过 fills 记录判别来源（模型操作 vs 外部事件）
 *   5. 外部事件触发：即时分析或自动归档
 *
 * PM2 常驻。日志: logs/data-monitor.log
 *
 * 判别逻辑:
 *   tag="CLI"      → stage3 swap close → 模型操作 → SKIP
 *   clOrdId=O...   → algo 触发 (OCO/trail) → 外部事件 → TRIGGER
 *   都没有          → Web/App 外部平仓 → TRIGGER
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const DISPATCH = path.join(WORKSPACE, 'scripts', 'dispatch.js');
const ARCHIVE_SCRIPT = path.join(WORKSPACE, 'scripts', 'archive-cycle.js');
const ARCHIVE_RULES = path.join(WORKSPACE, 'scripts', 'archive-rules.js');
const SHARED_CACHE = path.join(WORKSPACE, 'data', 'okx-positions-cache.json');
const STATE_FILE = path.join(WORKSPACE, 'data', 'data-monitor-snapshot.json');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'data-monitor.log');

const POLL_MS = 5000;
const DEDUP_MS = 5 * 60 * 1000; // 同币种同事件 5min 防抖
const FILLS_WINDOW_MS = 30000;   // fills 回溯窗口
const OCO_CHECK_COOLDOWN = 30 * 60 * 1000; // 缺OCO检查 30min 冷却
const STARTUP_GRACE_MS = 10000;  // 启动后 10s 内跳过 OCO/回撤检查
const NEW_POS_OCO_GRACE_MS = 60_000; // 新仓位 OCO 宽限 60s（等 stage3 设完 TP/SL）
const HEARTBEAT_TICKS = 60;     // 每 60 tick（5min）打印一次健康摘要

// PnL 阈值触发级别（百分比）
const PNL_THRESHOLDS = [-100, -50, 50, 100];
// 阈值重置滞后带：触发过阈值后，需要PnL回退超过此带才能重新触发
const PNL_HYSTERESIS = 10; // 10% 滞后

// ═══ 账户熔断断路器 ═══
const CB_THRESHOLD_PCT = 10;                    // ±10% 触发阈值
const CB_WINDOW_MS = 24 * 3600 * 1000;          // 24h 滚动窗口
const CB_MIN_AGE_MS = 1 * 3600 * 1000;          // 最少 1h 数据才触发（防启动误触）
const CB_COOLDOWN_MS = 24 * 3600 * 1000;        // 触发后 24h 冷却
const CB_SNAPSHOT_KEEP_COUNT = 576;             // 内存最多保留快照数（24h/5s≈17280, 实际按每分钟~1条存, 取576=24h×24条/h）
const CB_PERSIST_SAMPLE_MS = 5 * 60 * 1000;     // 持久化抽样间隔: 每 5min 存一条
const DASHBOARD_RESET_URL = 'http://127.0.0.1:3100/api/emergency-reset';

// ═══ 心跳统计（模块级，供各函数累加） ═══
let heartbeatStats = { newPositions: 0, ocoGaps: 0, pnlTriggers: 0, drawdowns: 0, positionReduced: 0, archives: 0, skippedCli: 0 };
function resetHeartbeatStats() {
  heartbeatStats = { newPositions: 0, ocoGaps: 0, pnlTriggers: 0, drawdowns: 0, positionReduced: 0, archives: 0, skippedCli: 0 };
}

// ═══ 日志 ═══
function log(msg, level = 'INFO') {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const prefix = level === 'WARN' ? '⚠️ ' : (level === 'ERROR' ? '⛔ ' : '');
  const line = `[${ts}] [data-monitor] ${prefix}${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ═══ OKX CLI ═══
function okxJson(args, timeoutMs = 15000) {
  const cmd = `bash "${PROXY}" --profile live ${args} --json 2>/dev/null`;
  try {
    const raw = execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[]') return [];
    let jsonStart = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '[' || trimmed[i] === '{') { jsonStart = i; break; }
    }
    if (jsonStart < 0) return [];
    return JSON.parse(trimmed.slice(jsonStart));
  } catch (e) {
    throw new Error(`OKX CLI 失败: ${e.message}`);
  }
}

// ═══ 获取全账户权益（USD） ═══
function getAccountBalance() {
  try {
    const data = okxJson('account balance', 15000);
    if (!data) return null;
    const details = data.details || data[0]?.details || [];
    let totalEqUsd = 0;
    for (const d of details) {
      totalEqUsd += parseFloat(d.eqUsd) || 0;
    }
    return Math.round(totalEqUsd * 100) / 100;
  } catch (e) {
    log(`获取账户余额失败: ${e.message}`, 'WARN');
    return null;
  }
}

// ═══ 状态读写 ═══
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // 确保熔断器字段存在
      if (!state.circuitBreaker) state.circuitBreaker = { balanceHistory: [], lastTriggeredAt: null, triggerCount: 0 };
      if (!state.newPositionGraces) state.newPositionGraces = {};
      return state;
    }
  } catch (_) {}
  return { prevPositions: {}, lastTriggers: {}, newPositionGraces: {}, circuitBreaker: { balanceHistory: [], lastTriggeredAt: null, triggerCount: 0 } };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // 只保留核心字段，不存巨型 fills 列表
  // circuitBreaker.balanceHistory 做抽样压缩：只保留每 CB_PERSIST_SAMPLE_MS 一条
  const cb = state.circuitBreaker || {};
  const fullHistory = cb.balanceHistory || [];
  const sampledHistory = [];
  let lastPersistedTs = 0;
  for (const entry of fullHistory) {
    if (entry.ts - lastPersistedTs >= CB_PERSIST_SAMPLE_MS || sampledHistory.length === 0) {
      sampledHistory.push(entry);
      lastPersistedTs = entry.ts;
    }
  }

  const compact = {
    prevPositions: state.prevPositions,
    lastTriggers: state.lastTriggers,
    pnlTriggers: state.pnlTriggers || {},
    pnlPeaks: state.pnlPeaks || {},
    ocoCooldowns: state.ocoCooldowns || {},
    drawdownFired: state.drawdownFired || {},
    newPositionGraces: state.newPositionGraces || {},
    startupAt: state.startupAt,
    circuitBreaker: {
      balanceHistory: sampledHistory,
      lastTriggeredAt: cb.lastTriggeredAt || null,
      triggerCount: cb.triggerCount || 0,
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(compact, null, 2), 'utf8');
}

// ═══ 构建仓位快照（key=instId_posSide → pos） ═══
function buildPosMap(positions) {
  const map = {};
  for (const p of positions) {
    const instId = p.instId;
    const posSide = p.posSide || 'net';
    const pos = parseFloat(p.pos || 0);
    if (pos === 0) continue;
    map[`${instId}_${posSide}`] = pos;
  }
  return map;
}

// ═══ 提取币种名 ═══
function coinFromInstId(instId) {
  return (instId || '').replace('-USDT-SWAP', '');
}

// ═══ 分类 fills ═══
function classifyFills(fills, coin, sinceMs) {
  const instId = `${coin}-USDT-SWAP`;
  const relevant = fills.filter(f => {
    if (f.instId !== instId) return false;
    const ft = parseInt(f.fillTime || 0);
    return ft >= sinceMs;
  });

  if (relevant.length === 0) {
    return { verdict: 'uncertain', reason: 'no recent fills' };
  }

  const hasCliTag = relevant.some(f => f.tag === 'CLI');
  const hasOClOrdId = relevant.some(f => f.clOrdId && f.clOrdId.startsWith('O'));
  const hasNoMarker = relevant.some(f => !f.tag && (!f.clOrdId || f.clOrdId === ''));

  if (hasCliTag) {
    return { verdict: 'skip', reason: 'model close (tag=CLI)', fills: relevant.length };
  }
  if (hasOClOrdId) {
    return { verdict: 'trigger', reason: 'algo triggered (clOrdId=O...)', fills: relevant.length };
  }
  if (hasNoMarker) {
    return { verdict: 'trigger', reason: 'external close (no markers)', fills: relevant.length };
  }
  return { verdict: 'uncertain', reason: 'unrecognized pattern', fills: relevant.length };
}

// ═══ 查找活跃周期 ═══
function findActiveCycle(coin) {
  const activeDir = path.join(WORKSPACE, 'active');
  try {
    const dirs = fs.readdirSync(activeDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    // 匹配 alt-{COIN}-* 或 zhuang-{COIN}-*
    const prefix = `alt-${coin}-`;
    const zhuangPrefix = `zhuang-${coin}-`;
    const mwPrefix = `mw-${coin}-`;
    const matches = dirs.filter(d => d.startsWith(prefix) || d.startsWith(zhuangPrefix) || d.startsWith(mwPrefix));
    if (matches.length === 0) return null;
    // 返回最新的
    matches.sort((a, b) => {
      try {
        return fs.statSync(path.join(activeDir, b)).mtimeMs - fs.statSync(path.join(activeDir, a)).mtimeMs;
      } catch { return 0; }
    });
    return matches[0];
  } catch { return null; }
}

// ═══ 归档周期 ═══
function archiveCycle(coin, cycleId) {
  log(`📦 ARCHIVE: ${coin} 仓位归零 → 归档 ${cycleId}`);
  try {
    const cmd = `node "${ARCHIVE_SCRIPT}" --cycle ${cycleId}`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    log(`  archive-cycle: ${out.trim().slice(0, 200)}`);

    // 规则清零
    try {
      const rulesCmd = `node "${ARCHIVE_RULES}" --coin ${coin} --by cycle-archived --reason "data-monitor: ${coin}仓位归零自动归档"`;
      execSync(rulesCmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      log(`  规则已清零: ${coin}`);
    } catch (e) {
      log(`  规则清零失败: ${e.message}`, 'WARN');
    }

    // 复盘 cron
    createReviewCron(coin, cycleId);
    return true;
  } catch (e) {
    log(`  归档失败: ${e.message}`, 'ERROR');
    return false;
  }
}

// ═══ 创建复盘 cron ═══
function createReviewCron(coin, cycleId) {
  try {
    const reviewAt = execSync('date -d "+24 hours" --iso-8601=seconds', { encoding: 'utf8', timeout: 5000 }).trim();
    const nowIso = new Date(Date.now() + 8 * 3600000).toISOString();
    const reviewMsg = `周期路径: archived/${cycleId}\n币种: ${coin}\n归档时间: ${nowIso}\n请读取 tasks/trade-review.md 对该周期执行独立深度复盘。`;
    const msgFile = `/tmp/dm-review-${cycleId}.txt`;
    fs.writeFileSync(msgFile, reviewMsg, 'utf8');

    const cmd = `node "${DISPATCH}" --priority "low-2" --source "data-monitor" --coin "${coin}" --name "review-${cycleId}" --at "${reviewAt}" --message-file "${msgFile}"`;
    execSync(cmd, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    log(`  📋 复盘cron已提交: review-${cycleId} → ${reviewAt}`);
    try { fs.unlinkSync(msgFile); } catch (_) {}
  } catch (e) {
    log(`  复盘cron提交失败: ${e.message}`, 'WARN');
  }
}

// ═══ 计算 PnL 百分比 ═══
function calcPnlPercent(position) {
  // 直接用 OKX 返回的 uplRatio，避免逐仓模式下 margin 分母偏大导致 PnL 被稀释
  const uplRatio = parseFloat(position.uplRatio || 0);
  return uplRatio * 100;
}

// ═══ 检查 algo 订单的 SL/TP 覆盖 ═══
function checkAlgoCoverage(coin, algoOrders) {
  const instId = `${coin}-USDT-SWAP`;
  const orders = algoOrders.filter(o => o.instId === instId && o.state === 'live');

  let hasSL = false;
  let hasTP = false;

  for (const o of orders) {
    // oco 类型使用 slTriggerPx / tpTriggerPx
    // conditional 类型使用 slOrdPx / tpOrdPx
    const slPx = parseFloat(o.slTriggerPx || o.slOrdPx || -1);
    const tpPx = parseFloat(o.tpTriggerPx || o.tpOrdPx || -1);

    if (slPx > 0) hasSL = true;
    if (tpPx > 0) hasTP = true;

    // move_order_stop (trailing stop) 提供 SL 覆盖
    if (o.ordType === 'move_order_stop') hasSL = true;
  }

  return { hasSL, hasTP, orderCount: orders.length };
}

// ═══ 检查 PnL 阈值触发 ═══
function checkPnlThresholds(coin, pnlPct, state) {
  if (!state.pnlTriggers) state.pnlTriggers = {};
  if (!state.pnlTriggers[coin]) state.pnlTriggers[coin] = {};

  const fired = [];

  for (const threshold of PNL_THRESHOLDS) {
    const key = String(threshold);
    const triggered = state.pnlTriggers[coin][key] || false;

    if (threshold > 0) {
      // 盈利阈值
      if (pnlPct >= threshold && !triggered) {
        state.pnlTriggers[coin][key] = true;
        fired.push({ threshold, pnlPct });
      }
      // 重置：PnL 回落超过滞后带
      if (pnlPct < threshold - PNL_HYSTERESIS && triggered) {
        state.pnlTriggers[coin][key] = false;
      }
    } else {
      // 亏损阈值（-50, -100）
      if (pnlPct <= threshold && !triggered) {
        state.pnlTriggers[coin][key] = true;
        fired.push({ threshold, pnlPct });
      }
      // 重置：PnL 回升超过滞后带
      if (pnlPct > threshold + PNL_HYSTERESIS && triggered) {
        state.pnlTriggers[coin][key] = false;
      }
    }
  }

  return fired;
}

// ═══ 检查 OCO 缺口 ═══
function checkOcoGaps(coin, hasSL, hasTP, state, now) {
  if (!state.ocoCooldowns) state.ocoCooldowns = {};

  const lastCheck = state.ocoCooldowns[coin] || 0;
  if (now - lastCheck < OCO_CHECK_COOLDOWN) return null;

  const gaps = [];
  if (!hasSL) gaps.push('SL');
  if (!hasTP) gaps.push('TP');

  if (gaps.length > 0) {
    state.ocoCooldowns[coin] = now;
    return { missing: gaps };
  }

  // 覆盖完整，更新冷却时间（防止下次立即触发）
  state.ocoCooldowns[coin] = now;
  return null;
}

// ═══ 检查盈利回撤 ═══
function checkDrawdown(coin, pnlPct, state, position) {
  if (!state.pnlPeaks) state.pnlPeaks = {};
  if (!state.drawdownFired) state.drawdownFired = {};

  const prevPeak = state.pnlPeaks[coin] || 0;

  // 更新峰值
  if (pnlPct > prevPeak) {
    state.pnlPeaks[coin] = pnlPct;
    state.drawdownFired[coin] = false; // 新峰值重置回撤触发
  }

  const currentPeak = state.pnlPeaks[coin];

  // 条件：峰值 ≥ 50% 且 当前 PnL ≤ 峰值的 50%（即回撤超过一半）
  if (currentPeak >= 50 && pnlPct <= currentPeak * 0.5 && !state.drawdownFired[coin]) {
    state.drawdownFired[coin] = true;
    return {
      peakPnl: currentPeak,
      currentPnl: pnlPct,
      drawdownPct: currentPeak - pnlPct,
      drawdownRatio: pnlPct > 0 ? (1 - pnlPct / currentPeak) * 100 : 100,
    };
  }

  return null;
}

// ═══ 派发即时分析（非阻塞：spawn 异步派发） ═══
function dispatchInstantAnalysis(coin, reason, context = {}) {
  const reasonLabel = reason === 'position-reduced' ? '📉 仓位减少' :
    reason === 'pnl-threshold' ? '📊 PnL阈值' :
    reason === 'missing-oco' ? '⚠️ 缺OCO保护' :
    reason === 'pnl-drawdown' ? '📉 盈利回撤' : reason;

  log(`🔔 即时分析: ${coin} [${reasonLabel}]`, 'TRIGGER');
  if (context.detail) log(`  └ ${context.detail}`, 'TRIGGER');

  try {
    const { spawn } = require('child_process');
    const stage1Script = path.join(WORKSPACE, 'scripts', 'stage1-instant.js');
    const data = JSON.stringify({
      coin,
      alertName: `data-monitor-${reason}`,
      alertTime: new Date().toISOString(),
      alertType: reason,
      triggerSource: 'data-monitor',
      triggerContext: {
        reason,
        reasonLabel,
        pnlPct: context.pnlPct,
        threshold: context.threshold,
        missingOco: context.missingOco,
        drawdownInfo: context.drawdownInfo,
        detail: context.detail,
      },
    });

    // 非阻塞 spawn：fire-and-forget
    const child = spawn('node', [stage1Script, data], {
      detached: true,
      stdio: 'ignore',
      timeout: 60000,
    });
    child.unref();

    // 异步捕获完成/错误（不影响主循环）
    child.on('close', (code) => {
      if (code === 0) {
        // 静默成功，不写日志（避免刷屏）
      } else {
        log(`  ⚠️ stage1-instant [${coin}] 退出码=${code}`, 'WARN');
      }
    });
    child.on('error', (err) => {
      log(`  ❌ stage1-instant [${coin}] spawn失败: ${err.message}`, 'ERROR');
    });
  } catch (e) {
    log(`  ❌ dispatch [${coin}] 失败: ${e.message}`, 'ERROR');
  }
}

// ═══ 处理仓位变化 ═══
function handlePositionChanges(currentMap, state) {
  const previousMap = state.prevPositions || {};
  const now = Date.now();

  // 找所有变化
  const allKeys = new Set([...Object.keys(previousMap), ...Object.keys(currentMap)]);

  for (const key of allKeys) {
    const prev = previousMap[key] || 0;
    const curr = currentMap[key] || 0;

    if (curr === prev) continue;

    const instId = key.split('_')[0];
    const coin = coinFromInstId(instId);

    // 仓位增加/新出现 → skip
    if (curr > prev) {
      if (prev === 0) {
        log(`🆕 新仓位: ${coin} ${curr}张`);
        heartbeatStats.newPositions++;
        // 设置 OCO 宽限期，等 stage3 完成 SL/TP 设置后再做缺口检查
        if (!state.newPositionGraces) state.newPositionGraces = {};
        state.newPositionGraces[coin] = now + NEW_POS_OCO_GRACE_MS;
        log(`  ⏳ ${coin} OCO宽限至 ${new Date(state.newPositionGraces[coin] + 8*3600000).toISOString().slice(11,19)}`);
      }
      continue;
    }

    // 仓位减少
    const dedupKey = `${coin}_${curr === 0 ? 'gone' : 'reduce'}`;
    const lastTrigger = state.lastTriggers[dedupKey] || 0;
    if (now - lastTrigger < DEDUP_MS) {
      continue; // 防抖
    }

    // 拉 fills 判别来源
    let fills = [];
    try {
      fills = okxJson('swap fills --limit 100', 10000);
    } catch (e) {
      log(`fills 查询失败: ${e.message}`, 'WARN');
    }

    const sinceMs = now - FILLS_WINDOW_MS;
    const classification = classifyFills(fills, coin, sinceMs);

    if (classification.verdict === 'skip') {
      log(`⏭ SKIP: ${coin} ${prev}→${curr}张 | ${classification.reason}`);
      heartbeatStats.skippedCli++;
      continue;
    }

    // TRIGGER
    log(`🔴 TRIGGER: ${coin} ${prev}→${curr}张 | ${classification.reason} | fills=${classification.fills}`);

    state.lastTriggers[dedupKey] = now;

    if (curr === 0) {
      // 仓位归零 → 归档
      heartbeatStats.archives++;
      const cycleId = findActiveCycle(coin);
      if (!cycleId) {
        log(`  ${coin} 无活跃周期，跳过归档`, 'WARN');
        continue;
      }
      archiveCycle(coin, cycleId);
    } else {
      // 仓位减少但未归零 → 即时分析
      heartbeatStats.positionReduced++;
      dispatchInstantAnalysis(coin, 'position-reduced', {
        pnlPct: null,
        detail: `${coin} ${prev}→${curr}张 | ${classification.reason}`,
      });
    }
  }
}

// ═══ 智能触发检查（PnL阈值 / OCO缺口 / 盈利回撤） ═══
function checkSmartTriggers(positions, algoOrders, currentMap, state) {
  const now = Date.now();

  // 启动宽限期：跳过 OCO 和回撤检查，避免重启时批量触发
  const inGrace = state.startupAt && (now - state.startupAt < STARTUP_GRACE_MS);

  // 遍历每个有仓位的币种
  const processedCoins = new Set();

  for (const p of positions) {
    const coin = coinFromInstId(p.instId);
    if (processedCoins.has(coin)) continue;
    processedCoins.add(coin);

    // 检查仓位是否在当前快照中（排除已归零的）
    const key = `${p.instId}_${p.posSide || 'net'}`;
    const currentPos = currentMap[key] || 0;
    if (currentPos === 0) continue;

    const pnlPct = calcPnlPercent(p);

    // ── 1. PnL 阈值触发 ──
    const thresholdHits = checkPnlThresholds(coin, pnlPct, state);
    for (const hit of thresholdHits) {
      heartbeatStats.pnlTriggers++;
      const label = hit.threshold > 0 ? `盈利 +${hit.threshold}%` : `亏损 ${hit.threshold}%`;
      dispatchInstantAnalysis(coin, 'pnl-threshold', {
        pnlPct: hit.pnlPct,
        threshold: hit.threshold,
        detail: `${coin} PnL=${hit.pnlPct.toFixed(1)}% | 触发阈值: ${label}`,
      });
    }

    // ── 2. OCO 缺口检查（启动宽限期 / 新仓位宽限期 / algo查询失败时跳过） ──
    const inNewPosGrace = state.newPositionGraces && state.newPositionGraces[coin] && now < state.newPositionGraces[coin];
    if (!inGrace && !inNewPosGrace && algoOrders !== null) {
      const coverage = checkAlgoCoverage(coin, algoOrders);
      const ocoGap = checkOcoGaps(coin, coverage.hasSL, coverage.hasTP, state, now);
      if (ocoGap) {
        heartbeatStats.ocoGaps++;
        const gapLabel = ocoGap.missing.join('+');
        dispatchInstantAnalysis(coin, 'missing-oco', {
          pnlPct,
          missingOco: ocoGap.missing,
          detail: `${coin} PnL=${pnlPct.toFixed(1)}% | 缺少: ${gapLabel} | 现有订单=${coverage.orderCount} (SL=${coverage.hasSL} TP=${coverage.hasTP})`,
        });
      }
    }

    // ── 3. 盈利回撤检查（启动宽限期内跳过） ──
    if (!inGrace) {
      const dd = checkDrawdown(coin, pnlPct, state, p);
      if (dd) {
        heartbeatStats.drawdowns++;
        dispatchInstantAnalysis(coin, 'pnl-drawdown', {
          pnlPct,
          drawdownInfo: dd,
          detail: `${coin} 峰值PnL=${dd.peakPnl.toFixed(1)}% → 当前=${dd.currentPnl.toFixed(1)}% | 回撤=${dd.drawdownPct.toFixed(1)}个百分点 (${dd.drawdownRatio.toFixed(0)}%)`,
        });
      }
    }
  }
}

// ═══ 账户熔断断路器检查 ═══
function checkCircuitBreaker(state) {
  const now = Date.now();

  // 初始化
  if (!state.circuitBreaker) {
    state.circuitBreaker = { balanceHistory: [], lastTriggeredAt: null, triggerCount: 0 };
  }
  const cb = state.circuitBreaker;
  if (!cb.balanceHistory) cb.balanceHistory = [];

  // ── 冷却检查 ──
  if (cb.lastTriggeredAt && (now - cb.lastTriggeredAt) < CB_COOLDOWN_MS) return;

  // ── 获取当前余额 ──
  const currentBalance = getAccountBalance();
  if (currentBalance === null) return; // API 失败，跳过

  // ── 追加快照 ──
  cb.balanceHistory.push({ ts: now, balance: currentBalance });

  // ── 裁剪 24h 外旧数据 ──
  const cutoff = now - CB_WINDOW_MS;
  cb.balanceHistory = cb.balanceHistory.filter(e => e.ts >= cutoff);

  // ── 限制内存快照数量 ──
  if (cb.balanceHistory.length > CB_SNAPSHOT_KEEP_COUNT) {
    cb.balanceHistory = cb.balanceHistory.slice(-CB_SNAPSHOT_KEEP_COUNT);
  }

  // ── 数据不足检查 ──
  const earliest = cb.balanceHistory[0];
  if (!earliest) return;
  const age = now - earliest.ts;
  if (age < CB_MIN_AGE_MS) return; // 数据不足 1h，不触发

  // ── 检查变化 ──
  const pctChange = ((currentBalance - earliest.balance) / earliest.balance) * 100;
  if (Math.abs(pctChange) < CB_THRESHOLD_PCT) return;

  // ═══ 触发熔断 ═══
  const direction = pctChange >= 0 ? '盈利' : '亏损';
  log(`⛔ 熔断触发 | 24h ${direction} ${Math.abs(pctChange).toFixed(2)}% | 余额 ${earliest.balance} → ${currentBalance} USDT`, 'ERROR');
  log(`⛔ 执行紧急重置: POST ${DASHBOARD_RESET_URL}`, 'ERROR');

  // 调用紧急重置 API
  try {
    const result = execSync(
      `curl -s -X POST --max-time 300 "${DASHBOARD_RESET_URL}" -H "Content-Type: application/json"`,
      { encoding: 'utf8', timeout: 310000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    log(`熔断重置响应: ${result.slice(0, 300)}`, 'ERROR');
  } catch (e) {
    log(`熔断重置调用失败: ${e.message}`, 'ERROR');
  }

  // 重置基线
  cb.balanceHistory = [{ ts: now, balance: currentBalance }];
  cb.lastTriggeredAt = now;
  cb.triggerCount = (cb.triggerCount || 0) + 1;

  log(`⛔ 熔断完成 | 基线已重置 | 累计触发: ${cb.triggerCount} 次`, 'ERROR');
}

// ═══ 熔断进度摘要（供心跳使用） ═══
function getCircuitBreakerSummary(state) {
  const cb = state.circuitBreaker;
  if (!cb || !cb.balanceHistory || cb.balanceHistory.length < 2) return '🛡️待';

  // 冷却中
  const now = Date.now();
  if (cb.lastTriggeredAt && (now - cb.lastTriggeredAt) < CB_COOLDOWN_MS) {
    const cdLeft = Math.ceil((CB_COOLDOWN_MS - (now - cb.lastTriggeredAt)) / 3600000);
    return `🛡️冷${cdLeft}h`;
  }

  // 数据窗口
  const earliest = cb.balanceHistory[0];
  const latest = cb.balanceHistory[cb.balanceHistory.length - 1];
  const pct = ((latest.balance - earliest.balance) / earliest.balance * 100);
  const ageH = ((now - earliest.ts) / 3600000).toFixed(1);
  const bar = Math.min(10, Math.round(Math.abs(pct) / CB_THRESHOLD_PCT * 10));
  const fill = '█'.repeat(bar) + '░'.repeat(10 - bar);
  const sign = pct >= 0 ? '+' : '';

  return `🛡️${sign}${pct.toFixed(1)}% [${fill}]`;
}

// ═══ 主循环 ═══
async function main() {
  log('══════════ data-monitor 启动 ══════════');
  log(`配置: 轮询=${POLL_MS}ms | 防抖=${DEDUP_MS / 60000}min | fills窗口=${FILLS_WINDOW_MS / 1000}s`);

  let state = loadState();
  // 记录本次启动时间（用于宽限期）
  state.startupAt = Date.now();
  log(`状态加载: ${Object.keys(state.prevPositions).length} 个跟踪仓位`);

  // ═══ 心跳统计 ═══
  let tickN = 0;

  const tick = () => {
    tickN++;
    try {
      // 1. 拉 live 仓位
      const positions = okxJson('account positions', 15000);
      const currentMap = buildPosMap(positions);

      // 2. 拉 live algo 订单
      let algoOrders = null;
      try {
        algoOrders = okxJson('swap algo orders', 10000);
      } catch (e) {
        log(`algo orders 查询失败: ${e.message}`, 'WARN');
        // algoOrders 保持 null，OCO 检查会跳过（防空数组误触发 missing-oco）
      }

      // 3. 写共享缓存
      try {
        const cache = {
          ts: Date.now(),
          count: Object.keys(currentMap).length,
          positions,
          algoOrders: algoOrders || [],
          source: 'data-monitor',
        };
        fs.mkdirSync(path.dirname(SHARED_CACHE), { recursive: true });
        fs.writeFileSync(SHARED_CACHE, JSON.stringify(cache, null, 2), 'utf8');
      } catch (e) {
        log(`缓存写入失败: ${e.message}`, 'WARN');
      }

      // 4. 检测仓位变化
      handlePositionChanges(currentMap, state);

      // 5. 保存快照
      state.prevPositions = currentMap;

      // 6. ═══ PnL / OCO / 回撤触发检查 ═══
      checkSmartTriggers(positions, algoOrders, currentMap, state);

      // 7. ═══ 账户熔断断路器检查 ═══
      checkCircuitBreaker(state);

      saveState(state);

      // ═══ 心跳摘要 ═══
      if (tickN % HEARTBEAT_TICKS === 0) {
        const posCount = Object.keys(currentMap).length;
        const ageMin = Math.round((Date.now() - state.startupAt) / 60000);
        const cbSummary = getCircuitBreakerSummary(state);
        const lines = [];
        if (heartbeatStats.newPositions > 0) lines.push(`🆕${heartbeatStats.newPositions}`);
        if (heartbeatStats.ocoGaps > 0) lines.push(`⚠️OCO${heartbeatStats.ocoGaps}`);
        if (heartbeatStats.pnlTriggers > 0) lines.push(`📊PnL${heartbeatStats.pnlTriggers}`);
        if (heartbeatStats.drawdowns > 0) lines.push(`📉回撤${heartbeatStats.drawdowns}`);
        if (heartbeatStats.positionReduced > 0) lines.push(`📉减仓${heartbeatStats.positionReduced}`);
        if (heartbeatStats.archives > 0) lines.push(`📦归档${heartbeatStats.archives}`);
        if (heartbeatStats.skippedCli > 0) lines.push(`⏭CLI${heartbeatStats.skippedCli}`);
        const triggered = lines.length > 0 ? ` | ${lines.join(' ')}` : '';
        log(`💓 心跳 #${tickN} | 运行${ageMin}min | 持仓${posCount} | ${cbSummary}${triggered}`);
        resetHeartbeatStats();
      }
    } catch (e) {
      log(`tick 异常: ${e.message}`, 'ERROR');
    }
  };

  // 首次执行
  tick();

  // 定时轮询
  setInterval(tick, POLL_MS);
  log(`就绪 | 间隔=${POLL_MS}ms`);
}

main().catch(e => {
  log(`启动失败: ${e.message}`, 'ERROR');
  process.exit(1);
});
