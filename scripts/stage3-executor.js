#!/usr/bin/env node
/**
 * stage3-executor.js - 山寨币/庄币阶段三:仓位执行(全脚本化)
 *
 * 用法: node stage3-executor.js <COIN> <CYCLE_DIR> [--profile alt|zhuang]
 *
 * 输入:
 *   1. reports/trade-decision-{COIN}-*.json(阶段二输出)
 *   2. positions.json(当前持仓)
 *
 * 输出: JSON 到 stdout(最后一行 __STAGE3_OUTPUT__)
 * 日志: 追加到 logs/{prefix}-{COIN}-process.log
 *
 * ⚠️ 操作标识: 💰 OPEN(开仓) / 💰 ADD(加仓) / 💰 REDUCE(减仓) / 💰 CLOSE(平仓) / 💰 ADJUST(调盈损)
 * ⚠️ 归档操作: 📦 ARCHIVE
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── 参数 ───
const COIN = process.argv[2];
let CYCLE_DIR = process.argv[3];
const PROFILE = (process.argv.includes('--profile') && process.argv[process.argv.indexOf('--profile') + 1]) || 'alt';
const LOG_PREFIX = PROFILE === 'zhuang' ? 'zhuang' : 'alt';

// ─── 监督者参数 ───
const SUPERVISOR_FLAG = process.argv.includes('--supervisor');

// ═══ 查询 OKX 实盘持仓总数（与 Dashboard 同数据源）═══
function countLivePositions() {
  try {
    const cmd = `bash "${PROXY}" --profile live account positions --json`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[]') return 0;
    const positions = JSON.parse(trimmed);
    // 只统计有实际持仓的（pos != 0）
    return positions.filter(p => parseFloat(p.pos) !== 0).length;
  } catch (_) {
    return -1; // API 失败返回 -1,不跳过监督者（安全回退）
  }
}

if (!COIN || !CYCLE_DIR) {
  console.error('用法: node stage3-executor.js <COIN> <CYCLE_DIR> [--profile alt|zhuang]');
  process.exit(1);
}

// 容错:去除可能的 active/ 前缀
CYCLE_DIR = CYCLE_DIR.replace(/^active\//, '');

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', `${LOG_PREFIX}-${COIN}-process.log`);
const CYCLE_PATH = path.join(WORKSPACE, 'active', CYCLE_DIR);
const POSITIONS_FILE = path.join(CYCLE_PATH, 'positions.json');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const INST_ID = `${COIN}-USDT-SWAP`;
const MARKET_BRIEF_DIR = path.join(WORKSPACE, 'market-brief', 'data');
const COIN_SECTOR_MAP_PATH = path.join(WORKSPACE, 'data', 'coin-sector-map.json');
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';

// ─── 读取杠杆设置（仅作为逐仓上限）───
function readLeverageSetting() {
  try {
    const settingsPath = path.join(WORKSPACE, 'data', 'dashboard-settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return parseInt(settings.leverage) || 10;
    }
  } catch (e) {}
  return 10;
}

// ═══ 从 OKX 仓位档位 API 获取实际 MMR ═══
// ═══ MMR 缓存: 同合约同档位不重复请求 ═══
const _mmrCache = {};

function fetchContractMmr(instId, expectedSz, ctVal, entryPrice) {
  // 缓存键: 合约+档位范围 (tier1 通常覆盖极大范围, 命中率高)
  const cacheKey = instId;
  // 若命中同一合约且张数未跨越档位边界(保守: 只要同一合约就复用)
  if (_mmrCache[cacheKey] !== undefined) return _mmrCache[cacheKey];

  try {
    const instFamily = instId.replace('-USDT-SWAP', '') + '-USDT';
    const url = `https://www.okx.com/api/v5/public/position-tiers?instType=SWAP&tdMode=isolated&instFamily=${instFamily}`;
    const raw = execSync(`curl -s --max-time 5 --proxy "${PROXY_URL}" "${url}"`,
      { encoding: 'utf8', timeout: 8000 });
    const data = JSON.parse(raw);

    if (!data.data || data.data.length === 0) {
      log(`${instId} 仓位档位为空, 回退 MMR=7%`, 'WARN');
      return 0.07;
    }

    const tiers = data.data;
    for (const tier of tiers) {
      const minSz = parseFloat(tier.minSz);
      const maxSz = parseFloat(tier.maxSz);
      if (expectedSz >= minSz && expectedSz <= maxSz) {
        const mmr = parseFloat(tier.mmr);
        const imr = parseFloat(tier.imr);
        _mmrCache[cacheKey] = mmr;
        log(`仓位档位: ${instId} | ${expectedSz}张→tier${tier.tier}(${minSz}-${maxSz}) | MMR=${(mmr*100).toFixed(1)}% IMR=${(imr*100).toFixed(1)}%`);
        return mmr;
      }
    }

    // fallback: last tier
    const lastTier = tiers[tiers.length - 1];
    const mmr = parseFloat(lastTier.mmr);
    _mmrCache[cacheKey] = mmr;
    log(`${instId} ${expectedSz}张超最大档位, 用末档 MMR=${(mmr*100).toFixed(1)}%`, 'WARN');
    return mmr;
  } catch (e) {
    log(`仓位档位获取失败: ${e.message}, 回退 MMR=7%`, 'WARN');
    return 0.07; // 不缓存失败结果, 下次重试
  }
}

// ═══ 逐仓杠杆计算: 强平价 = 止损价 × 1.10 ═══
// 推导:
//   做多: 强平价 = 入场价 × (1 - 1/杠杆 + MMR)
//   做空: 强平价 = 入场价 × (1 + 1/杠杆 - MMR)
//   要求: |强平价 - 入场价| = |止损价 - 入场价| × 1.10
//   解得: 杠杆 = 入场价 / (|入场价 - 止损价| × 1.10 + MMR × 入场价)
//   MMR 保守取 1.0% (最低档 0.5%, 留余量防档位提升)
//   钳制 [面板杠杆, 合约上限], 向下取整
function calcIsolatedLeverage(entryPrice, stopLossPrice, direction, minLever, maxLever, mmr) {
  const e = num(entryPrice);
  const sl = num(stopLossPrice);

  if (e <= 0 || sl <= 0) { log(`逐仓杠杆: 入场/止损无效, 回退面板 ${minLever}x`, 'WARN'); return minLever; }

  const slDist = Math.abs(e - sl);
  if (slDist <= 0) { log(`逐仓杠杆: SL距离=0, 回退面板 ${minLever}x`, 'WARN'); return minLever; }

  const slDistPct = slDist / e * 100;
  const targetLiqDist = slDist * 1.10;
  // 方向特异性: mmr 是按标价比例计算(非线性), 不是按入场价
  const rawLever = direction === 'long'
    ? e / (targetLiqDist * (1 - mmr) + mmr * e)
    : e / (targetLiqDist * (1 + mmr) + mmr * e);
  const lever = Math.max(minLever, Math.min(Math.floor(rawLever), maxLever));

  const actualLiqDistPct = (1 / lever - mmr) * 100;
  log(`逐仓杠杆: 入场=${e} ${direction} | SL距=${round(slDistPct,2)}% → 目标强平距=${round(slDistPct*1.10,2)}% | 杠杆=${lever}x (下限${minLever}, 上限${maxLever}, raw=${rawLever.toFixed(2)}x) | 实际强平距≈${round(actualLiqDistPct,2)}%`);
  return lever;
}

// ═══ 逐仓保证金追加: 仅当杠杆已触上下限、默认强平距仍不足时使用 ═══
// 场景 A: SL 过宽 → 计算杠杆 < 面板下限 → 用面板下限, 差额以追加保证金补齐
// 场景 B: SL 过紧 → 计算杠杆 > 合约上限 → 用合约上限, 差额以追加保证金补齐
// 场景 C: 在范围内 → 杠杆已精确定位, 无需追加
function calcIsolatedMarginExtra(sz, ctVal, entryPrice, stopLossPrice, direction, leverage, mmr) {
  const e = num(entryPrice);
  const sl = num(stopLossPrice);

  if (e <= 0 || sl <= 0) {
    log(`逐仓保证金: 入场/止损无效, 跳过追加`, 'WARN');
    return 0;
  }

  const slDist = Math.abs(e - sl);
  if (slDist <= 0) {
    log(`逐仓保证金: SL距离=0, 跳过追加`, 'WARN');
    return 0;
  }

  // 方向特异性: mmr 按标的物价格的变化而变化
  const requiredMargin = direction === 'long'
    ? sz * ctVal * (slDist * 1.10 * (1 - mmr) + e * mmr)
    : sz * ctVal * (slDist * 1.10 * (1 + mmr) + e * mmr);
  const defaultMargin = sz * ctVal * e / leverage;
  const extra = Math.max(0, requiredMargin - defaultMargin);

  const slDistPct = slDist / e * 100;
  const liqDistPct = slDistPct * 1.10;
  const defaultLiqDistPct = (1 / leverage - mmr) * 100;

  if (extra > 0.01) {
    log(`逐仓保证金: 入场=${e} ${direction} | SL距=${round(slDistPct,2)}% | 默认爆仓距=${round(defaultLiqDistPct,2)}% → 需爆仓距=${round(liqDistPct,2)}% | 默认保证金=${round(defaultMargin,2)}u → 需=${round(requiredMargin,2)}u | 追加=${round(extra,4)}u`);
  } else {
    log(`逐仓保证金: 入场=${e} ${direction} | SL距=${round(slDistPct,2)}% | 默认爆仓距=${round(defaultLiqDistPct,2)}% ≥ 需=${round(liqDistPct,2)}% | 无需追加`);
  }

  return round(extra, 8);
}
// ═══ OKX REST API (保证金调整等 CLI 不支持的操作) ═══
const crypto = require('crypto');

function getOkxApiCreds() {
  try {
    const configPath = path.join(require('os').homedir(), '.okx', 'config.toml');
    if (!fs.existsSync(configPath)) return null;
    const content = fs.readFileSync(configPath, 'utf8');
    let inLive = false;
    let apiKey = '', secretKey = '', passphrase = '';
    for (const line of content.split('\n')) {
      if (line.startsWith('[profiles.')) { inLive = line.includes('.live]') || line === '[profiles.live]'; continue; }
      if (!inLive) continue;
      if (line.startsWith('api_key')) apiKey = line.split('=')[1].trim().replace(/"/g, '');
      if (line.startsWith('secret_key')) secretKey = line.split('=')[1].trim().replace(/"/g, '');
      if (line.startsWith('passphrase')) passphrase = line.split('=')[1].trim().replace(/"/g, '');
    }
    if (!apiKey || !secretKey) return null;
    return { apiKey, secretKey, passphrase };
  } catch (_) { return null; }
}

function okxRestPost(apiPath, bodyObj) {
  const creds = getOkxApiCreds();
  if (!creds) throw new Error('无法读取 OKX API 凭证');
  const timestamp = new Date().toISOString();
  const bodyStr = JSON.stringify(bodyObj);
  const signStr = timestamp + 'POST' + apiPath + bodyStr;
  const sign = crypto.createHmac('sha256', creds.secretKey).update(signStr).digest('base64');
  const proxyUrl = process.env.PROXY_URL || 'http://127.0.0.1:7890';
  const cmd = `curl -s --max-time 15 --proxy "${proxyUrl}" -X POST "https://www.okx.com${apiPath}" -H "OK-ACCESS-KEY: ${creds.apiKey}" -H "OK-ACCESS-SIGN: ${sign}" -H "OK-ACCESS-TIMESTAMP: ${timestamp}" -H "OK-ACCESS-PASSPHRASE: ${creds.passphrase}" -H "Content-Type: application/json" -d '${bodyStr}'`;
  const raw = execSync(cmd, { encoding: 'utf8', timeout: 20000 });
  return JSON.parse(raw);
}

// ═══ 逐仓保证金调整: 追加保证金使强平价 = 止损价 × 1.10 ═══
function adjustIsolatedMargin(sz, ctVal, entryPrice, stopLoss, direction, leverage, instId, posSide, mmr) {
  const extra = calcIsolatedMarginExtra(sz, ctVal, entryPrice, stopLoss, direction, leverage, mmr);
  if (extra <= 0.01) return true; // 默认 10x 爆仓距已足够

  const amt = extra.toFixed(8);
  logOp(`💰 逐仓保证金追加: ${extra.toFixed(4)}u | sz=${sz} ctVal=${ctVal} entry=${entryPrice} SL=${stopLoss} ${direction}`);

  try {
    const result = okxRestPost('/api/v5/account/position/margin-balance', {
      instId,
      posSide,
      type: 'add',
      amt
    });
    if (result.code === '0') {
      logOp(`💰 逐仓保证金追加成功 | amt=${amt}u`);
      return true;
    } else {
      log(`⛔ 保证金追加失败: code=${result.code} msg=${result.msg}`, 'ERROR');
      return false;
    }
  } catch (e) {
    log(`⛔ 保证金追加异常: ${e.message}`, 'ERROR');
    return false;
  }
}

const SYNC_SCRIPT = path.join(WORKSPACE, 'scripts', 'sync-alt-positions.js');
const ARCHIVE_SCRIPT = path.join(WORKSPACE, 'scripts', 'archive-cycle.js');

// 偏移配置
let TP_SHIFT_PCT = 5;  // 默认5%,被 dashboard-settings.json tpShiftPercent 覆盖
let SL_SHIFT_PCT = 5;  // 默认5%,被 dashboard-settings.json slShiftPercent 覆盖
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

function runOkxCmd(args, opts = {}) {
  const { retries = 2, baseDelayMs = 2000, isCritical = false } = opts;
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 检查 args 是否已包含 --json
      const jsonFlag = args.includes('--json') ? '' : ' --json';
      const cmd = `bash "${PROXY}" --profile live ${args}${jsonFlag} 2>/dev/null`;
      const out = execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
      // 提取 JSON:多行输出,直接解析全部
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
        if (attempt < maxAttempts) {
          const delay = baseDelayMs * attempt;
          log(`重试 ${attempt}/${retries}: ${delay}ms 后重试...`);
          execSync(`sleep ${delay / 1000}`);
          continue;
        }
        return null;
      }
      const jsonStr = trimmed.slice(jsonStart);
      return JSON.parse(jsonStr);
    } catch (e) {
      const isNetworkError = e.message?.includes('ETIMEDOUT') || e.message?.includes('ECONNRESET')
        || e.message?.includes('ENOTFOUND') || e.message?.includes('ECONNREFUSED')
        || e.message?.includes('signal SIGTERM') || e.message?.includes('timed out')
        || e.message?.includes('EPIPE') || e.message?.includes('socket hang up');

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;
        const reason = isNetworkError ? '网络错误' : '解析/执行错误';
        log(`OKX ${reason} (${attempt}/${retries}): ${args} → ${e.message},${delay}ms 后重试...`, 'WARN');
        execSync(`sleep ${delay / 1000}`);
        continue;
      }

      log(`OKX 命令最终失败 (${maxAttempts}次): ${args} → ${e.message}`, 'ERROR');
      return null;
    }
  }
  return null;
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function round(v, d = 2) {
  // Number#toFixed 比 Math.round(v * 10^d)/10^d 更可靠,能消除浮点精度残留
  // 如 round(5.3100000000000005, 4) → 5.31
  return Number(Number(v).toFixed(d));
}

// ─── 从旧 OCO 算法单中提取 SL/TP 价格(兜底用) ───
function extractOcoPrices(algos) {
  // 返回 { slPrice, tp1Price, tp2Price }
  let slPrice = null;
  const tpPrices = [];
  if (!algos || !Array.isArray(algos)) return { slPrice, tp1Price: null, tp2Price: null };

  for (const order of algos) {
    if (order.ordType !== 'oco') continue;
    const sl = parseFloat(order.slTriggerPx);
    const tp = parseFloat(order.tpTriggerPx);
    if (!isNaN(sl) && sl > 0) slPrice = sl;
    if (!isNaN(tp) && tp > 0) tpPrices.push(tp);
  }

  // 去重
  const seen = new Set();
  const uniqueTps = [];
  for (const p of tpPrices) {
    const key = round(p, 8).toString();
    if (!seen.has(key)) { seen.add(key); uniqueTps.push(p); }
  }
  uniqueTps.sort((a, b) => a - b);

  return {
    slPrice,
    tp1Price: uniqueTps[0] || null,
    tp2Price: uniqueTps[1] || null,
  };
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

// ═══ 板块映射 ═══
let coinSectorMap = null;

function loadSectorMap() {
  if (coinSectorMap) return coinSectorMap;
  try {
    coinSectorMap = JSON.parse(fs.readFileSync(COIN_SECTOR_MAP_PATH, 'utf8'));
    return coinSectorMap;
  } catch (e) {
    log(`板块映射文件加载失败: ${e.message}`, 'WARN');
    return {};
  }
}

function lookupSector(coin) {
  return loadSectorMap()[coin] || null;
}

// ═══ 市场快报读取 ═══
function readMarketBrief() {
  try {
    if (!fs.existsSync(MARKET_BRIEF_DIR)) {
      log('市场快报目录不存在,回退 y=1.0', 'WARN');
      return null;
    }
    const files = fs.readdirSync(MARKET_BRIEF_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) {
      log('市场快报数据为空,回退 y=1.0', 'WARN');
      return null;
    }
    const raw = fs.readFileSync(path.join(MARKET_BRIEF_DIR, files[0]), 'utf8');
    const brief = JSON.parse(raw);
    log(`市场快报读取: ${files[0]} | 评分=${brief.market_state?.score} | 板块数=${(brief.sectors || []).length}`);
    return brief;
  } catch (e) {
    log(`市场快报读取失败: ${e.message},回退 y=1.0`, 'WARN');
    return null;
  }
}

// ═══ BTC 跟踪度计算(Pearson 相关系数) ═══
function getKlineCloses(coinSymbol) {
  const instId = `${coinSymbol}-USDT-SWAP`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=15m&limit=24`;
  try {
    const raw = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`,
      { encoding: 'utf8', timeout: 20000 });
    const data = JSON.parse(raw);
    if (!data.data || data.data.length === 0) return null;
    return data.data.map(c => parseFloat(c[4])).reverse();
  } catch (e) {
    return null;
  }
}

function pearsonR(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return null;
  const sliceX = xs.slice(-n), sliceY = ys.slice(-n);
  const meanX = sliceX.reduce((a, b) => a + b, 0) / n;
  const meanY = sliceY.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = sliceX[i] - meanX, dy = sliceY[i] - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  return varX === 0 || varY === 0 ? 0 : cov / Math.sqrt(varX * varY);
}

function computeBtcCorrelation(coinSymbol) {
  const btcCloses = getKlineCloses('BTC');
  const altCloses = getKlineCloses(coinSymbol);
  if (!btcCloses || !altCloses) return null;
  return pearsonR(btcCloses, altCloses);
}

// ════════════════════════════════════════════
// 工具: 取消该合约所有挂单（算法单 + 普通单）
// ════════════════════════════════════════════
function cancelAllOrders(instId) {
  try {
    // 1. 取消算法单（OCO / 追踪止损等）
    const algoOrders = runOkxCmd(`swap algo orders --instId ${instId} --tdMode isolated`);
    if (algoOrders && Array.isArray(algoOrders) && algoOrders.length > 0) {
      for (const order of algoOrders) {
        logOp(`🧹 取消算法单 → algoId=${order.algoId} type=${order.algoType || order.ordType || '?'}`);
        runOkxCmd(`swap algo cancel --instId ${instId} --algoId ${order.algoId}`, { retries: 2 });
      }
    }
    // 2. 取消普通挂单（限价单、条件单等）
    const pendingOrders = runOkxCmd(`swap orders pending --instId ${instId}`);
    if (pendingOrders && Array.isArray(pendingOrders) && pendingOrders.length > 0) {
      for (const order of pendingOrders) {
        logOp(`🧹 取消挂单 → ordId=${order.ordId} type=${order.ordType || '?'}`);
        runOkxCmd(`swap cancel --instId ${instId} --ordId ${order.ordId}`, { retries: 2 });
      }
    }
    logOp(`🧹 委托清理完成: ${instId}`);
  } catch (e) {
    log(`🧹 委托清理异常: ${e.message}`, 'WARN');
  }
}

// ════════════════════════════════════════════
// 主入口(异步包装)
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
const { action, direction, entry_mode, entry_condition, nominal_base, head_ratio, stop_loss, take_profit1, take_profit2, tp1_ratio, trailing_callback_ratio, reject_reason, reduce_ratio, observation_conditions } = decision;
const isHeadMode = (entry_mode === 'head');

// ═══ 挂单开仓参数(已废弃 — 仅保留市价单) ═══
// ═══ BEGIN COMMENTED: limit/conditional ═══
/*
const orderType = decision.order_type || 'market';           // "market" | "limit" | "conditional"
const limitPrice = decision.limit_price || null;             // 限价单的挂单价
const triggerPrice = decision.trigger_price || null;         // 条件单的触发价

if (orderType !== 'market' && orderType !== 'limit' && orderType !== 'conditional') {
  log(`⚠️ 未知 order_type: ${orderType},回退为 market`, 'WARN');
}

// ═══ 条件单触发参数自动推导 ═══
// 根据 direction + trigger_price vs last_price 自动判断使用 slTriggerPx 还是 tpTriggerPx
// long+trigger>last → slTriggerPx (突破追多)   long+trigger<last → tpTriggerPx (抄底)
// short+trigger>last → tpTriggerPx (高位做空)  short+trigger<last → slTriggerPx (追空)
function getConditionalTriggerParams(direction, triggerPx, lastPx) {
  if (direction === 'long') {
    if (triggerPx > lastPx) {
      return { field: 'slTriggerPx', ordField: 'slOrdPx', intent: '突破追多' };
    } else {
      return { field: 'tpTriggerPx', ordField: 'tpOrdPx', intent: '抄底做多' };
    }
  } else {
    if (triggerPx > lastPx) {
      return { field: 'tpTriggerPx', ordField: 'tpOrdPx', intent: '高位做空' };
    } else {
      return { field: 'slTriggerPx', ordField: 'slOrdPx', intent: '追空' };
    }
  }
}
*/
// ═══ END COMMENTED ═══
// 统一使用市价单
const orderType = 'market';
const limitPrice = null;
const triggerPrice = null;

// ═══ 基准仓位安全帽 ═══
// 防止 LLM 输出异常大的仓位(如发疯时输出 100u+)。
// 基准仓位 30u,正常范围 20u~40u,50u 是硬上限(留足冗余)。
// ⚠️ 此检查在 BTC 对冲(y)和仓位倍率之前执行--只约束 LLM 原始输出。
let cappedNominalBase = nominal_base || 30;
if (cappedNominalBase > 50) {
  log(`⚠️ 基准仓位超限 | nominal_base=${cappedNominalBase}u > 50u 上限 | 强制调整为 50u | 原始值可能为 LLM 异常输出`, 'ALERT');
  cappedNominalBase = 50;
}

// 验证
let skipExecution = false;
let skipReason = '';
let adjustedAction = action;

// ═══ 阶段二请求归档 ═══
// 模型在首周期无法定向时输出 action="abort"，直接归档
if (action === 'abort') {
  skipExecution = true;
  skipReason = `阶段二abort: ${reject_reason || '未指定原因'}`;
  adjustedAction = 'abort';
  log(`📦 ABORT(阶段二): ${reject_reason || '未指定原因'}`);
}

if (reject_reason && adjustedAction !== 'abort') {
  skipExecution = true;
  skipReason = `阶段二拒绝: ${reject_reason}`;
  log(`操作被阶段二拒绝: ${reject_reason}`);
} else if (!hasPosition && (action === 'reduce' || action === 'close')) {
  skipExecution = true;
  skipReason = '无仓位可操作';
  log('⚠️ 无仓位但建议减仓/平仓,跳过执行', 'WARN');
} else if (!hasPosition && action === 'add') {
  adjustedAction = 'open';
  log('无仓位但建议加仓 → 转为开仓', 'WARN');
} else if (hasPosition && action === 'open' && direction === positionDirection) {
  adjustedAction = 'add';
  log('已有同方向仓位且建议开仓 → 视为加仓', 'WARN');
} else if (action === 'hold' || action === '观望' || action === 'watch' || action === 'wait' || action === 'skip') {
  skipExecution = true;
  skipReason = action === 'wait' ? '等待条件' : '观望';
  log(`${skipReason},跳过执行`);
}

// ════════════════════════════════════════════
// 步骤 6: 执行判断
// ════════════════════════════════════════════
// adjust 操作不受 entry_condition 限制--调整止盈止损无需等待入场条件
// market 订单: entry_condition 非 immediate 则跳过(用户手动触发)
// limit/conditional 订单: 已废弃,统一 market
if (!skipExecution && adjustedAction !== 'adjust') {
  if (entry_condition && entry_condition !== 'immediate') {
    skipExecution = true;
    skipReason = `等待触发: ${entry_condition}`;
    log(`等待触发条件: ${entry_condition},market单跳过执行`);
  }
}

// ════════════════════════════════════════════
// 监督者路由 (--supervisor)
// ════════════════════════════════════════════
if (SUPERVISOR_FLAG) {
  // ── 读取监督者配置 ──
  let supervisorConfig;
  try {
    const configPath = path.join(WORKSPACE, 'data', 'supervisor-config.json');
    if (fs.existsSync(configPath)) {
      supervisorConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    log(`监督者配置读取失败,跳过: ${e.message}`, 'WARN');
  }
  if (!supervisorConfig) {
    supervisorConfig = { monitoredActions: { open: true, add: true, reduce: false } };
  }

  let needSupervisor = false;
  let supervisorReason = '';

  if (!skipExecution) {
    // ── 正常执行路径 → 检查受监控的操作类型 ──
    const monitored = supervisorConfig.monitoredActions || {};
    if (monitored[adjustedAction]) {
      needSupervisor = true;
      supervisorReason = `${adjustedAction} 操作`;
    }

    // ── 头仓试探不入监督者 ──
    // 头仓是轻仓(25-50%)+追踪止损的试探性仓位，风险可控，无需独立审查
    if (needSupervisor && isHeadMode) {
      needSupervisor = false;
      log(`监督者跳过: 头仓试探模式不入监督者 (轻仓+追踪止损,风险可控)`);
    }
  } else if (false) {
    // [已删除] 惰性触发路径 — 由 cycle-auto-archiver PM2 进程替代 (2026-06-03)
  }

  // ── 持仓数阈值检查（实盘数据，与 Dashboard 同源）──
  if (needSupervisor) {
    const minPositions = supervisorConfig.minPositionsForTrigger ?? 5;
    const livePositions = countLivePositions();
    if (livePositions >= 0 && livePositions < minPositions) {
      needSupervisor = false;
      log(`监督者跳过: 实盘持仓 ${livePositions} < 阈值 ${minPositions}(可在设置页调整)`);
    } else if (livePositions < 0) {
      log(`监督者继续: OKX API 查询失败,安全回退不跳过阈值检查`);
    }
  }

  if (needSupervisor) {
    // ── 构造监督者消息 ──
    const label = PROFILE === 'zhuang' ? '庄币' : '山寨币';
    let latestReport = '未知';
    try {
      const reports = fs.readdirSync(reportsDir)
        .filter(f => f.startsWith(`${LOG_PREFIX}-report-`))
        .sort().reverse();
      if (reports.length > 0) latestReport = reports[0];
    } catch (_) {}

    // ── 写入七月的实际意图到文件(审查阶段才揭晓)──
    const intentFile = path.join(CYCLE_PATH, 'data-context', 'supervisor-intent.json');
    fs.mkdirSync(path.dirname(intentFile), { recursive: true });
    fs.writeFileSync(intentFile, JSON.stringify({
      direction: direction || '未知',
      action: adjustedAction,
      order_type: orderType,
      trigger_price: triggerPrice,
      limit_price: limitPrice,
      created_at: new Date().toISOString()
    }, null, 2), 'utf8');

    const supervisorMsg = [
      `币种: ${COIN}`,
      `周期目录: active/${CYCLE_DIR}`,
      ``,
      `请先读取 tasks/supervisor-blind.md 进行独立市场分析,`,
      `完成后按指示读取 tasks/supervisor-review.md 进入审查。`,
      ``,
      `⚠️ 七月的实际操作意图已保存在 ${CYCLE_DIR}/data-context/supervisor-intent.json,`,
      `但请勿在盲测阶段查看--审查阶段会指示你读取。`
    ].join('\n');

    // 写入临时文件(消息可能很长)
    const safeName = CYCLE_DIR.replace(/\//g, '_');
    const msgFile = `/tmp/supervisor-${safeName}.txt`;
    fs.writeFileSync(msgFile, supervisorMsg, 'utf8');

    const dispatchName = `supervisor-${COIN}-${Date.now()}`;

    try {
      const dispatchCmd = `node "${path.join(WORKSPACE, 'scripts', 'dispatch.js')}" --priority "pro" --source "supervisor" --coin "${COIN}" --name "${dispatchName}" --at "5s" --message-file "${msgFile}"`;
      log(`🔍 监督者路由: ${supervisorReason} → 任务=${dispatchName}`);
      const dispatchOut = execSync(dispatchCmd, { encoding: 'utf8', timeout: 15000 });
      log(`🔍 监督者已提交调度器 | 决策挂起,等待审查 | 调度器响应: ${dispatchOut.slice(0, 100)}`);
    } catch (e) {
      log(`监督者调度失败: ${e.message}`, 'ERROR');
    }

    try { fs.unlinkSync(msgFile); } catch (_) {}

    output({
      status: 'supervisor_dispatched',
      coin: COIN,
      cycle_dir: CYCLE_DIR,
      action: adjustedAction,
      supervisor_reason: supervisorReason,
      note: '交易决策已提交监督者审查,等待判定后执行'
    });

    log('========== 阶段三(监督者路由)结束 ==========');
    process.exit(0);
  } else {
    log(`监督者跳过 | action=${adjustedAction} | skipExecution=${skipExecution} | → 回退正常执行`);
  }
}

// ════════════════════════════════════════════
// 步骤 6.X: 市场环境对冲(仅开仓/加仓)
// 公式: y = 1.0 + 市场分 × 跟踪度 × 0.5 + 板块分 × 0.15
//   y 钳制到 [0.5, 1.5]
//   市场分 = 方向 × 评分 / 10  (方向: long=+1, short=-1)
//   板块分 = 方向 × (评分 - 板块评分) / 10
// ════════════════════════════════════════════
let nominalFinal = cappedNominalBase;

// ═══ 头仓试探: 仓位折扣 ═══
if (isHeadMode && head_ratio) {
  const hr = Math.min(0.50, Math.max(0.25, Number(head_ratio)));
  const beforeHead = nominalFinal;
  nominalFinal = Math.round(nominalFinal * hr);
  log(`💰 [头仓试探] head_ratio=${hr} | nominal: ${beforeHead}u → ${nominalFinal}u`);
}

// ── 读取止盈止损偏移参数(从面板配置读取)
try {
  const shiftSettingsPath = path.join(WORKSPACE, 'data', 'dashboard-settings.json');
  if (fs.existsSync(shiftSettingsPath)) {
    const s = JSON.parse(fs.readFileSync(shiftSettingsPath, 'utf8'));
    if (s.tpShiftPercent !== undefined) TP_SHIFT_PCT = Math.min(15, Math.max(0, Number(s.tpShiftPercent)));
    if (s.slShiftPercent !== undefined) SL_SHIFT_PCT = Math.min(15, Math.max(0, Number(s.slShiftPercent)));
  }
} catch (e) { /* 使用默认值 */ }
log(`偏移参数 | TP偏移=${TP_SHIFT_PCT}% | SL偏移=${SL_SHIFT_PCT}% | 最大偏移=${MAX_SHIFT_PCT}%`);

// 检查对冲开关
let hedgeEnabled = true;
try {
  const settingsPath = path.join(WORKSPACE, 'data', 'dashboard-settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.hedgeEnabled !== undefined) {
      hedgeEnabled = !!settings.hedgeEnabled;
    }
  }
} catch (e) {
  log(`对冲开关读取失败: ${e.message},默认开启`, 'WARN');
}

if (!hedgeEnabled) {
  log('市场对冲已关闭 (hedgeEnabled=false),跳过');
} else if (!skipExecution && (adjustedAction === 'open' || adjustedAction === 'add')) {
  try {
    const brief = readMarketBrief();

    if (brief) {
      const score = brief.market_state?.score;
      const sectorName = lookupSector(COIN);
      let sectorScore = null;

      if (sectorName) {
        const sector = (brief.sectors || []).find(s => s.name === sectorName);
        sectorScore = sector ? sector.score : null;
      }

      if (score !== undefined && score !== null) {
        const dirSign = direction === 'long' ? 1 : -1;

        // 跟踪度(保留符号)
        const corr = computeBtcCorrelation(COIN);
        // marketScore × corr  决定对冲方向:
        //   > 0 → 该仓位有自然对冲(如大盘跌+ALLO涨+做多), 放大仓位
        //   < 0 → 相关系数放大了方向风险, 缩减仓位
        //   = 0 → 无相关信息, 不调整
        //   负相关=庄家控盘强, 市场越不利仓位越有保护→放大
        //   正相关=跟大盘走, 顺势放大逆势缩减
        const corrFinal = corr !== null ? corr : 0.5;

        // 市场分
        const marketScore = dirSign * score / 10;

        // 板块分(无板块数据时为 0)
        // 板块分只有在有板块映射时才生效
        // 板块分独立于跟踪度--即使币种不跟大盘(corr≤0),板块内部轮动逻辑仍可能影响
        // 但无板块映射时(如 ALLO)不起作用
        const sectorScoreNorm = (sectorScore !== null)
          ? dirSign * (score - sectorScore) / 10
          : 0;

        // 统一公式
        let y = 1.0 + marketScore * corrFinal * 0.5 + sectorScoreNorm * 0.15;

        // 钳制
        const yRaw = y;
        if (y < 0.5) y = 0.5;
        if (y > 1.5) y = 1.5;
        const clamped = y !== yRaw;

        const beforeNominal = nominalFinal;
        nominalFinal = Math.round(nominalFinal * y);

        // 对冲方向解释
        const hedgeNote = (corr !== null && corr !== 0)
          ? ` (mkt×corr=${round(marketScore * corr,3)}, ${marketScore * corr > 0 ? '对冲保护→放大' : '方向风险→缩减'})`
          : (corr === 0 ? ' (corr=0,不调整)' : '');
        log(`市场对冲计算 | 评分=${score} | 板块=${sectorName || '未知'}(${sectorScore !== null ? sectorScore : '-'}) | corr=${round(corrFinal,3)}${hedgeNote} | 市场分=${round(marketScore,3)} | 板块分=${round(sectorScoreNorm,3)} | y_原始=${round(yRaw,3)} → y=${round(y,3)}${clamped ? ' (钳制)' : ''}`);
        log(`市场对冲结果 | ${beforeNominal}u × ${round(y,3)} = ${nominalFinal}u`);
      } else {
        log('市场评分缺失,y=1.0', 'WARN');
      }
    } else {
      log('市场快报不可用,y=1.0', 'WARN');
    }
  } catch (e) {
    log(`对冲计算失败: ${e.message},y=1.0`, 'WARN');
  }
}

// ════════════════════════════════════════════
// 步骤 6.Y: 仓位倍率(从面板配置读取)
// ════════════════════════════════════════════
if (!skipExecution && (adjustedAction === 'open' || adjustedAction === 'add')) {
  try {
    const settingsPath = path.join(WORKSPACE, 'data', 'dashboard-settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const multiplierKey = PROFILE === 'zhuang' ? 'zhuangPositionMultiplier' : 'positionMultiplier';
      const multiplier = parseFloat(settings[multiplierKey] || settings.positionMultiplier) || 1;
      if (multiplier >= 0.8 && multiplier <= 20) {
        const beforeNominal = nominalFinal;
        nominalFinal = Math.round(nominalFinal * multiplier);
        log(`仓位倍率 | ×${multiplier} | ${beforeNominal}u → ${nominalFinal}u`);
      }
    }
  } catch (e) {
    log(`读取仓位倍率失败: ${e.message},使用默认×1`, 'WARN');
  }
}

// ════════════════════════════════════════════
// 步骤 6.Z: 组合暴露度筛选（仅开仓/加仓）
// 调 calc-portfolio-exposure.js 做边际风险评估
// 开仓: 候选仓位作为新币种加入组合
// 加仓: 候选 nominal 合并到已有同币种仓位（脚本内部去重）
// ════════════════════════════════════════════
let executionResult = { action: adjustedAction, executed: false };
if (!skipExecution && (adjustedAction === 'open' || adjustedAction === 'add')) {
  // 读取全局风险上限
  let globalThreshold = 60;
  try {
    const settingsPath = path.join(WORKSPACE, 'data', 'dashboard-settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.portfolioRiskThreshold) globalThreshold = parseInt(settings.portfolioRiskThreshold);
    }
  } catch (_) {}

  const exposureScript = path.join(WORKSPACE, 'scripts', 'calc-portfolio-exposure.js');
  const exposureCmd = `node "${exposureScript}" --candidate ${COIN} --direction ${direction} --nominal ${nominalFinal} --global-threshold ${globalThreshold}`;
  log(`组合暴露度检查: ${COIN} ${direction} ${nominalFinal}u (${adjustedAction}, 上限=${globalThreshold})`);

  let exposureResult = null;
  let exposureError = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const raw = execSync(exposureCmd, {
        encoding: 'utf8',
        timeout: 35000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
      });
      exposureResult = JSON.parse(raw);
      exposureError = null;
      break; // 成功,退出重试循环
    } catch (e) {
      exposureError = e.message;
      if (attempt < maxRetries) {
        const delay = 2000 * attempt;
        log(`组合暴露度重试 ${attempt}/${maxRetries}: ${e.message}, ${delay}ms 后重试...`, 'WARN');
        execSync(`sleep ${delay / 1000}`);
      } else {
        log(`组合暴露度最终失败 (${maxRetries}次): ${e.message}`, 'ERROR');
      }
    }
  }

  if (exposureResult && !exposureResult.error) {
    const eval_ = exposureResult.candidate_evaluation;
    if (eval_) {
      const riskChange = eval_.risk_delta != null ? ` (风险 ${eval_.current_risk_score}→${eval_.with_candidate_risk_score} ${eval_.risk_delta >= 0 ? '+' : ''}${eval_.risk_delta})` : '';

      if (eval_.decision === 'reject') {
        skipExecution = true;
        skipReason = `组合暴露度拒绝: ${(eval_.reasons || []).join('; ')}`;
        log(`🛑 组合暴露度拒绝 | ${COIN} ${direction} ${nominalFinal}u${riskChange} | ${(eval_.reasons || []).join('; ')}`);
        executionResult = {
          action: adjustedAction,
          executed: false,
          rejected_by: 'portfolio_exposure',
          reasons: eval_.reasons || [],
          risk_current: eval_.current_risk_score,
          risk_with: eval_.with_candidate_risk_score,
        };

        // 写入审查记录文件，供前端"审查记录"页面展示
        try {
          const now = new Date();
          const bjTime = new Date(now.getTime() + 8 * 3600000);
          const filename = `supervisor-review-${COIN}-${bjTime.getUTCFullYear()}-${String(bjTime.getUTCMonth()+1).padStart(2,'0')}-${String(bjTime.getUTCDate()).padStart(2,'0')}-${String(bjTime.getUTCHours()).padStart(2,'0')}${String(bjTime.getUTCMinutes()).padStart(2,'0')}.md`;
          const reportsDir = path.join(WORKSPACE, 'active', CYCLE_DIR, 'reports');
          if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
          const md = `# 组合暴露度拒绝\n\n**币种**: ${COIN}\n**方向**: ${direction}\n**操作**: ${adjustedAction}\n**仓位**: ${nominalFinal} USDT\n\n## 风险评分\n\n- 当前组合风险: ${eval_.current_risk_score ?? 'N/A'}\n- 加入候选后: ${eval_.with_candidate_risk_score ?? 'N/A'}\n- 风险变化: ${eval_.risk_delta != null ? (eval_.risk_delta >= 0 ? '+' : '') + eval_.risk_delta : 'N/A'}\n- 阈值上限: ${globalThreshold}\n\n## 拒绝原因\n\n${(eval_.reasons || []).map(r => '- ' + r).join('\n')}\n\n## 最终判定：BLOCK\n\n组合暴露度超限，拒绝${adjustedAction === 'open' ? '开仓' : '加仓'}\n`;
          fs.writeFileSync(path.join(reportsDir, filename), md);
          log(`📝 审查记录已写入: ${filename}`);
        } catch (e) {
          log(`⚠️ 写入审查记录失败: ${e.message}`, 'WARN');
        }
      } else {
        log(`✅ 组合暴露度通过 | ${COIN} ${direction} ${nominalFinal}u${riskChange} | ${(eval_.reasons || [''])[0]}`);
      }
    } else {
      log('⚠️ 组合暴露度返回缺少 candidate_evaluation', 'WARN');
    }
  } else {
    // 脚本异常 → 安全回退: 放行
    log(`⚠️ 组合暴露度不可用 (error=${exposureResult?.error || exposureError}), 安全回退放行`, 'WARN');
  }
}

// ════════════════════════════════════════════
// 步骤 7: 执行仓位操作
// ════════════════════════════════════════════
executionResult = { action: adjustedAction, executed: !skipExecution };

// ═══ 阶段二 abort: 调用 archive-cycle.js + 冷却 ═══
let archived = false;
if (adjustedAction === 'abort') {
  try {
    const reason = reject_reason || '阶段二分析决定归档';
    const archiveCmd = `node "${ARCHIVE_SCRIPT}" --cycle ${CYCLE_DIR} --by manual --reason "${reason.replace(/"/g, '\\"')}" --close-type "手动归档"`;
    execSync(archiveCmd, { encoding: 'utf8', timeout: 30000 });
    archived = true;
    log(`📦 ARCHIVE: ${CYCLE_DIR} → archived/ | 原因: ${reason}`);

    // 写入冷却名单
    const cooldownPath = path.join(WORKSPACE, 'data', 'coin-cooldown.json');
    let cd = { entries: {} };
    try { if (fs.existsSync(cooldownPath)) cd = JSON.parse(fs.readFileSync(cooldownPath, 'utf8')); } catch (_) {}
    if (!cd.entries) cd.entries = {};
    cd.entries[COIN] = {
      cooldown_until: new Date(Date.now() + 18 * 3600000).toISOString(),
      reason: reason,
      added_at: new Date().toISOString()
    };
    cd.updated = new Date().toISOString();
    fs.writeFileSync(cooldownPath, JSON.stringify(cd, null, 2) + '\n');
    log(`🧊 冷却: ${COIN} → 72h`);
  } catch (e) {
    log(`📦 ARCHIVE 失败: ${e.message}`, 'ERROR');
  }
}

if (!skipExecution && adjustedAction !== 'abort') {
  try {
    await executeTrade(adjustedAction, direction, nominalFinal, stop_loss, take_profit1, take_profit2, tp1_ratio || 50, reduce_ratio, entry_condition, trailing_callback_ratio, isHeadMode);
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
// 步骤 9: 判断归档（仅在未被阶段二归档时执行）
// ════════════════════════════════════════════

if (!archived) {
try {
  const posData = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
  const currentCount = posData['汇总']?.['当前持仓数'] || 0;
  const recentClose = posData['最近平仓'];

  if (currentCount === 0 && recentClose !== null) {
    // 📦 ARCHIVE
    log('📦 ARCHIVE: 检测到归档条件(持仓=0, 最近平仓≠null)');

    // 归档前清理该币种所有挂单（防止残留委托）
    cancelAllOrders(INST_ID);

    try {
      const archiveCmd = `node "${ARCHIVE_SCRIPT}" --cycle ${CYCLE_DIR}`;
      const archiveOut = execSync(archiveCmd, { encoding: 'utf8', timeout: 30000 });
      archived = true;
      log(`📦 ARCHIVE: ${CYCLE_DIR} → archived/ | 使用 archive-cycle.js 统一归档`);

      // ─── 创建复盘 cron(24h后触发) ───
      const reviewAt = execSync('date -d "+24 hours" --iso-8601=seconds', { encoding: 'utf8', timeout: 5000 }).trim();
      const reviewDate = execSync('date -d "+24 hours" +%Y%m%d', { encoding: 'utf8', timeout: 5000 }).trim();
      const reviewTime = execSync('date -d "+24 hours" +%H%M', { encoding: 'utf8', timeout: 5000 }).trim();
      const nowIso = new Date(Date.now() + 8 * 3600000).toISOString();

      const reviewMsg = `周期路径: archived/${CYCLE_DIR}\n币种: ${COIN}\n归档时间: ${nowIso}\n请读取 tasks/trade-review.md 对该周期执行独立深度复盘。`;

      // 通过调度器提交复盘任务(低优先级)
      const reviewMsgFile = `/tmp/dispatch-review-${CYCLE_DIR}.txt`;
      fs.writeFileSync(reviewMsgFile, reviewMsg, 'utf8');

      try {
        execSync(
          `node "${path.join(WORKSPACE, 'scripts', 'dispatch.js')}" --priority "low-2" --source review --coin "${COIN}" --name "review-${CYCLE_DIR}" --at "${reviewAt}" --message-file "${reviewMsgFile}"`,
          { encoding: 'utf8', timeout: 15000 }
        );
        log(`📋 复盘已提交调度器 | 任务: review-${CYCLE_DIR} | 触发时间: ${reviewAt} | 输出: learnings/review-${COIN}-${reviewDate}-${reviewTime}.md`);
      } catch (dispatchErr) {
        log(`调度器提交失败,降级直连: ${dispatchErr.message}`, 'WARN');
        execSync(
          `openclaw cron add --name "review-${CYCLE_DIR}" --agent july --at "${reviewAt}" --message '${reviewMsg.replace(/'/g, "'\\''")}' --session isolated --delete-after-run --no-deliver`,
          { encoding: 'utf8', timeout: 10000 }
        );
        log(`📋 复盘cron已直连创建 | 任务: review-${CYCLE_DIR} | 触发时间: ${reviewAt}`);
      }
      try { fs.unlinkSync(reviewMsgFile); } catch (_) {}
    } catch (e) {
      log(`📦 ARCHIVE 失败: ${e.message}`, 'ERROR');
    }
  } else {
    log(`周期继续 | 当前持仓: ${currentCount} 个 | 状态: active`);
  }
} catch (e) {
  log(`归档判断失败: ${e.message}`, 'ERROR');
}
} // if (!archived)

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
async function executeTrade(action, direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, reduceRatio, entryCondition, trailingRatio, isHeadMode) {
  switch (action) {
    case 'open':
      await executeOpen(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, trailingRatio, isHeadMode);
      break;
    case 'add':
      await executeAdd(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, trailingRatio);
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
    default: {
      const validActions = ['open','add','reduce','close','adjust','hold','wait','abort'];
      const mappingHints = [];
      const lower = String(action || '').toLowerCase();
      if (['scout','试探','试仓','head','头仓'].includes(lower)) mappingHints.push('→ action: "open" + entry_mode: "head"（头仓试探模式）');
      if (['buy','long','做多'].includes(lower)) mappingHints.push('→ action: "open" + direction: "long"');
      if (['sell','short','做空'].includes(lower)) mappingHints.push('→ action: "open" + direction: "short"');
      if (['skip','watch','观望'].includes(lower)) mappingHints.push('→ 不操作请用 action: "wait"（无持仓）或 action: "hold"（有持仓）');
      const hintSection = mappingHints.length > 0
        ? '\n  常见映射（下次修正 trade-decision.json）：\n    ' + mappingHints.join('\n    ')
        : '';
      const fieldHint = lower === 'scout'
        ? '\n  头仓字段名也必须对齐：scout_pct→head_ratio, trailing_stop_pct→trailing_callback_ratio (小数 0.06 = 6%)'
        : '';
      const msg = `无效操作类型: "${action}" | 允许值: ${validActions.join('/')}${hintSection}${fieldHint}\n    检查 tasks/pipeline/stage2-alt.md → trade-decision JSON schema → action 字段`;
      log(msg, 'ERROR');
      throw new Error(msg);
    }
  }
}

// ─── 7.1 开仓 ───
async function executeOpen(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, trailingRatio, isHeadMode) {
  // ═══ 已废弃: limit/conditional 路由 ═══
  // 统一使用市价单。原条件单逻辑见: executeConditionalOpen / executeLimitOpen (下方注释块)

  const headTag = isHeadMode ? '[头仓试探] ' : '';
  logOp(`💰 OPEN: ${headTag}开仓 | direction=${direction} | nominal=${nominalFinal}u | orderType=market`);

  // ═══ 市价开仓硬性要求 ═══
  // 头仓模式: 仅需 trailingRatio (纯追踪止损)
  // 常规模式: 必须带止盈止损
  if (isHeadMode) {
    if (!trailingRatio) {
      log(`⛔ ERROR: 头仓开仓拒绝 — 缺少追踪止损 (trailingRatio=${trailingRatio})`, 'ERROR');
      throw new Error('头仓开仓必须有追踪止损');
    }
  } else {
    if (!stopLoss || !tp1) {
      log(`⛔ ERROR: 市价开仓拒绝 — 缺少止盈止损 (SL=${stopLoss}, TP1=${tp1})`, 'ERROR');
      throw new Error('市价开仓必须有止盈止损');
    }
  }

  // 7.1.1 余额检查
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

  // 7.1.3 先计算张数 (不依赖杠杆, sz 用于查 MMR 档位)
  const rawSz = nominalFinal / (lastPrice * ctVal);
  let sz = rawSz;
  if (lotSz > 0) {
    sz = round(Math.round(rawSz / lotSz) * lotSz, 8);
  }
  sz = round(sz, 4);

  if (sz < minSz) {
    const plannedNominal = nominalFinal;
    const minNominal = minSz * lastPrice * ctVal;
    const gapRatio = (minNominal - plannedNominal) / plannedNominal;

    if (gapRatio >= 0.30) {
      log(`⚠️ SKIP: 计划仓位 ${plannedNominal}u | 最小可开 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% ≥ 30% | 跳过开仓`, 'WARN');
      return;
    }

    log(`📐 ADJUST: 计划仓位 ${plannedNominal}u → 提升至最小可开 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% < 30% | 按 minSz=${minSz} 执行`);
    sz = minSz;
  }

  // 获取实际 MMR, 计算杠杆
  const leverConfigured = readLeverageSetting();
  const mmr = stopLoss ? fetchContractMmr(INST_ID, sz, ctVal, lastPrice) : 0.07;
  const leverActual = stopLoss
    ? calcIsolatedLeverage(lastPrice, stopLoss, direction, leverConfigured, maxLever, mmr)
    : Math.min(leverConfigured, maxLever);

  log(`合约信息: ctVal=${ctVal}, minSz=${minSz}, lotSz=${lotSz}, maxLever=${maxLever}, 杠杆=${leverActual}x (面板=${leverConfigured}x), tickSz=${tickSz}`);

  // ─── 7.1.1b 设置杠杆(独立命令,下单前必须)
  const leverSetResult = runOkxCmd(`swap leverage --instId ${INST_ID} --lever ${leverActual} --mgnMode isolated --posSide ${direction}`, { retries: 2 });
  if (leverSetResult) {
    log(`杠杆已设置: ${leverActual}x (OKX返回: ${leverSetResult[0]?.lever}x)`);
  } else {
    log(`杠杆设置失败,继续以下单参数兜底`, 'WARN');
  }


  const actualNominal = sz * lastPrice * ctVal;
  log(`实际名义价值: ${sz} × ${lastPrice} × ${ctVal} = ${actualNominal} USDT`);

  // 7.1.4 下单
  const side = direction === 'long' ? 'buy' : 'sell';
  const posSide = direction;

  const placeCmd = `swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${sz} --tdMode isolated --posSide ${posSide}`;
  logOp(`💰 OPEN: 下单 → ${placeCmd}`);

  const placeResult = runOkxCmd(placeCmd);
  if (!placeResult) throw new Error('下单失败');

  const ordId = placeResult[0]?.ordId;
  const avgPx = placeResult[0]?.avgPx || lastPrice;
  logOp(`💰 OPEN: 下单成功 | ordId=${ordId} | 成交价=${avgPx} | 张数=${sz}`);

  // 7.1.5 等待确认
  await new Promise(r => setTimeout(r, 2000));
  const posCheck = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`, { retries: 3, isCritical: true });
  if (posCheck && posCheck[0]) {
    logOp(`💰 OPEN: 持仓确认 | 张数=${posCheck[0].pos} | 入场价=${posCheck[0].avgPx}`);
  }

  // 7.1.6 设置止盈止损(含偏移)
  const entryPx = num(avgPx) || lastPrice;
  const finalSide = posSide === "long" ? "sell" : "buy";

  if (isHeadMode) {
    // ═══ 头仓试探: 仅追踪止损, 不设 OCO ═══
    logOp(`💰 OPEN: [头仓试探] 跳过固定止盈止损, 仅设追踪止损`);

    // ═══ 追踪止损(头仓专属) ═══
    if (trailingRatio && sz >= minSz) {
      const trailCmd = `swap algo trail --instId ${INST_ID} --side ${finalSide} --sz ${sz} --posSide ${posSide} --tdMode isolated --callbackRatio ${trailingRatio} --reduceOnly true`;
      logOp(`💰 OPEN: 追踪止损下单 → ${trailCmd}`);
      const trailResult = runOkxCmd(trailCmd);
      if (trailResult) {
        logOp(`💰 OPEN: 追踪止损设置成功 | algoId=${trailResult[0]?.algoId} | callbackRatio=${trailingRatio} (${(trailingRatio*100).toFixed(1)}%)`);
      } else {
        log('⚠️ 追踪止损 设置失败', 'WARN');
      }
    }

    // 7.1.7 核对
    logOp(`💰 OPEN: [头仓试探] 开仓完成 | ${direction} ${sz}张 @ ${entryPx} | 追踪止损=${(trailingRatio*100).toFixed(1)}% | 无固定SL/TP`);

    // 头仓模式无固定止损, 跳过逐仓保证金追加 (追踪止损自行管理)
    return;
  }

  // ═══ 常规模式: 固定止盈止损逻辑 ═══
  // SL/TP 已在入口处保证存在, 直接使用
  const effectiveSL = stopLoss;
  const effectiveTP1 = tp1;

  const slOffset = calcPnlOffset(entryPx, effectiveSL, 'sl', direction, tickSz);
  const tp1Offset = effectiveTP1 ? calcPnlOffset(entryPx, effectiveTP1, 'tp', direction, tickSz) : null;
  const tp2Offset = tp2 ? calcPnlOffset(entryPx, tp2, 'tp', direction, tickSz) : null;

  // 拆分仓位:两笔 OCO 单,分别绑定 TP1+SL 和 TP2+SL
  // 对齐 lotSz(如 lotSz=1 取整到整数,lotSz=0.01 取整到百分位)
  // ⚠️ alignToLot 必须 round() 防浮点精度泄露(如 23*0.1=2.3000000000000003)
  const alignToLot = (v) => lotSz > 0 ? round(Math.floor(v / lotSz) * lotSz, 8) : round(v, 4);
  const ratio1 = (tp1Ratio || 50) / 100;
  const rawSzTp1 = round(sz * ratio1, 8);
  const szTp1 = Math.max(minSz, alignToLot(rawSzTp1));
  const remaining = round(sz - szTp1, 8);
  // szTp2 = 总仓位 - TP1(不 floor,自动吸收对齐余量)
  const szTp2 = tp2 ? Math.max(minSz, round(sz - szTp1, 8)) : 0;

  logOp(`💰 OPEN: 止盈止损偏移 | SL: ${effectiveSL}→${slOffset}${tp1Offset ? ` | TP1: ${effectiveTP1}→${tp1Offset}` : ' | TP1: (无固定止盈)'}${tp2 ? ` | TP2: ${tp2}→${tp2Offset}` : ''} | 拆分: ${tp1Offset ? szTp1+'张(TP1)' : '无OCO拆分'}${tp2 ? ' + '+szTp2+'张(TP2)' : ''}`);

  // ═══ OCO 固定止盈止损 ═══
  // 仅当 effectiveTP1 存在时才设 OCO(纯追踪止损模式跳过 OCO)

  // OCO 1: TP1 + SL(部分仓位)
  if (tp1Offset && szTp1 >= minSz) {
    const algoCmd1 = `swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${posSide} --sz ${szTp1} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`;
    logOp(`💰 OPEN: OCO下单(TP1) → ${algoCmd1}`);
    const algoResult1 = runOkxCmd(algoCmd1);
    if (algoResult1) {
      logOp(`💰 OPEN: OCO(TP1)设置成功 | algoId=${algoResult1[0]?.algoId} | sz=${szTp1}`);
    } else {
      log('⚠️ OCO(TP1) 设置失败', 'WARN');
    }
  }

  // OCO 2: TP2 + SL(剩余仓位)
  if (szTp2 >= minSz && tp2 && tp2Offset) {
    const algoCmd2 = `swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${posSide} --sz ${szTp2} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp2Offset} --tpOrdPx=-1 --reduceOnly true`;
    logOp(`💰 OPEN: OCO下单(TP2) → ${algoCmd2}`);
    const algoResult2 = runOkxCmd(algoCmd2);
    if (algoResult2) {
      logOp(`💰 OPEN: OCO(TP2)设置成功 | algoId=${algoResult2[0]?.algoId} | sz=${szTp2}`);
    } else {
      log('⚠️ OCO(TP2) 设置失败', 'WARN');
    }
  } else if (!tp2 && tp1Offset && sz >= minSz) {
    // 无 TP2:整单一笔 OCO
    const algoCmdFull = `swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${posSide} --sz ${sz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`;
    logOp(`💰 OPEN: OCO下单(整单) → ${algoCmdFull}`);
    const algoResult = runOkxCmd(algoCmdFull);
    if (algoResult) {
      logOp(`💰 OPEN: OCO设置成功 | algoId=${algoResult[0]?.algoId}`);
    } else {
      log('⚠️ OCO 设置失败', 'WARN');
    }
  }

  // ═══ 追踪止损(与 OCO 独立并存) ═══
  // 追踪止损是独立订单,可以与 OCO 同时存在:
  //   - 纯追踪(tp1=null):仅追踪止损,无限上涨无固定止盈
  //   - 双重(tp1+trailing):OCO固守 + 追踪跟随,双重保护
  if (trailingRatio && sz >= minSz) {
    const trailCmd = `swap algo trail --instId ${INST_ID} --side ${finalSide} --sz ${sz} --posSide ${posSide} --tdMode isolated --callbackRatio ${trailingRatio} --reduceOnly true`;
    logOp(`💰 OPEN: 追踪止损下单 → ${trailCmd}`);
    const trailResult = runOkxCmd(trailCmd);
    if (trailResult) {
      logOp(`💰 OPEN: 追踪止损设置成功 | algoId=${trailResult[0]?.algoId} | callbackRatio=${trailingRatio} (${(trailingRatio*100).toFixed(1)}%)`);
    } else {
      log('⚠️ 追踪止损 设置失败', 'WARN');
    }
  }

  // 7.1.7 核对
  const tpSummary = tp1Offset ? ` | TP1=${tp1Offset}${tp2 ? ` | TP2=${tp2Offset}` : ''}` : ' | TP=(无固定止盈)';
  const trailingSummary = trailingRatio ? ` | 追踪止损=${(trailingRatio*100).toFixed(1)}%` : '';
  logOp(`💰 OPEN: 开仓完成 | ${direction} ${sz}张 @ ${entryPx} | SL=${slOffset}${tpSummary}${trailingSummary}`);

  // ═══ 7.1.8 逐仓保证金追加: 爆仓价=止损价×1.10 ═══
  adjustIsolatedMargin(sz, ctVal, entryPx, effectiveSL, direction, leverActual, INST_ID, posSide, mmr);
}

// ─── 7.2 加仓 ───
async function executeAdd(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, trailingRatio) {
  logOp(`💰 ADD: 加仓 | direction=${direction} | nominal=${nominalFinal}u`);

  // A. 获取当前持仓(用于取原始入场价 + 计算总仓位)
  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`);
  if (!posData || !posData[0]) throw new Error('获取持仓失败');
  const existingSz = num(posData[0].pos);
  const existingAvgPx = num(posData[0].avgPx);
  const posSide = posData[0].posSide;

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

  // 先计算加仓张数 (不依赖杠杆, 用于查 MMR 档位)
  const alignToLot = (v) => lotSz > 0 ? round(Math.floor(v / lotSz) * lotSz, 8) : round(v, 4);
  const rawSz = nominalFinal / (lastPrice * ctVal);
  let sz = rawSz;
  if (lotSz > 0) sz = alignToLot(sz);
  sz = round(sz, 4);

  if (sz < minSz) {
    const plannedNominal = nominalFinal;
    const minNominal = minSz * lastPrice * ctVal;
    const gapRatio = (minNominal - plannedNominal) / plannedNominal;

    if (gapRatio >= 0.30) {
      log(`⚠️ SKIP: 计划加仓 ${plannedNominal}u | 最小可加 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% ≥ 30% | 跳过加仓`, 'WARN');
      return;
    }

    log(`📐 ADJUST: 计划加仓 ${plannedNominal}u → 提升至 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% < 30% | 按 minSz=${minSz} 执行`);
    sz = minSz;
  }

  // 获取实际 MMR (基于加仓后总张数), 计算杠杆
  const totalExpectedSz = existingSz + sz;
  const leverConfigured = readLeverageSetting();
  const mmr = stopLoss ? fetchContractMmr(INST_ID, totalExpectedSz, ctVal, lastPrice) : 0.07;
  const leverActual = stopLoss
    ? calcIsolatedLeverage(lastPrice, stopLoss, direction, leverConfigured, maxLever, mmr)
    : Math.min(leverConfigured, maxLever);

  // 设置杠杆(独立命令,下单前必须)
  const leverSetAddResult = runOkxCmd(`swap leverage --instId ${INST_ID} --lever ${leverActual} --mgnMode isolated --posSide ${posSide}`, { retries: 2 });
  if (leverSetAddResult) {
    log(`加仓杠杆已设置: ${leverActual}x`);
  }

  const side = direction === 'long' ? 'buy' : 'sell';

  // B. 第一步:保存旧 OCO 价格(兜底用)+ 取消现有算法单
  const oldAlgos = runOkxCmd(`swap algo orders --instId ${INST_ID} --tdMode isolated`);
  const oldOcoPrices = extractOcoPrices(oldAlgos);
  log(`旧OCO价格 | SL=${oldOcoPrices.slPrice}, TP1=${oldOcoPrices.tp1Price}, TP2=${oldOcoPrices.tp2Price}`);

  if (oldAlgos && oldAlgos.length > 0) {
    for (const order of oldAlgos) {
      logOp(`💰 ADD: 取消旧算法单 → algoId=${order.algoId}`);
      runOkxCmd(`swap algo cancel --instId ${INST_ID} --algoId ${order.algoId}`, { retries: 3, isCritical: true });
    }
  }

  // C. 第二步:执行加仓市场单
  logOp(`💰 ADD: 加仓下单 → ${sz}张`);
  const placeResult = runOkxCmd(`swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${sz} --tdMode isolated --posSide ${posSide}`, { retries: 3, isCritical: true });
  if (!placeResult) throw new Error('加仓下单失败');
  logOp(`💰 ADD: 加仓成功 | 加 ${sz}张`);
  await new Promise(r => setTimeout(r, 2000));

  // D. 第三步:查询最终持仓(总张数 + 加权均价)
  const posAfter = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`, { retries: 3, isCritical: true });
  const totalSz = posAfter?.[0] ? num(posAfter[0].pos) : existingSz + sz;
  const totalAvgPx = posAfter?.[0] ? num(posAfter[0].avgPx) : null;
  logOp(`💰 ADD: 加仓后总持仓 ${totalSz}张`);

  // E. 第四步:设置新止盈止损--三个阶段传入参数 / 兜底复用旧OCO价格
  const entryPx = totalAvgPx || ((existingAvgPx * existingSz + lastPrice * sz) / (existingSz + sz));
  log(`加仓加权均价: entryPx=${round(entryPx, 4)} (原=${existingAvgPx}, 加仓价=${lastPrice})`);

  let slOffset, tp1Offset, tp2Offset;
  const useFallback = !stopLoss || !tp1;

  if (!useFallback) {
    // 模式A:阶段二传入的参数 → 计算偏移
    slOffset = calcPnlOffset(entryPx, stopLoss, 'sl', direction, tickSz);
    tp1Offset = calcPnlOffset(entryPx, tp1, 'tp', direction, tickSz);
    tp2Offset = tp2 ? calcPnlOffset(entryPx, tp2, 'tp', direction, tickSz) : null;
    log(`TP/SL 来源: 阶段二传入参数 | SL=${stopLoss}→${slOffset}, TP1=${tp1}→${tp1Offset}${tp2 ? `, TP2=${tp2}→${tp2Offset}` : ''}`);
  } else if (oldOcoPrices.slPrice && oldOcoPrices.tp1Price) {
    // 模式B:兜底--阶段二未传入 → 复用旧 OCO 价格(已经是偏移后的价格,不再二次偏移)
    slOffset = oldOcoPrices.slPrice;
    tp1Offset = oldOcoPrices.tp1Price;
    tp2Offset = oldOcoPrices.tp2Price;
    log(`⚠️ TP/SL 来源: 兜底复用旧OCO(阶段二未传入参数)| SL=${slOffset}, TP1=${tp1Offset}, TP2=${tp2Offset}`, 'WARN');
  } else {
    log(`⚠️ WARN: 无可用的TP/SL参数(阶段二未传入 + 旧OCO无数据),跳过止盈止损设置`, 'WARN');
    logOp(`💰 ADD: 加仓完成(无TP/SL)| 总持仓 ${totalSz}张`);
    return;
  }

  const finalSide = posSide === "long" ? "sell" : "buy";

  // 拆分总仓位到两笔 OCO
  const rawSzTp1 = round(totalSz * ((tp1Ratio || 50) / 100), 8);
  const szTp1 = Math.max(minSz, alignToLot(rawSzTp1));
  const remaining = round(totalSz - szTp1, 8);
  // szTp2 = 总仓位 - TP1(不 floor,自动吸收对齐余量)
  const szTp2 = tp2 ? Math.max(minSz, round(totalSz - szTp1, 8)) : 0;

  logOp(`💰 ADD: 新止盈止损(基于总仓位 ${totalSz}张)| SL→${slOffset} | TP1→${tp1Offset}${tp2 ? ` | TP2→${tp2Offset}` : ''} | 拆分: ${szTp1}张+${szTp2}张`);

  // OCO 1: TP1 + SL
  if (szTp1 >= minSz) {
    runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${posSide} --sz ${szTp1} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
  }

  // OCO 2: TP2 + SL
  if (szTp2 >= minSz && tp2 && tp2Offset) {
    runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${posSide} --sz ${szTp2} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp2Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
  } else if (!tp2 && totalSz >= minSz) {
    // 无 TP2:整单
    runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${posSide} --sz ${totalSz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
  }

  logOp(`💰 ADD: 加仓完成 | 总持仓 ${totalSz}张 | 加权均价 ${round(entryPx, 4)}`);

  // ═══ 追踪止损(加仓后可能切换策略) ═══
  if (trailingRatio && totalSz >= minSz) {
    const trailCmd = `swap algo trail --instId ${INST_ID} --side ${finalSide} --sz ${totalSz} --posSide ${posSide} --tdMode isolated --callbackRatio ${trailingRatio} --reduceOnly true`;
    logOp(`💰 ADD: 追踪止损下单 → ${trailCmd}`);
    const trailResult = runOkxCmd(trailCmd);
    if (trailResult) {
      logOp(`💰 ADD: 追踪止损设置成功 | algoId=${trailResult[0]?.algoId} | callbackRatio=${trailingRatio} (${(trailingRatio*100).toFixed(1)}%)`);
    } else {
      log('⚠️ 追踪止损 设置失败', 'WARN');
    }
  }

  // ═══ 逐仓保证金追加: 爆仓价=止损价×1.10 ═══
  if (slOffset) {
    adjustIsolatedMargin(totalSz, ctVal, entryPx, slOffset, direction, leverActual, INST_ID, posSide, mmr);
  }
}

// ─── 7.3 减仓 ───
async function executeReduce(reduceRatio, stopLoss, tp1, tp2) {
  logOp(`💰 REDUCE: 减仓 | ratio=${reduceRatio || 50}%`);

  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`);
  if (!posData || !posData[0]) {
    log('⚠️ 无仓位可减仓', 'WARN');
    return;
  }

  // 获取合约信息
  const instrumentsRaw = runOkxCmd('market instruments --instType SWAP');
  let contractInfo = null;
  if (instrumentsRaw && Array.isArray(instrumentsRaw)) {
    contractInfo = instrumentsRaw.find(i => i.instId === INST_ID);
  }
  if (!contractInfo) throw new Error('获取合约信息失败');

  const ctVal = num(contractInfo.ctVal);
  const minSz = num(contractInfo.minSz);
  const lotSz = num(contractInfo.lotSz);
  const tickSz = num(contractInfo.tickSz) || 0.00001;
  // ⚠️ alignToLot 必须 round() 防浮点精度泄露(如 23*0.1=2.3000000000000003)
  const alignToLot = (v) => lotSz > 0 ? round(Math.floor(v / lotSz) * lotSz, 8) : round(v, 4);

  const currentSz = num(posData[0].pos);
  const direction = posData[0].posSide;
  const avgPx = num(posData[0].avgPx);

  const rawReduceSz = currentSz * (reduceRatio || 50) / 100;
  const reduceSz = alignToLot(rawReduceSz);

  // 当前价格
  const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
  const lastPrice = tickerData?.[0] ? num(tickerData[0].last) : 0;
  const reduceNominal = lastPrice > 0 ? reduceSz * lastPrice * ctVal : 0;

  log(`合约信息: ctVal=${ctVal}, minSz=${minSz}, lotSz=${lotSz}, tickSz=${tickSz}`);
  log(`减仓计算: 持仓${currentSz}张 × ${reduceRatio || 50}% = ${rawReduceSz} → 对齐lotSz=${reduceSz}张 | 名义价值≈${round(reduceNominal, 2)}u`);

  if (reduceSz <= 0) {
    log(`⚠️ 减仓张数对齐后为 0(原始 ${rawReduceSz},lotSz=${lotSz}),无法减仓`, 'WARN');
    log(`⚠️ 原因: 持仓 ${currentSz}张 × ${(reduceRatio || 50)}% = ${rawReduceSz}张 → lotSz 对齐后不足1单位`, 'WARN');
    return;
  }

  if (reduceSz < minSz) {
    log(`⚠️ 减仓张数 ${reduceSz} < 最小下单张数 ${minSz},跳过减仓`, 'WARN');
    log(`⚠️ 详情: 持仓=${currentSz}张 | 减仓比例=${reduceRatio || 50}% | 原始计算=${rawReduceSz}张 | lotSz对齐=${reduceSz}张 | 名义价值≈${round(reduceNominal, 2)}u | minSz=${minSz}`, 'WARN');
    return;
  }

  // ── A. 第一步:保存旧的 OCO 价格(兜底用)+ 取消现有算法单 ──
  const oldAlgos = runOkxCmd(`swap algo orders --instId ${INST_ID} --tdMode isolated`);
  const oldOcoPrices = extractOcoPrices(oldAlgos);
  log(`旧OCO价格 | SL=${oldOcoPrices.slPrice}, TP1=${oldOcoPrices.tp1Price}, TP2=${oldOcoPrices.tp2Price}`);

  if (oldAlgos && oldAlgos.length > 0) {
    for (const order of oldAlgos) {
      logOp(`💰 REDUCE: 取消旧算法单 → algoId=${order.algoId}`);
      runOkxCmd(`swap algo cancel --instId ${INST_ID} --algoId ${order.algoId}`, { retries: 3, isCritical: true });
    }
  }

  // ── B. 第二步:执行减仓市价单 ──
  const side = direction === 'long' ? 'sell' : 'buy';
  logOp(`💰 REDUCE: 反向市价单 → ${side} ${reduceSz}张`);

  const placeResult = runOkxCmd(`swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${reduceSz} --tdMode isolated --posSide ${direction} --reduceOnly true`, { retries: 3, isCritical: true });
  if (!placeResult) throw new Error('减仓下单失败');

  logOp(`💰 REDUCE: 减仓成功 | 减 ${reduceSz}张`);
  await new Promise(r => setTimeout(r, 2000));

  // ── C. 第三步:查询剩余仓位,设新止盈止损 ──
  const posAfter = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`, { retries: 3, isCritical: true });
  const remainingSz = posAfter?.[0] ? num(posAfter[0].pos) : currentSz - reduceSz;

  if (remainingSz > 0) {
    // 三个阶段二传入参数 / 兜底复用旧OCO价格
    let slOffset, tp1Offset, tp2Offset;
    const useFallback = !stopLoss || !tp1;

    if (!useFallback) {
      // 模式A:阶段二传入的参数 → 用原始入场价计算偏移
      slOffset = calcPnlOffset(avgPx, stopLoss, 'sl', direction, tickSz);
      tp1Offset = calcPnlOffset(avgPx, tp1, 'tp', direction, tickSz);
      tp2Offset = tp2 ? calcPnlOffset(avgPx, tp2, 'tp', direction, tickSz) : null;
      log(`TP/SL 来源: 阶段二传入参数 | SL=${stopLoss}→${slOffset}, TP1=${tp1}→${tp1Offset}${tp2 ? `, TP2=${tp2}→${tp2Offset}` : ''}`);
    } else if (oldOcoPrices.slPrice && oldOcoPrices.tp1Price) {
      // 模式B:兜底--复用旧 OCO 价格(已经是偏移后的价格,不再二次偏移)
      slOffset = oldOcoPrices.slPrice;
      tp1Offset = oldOcoPrices.tp1Price;
      tp2Offset = oldOcoPrices.tp2Price;
      log(`⚠️ TP/SL 来源: 兜底复用旧OCO(阶段二未传入参数)| SL=${slOffset}, TP1=${tp1Offset}, TP2=${tp2Offset}`, 'WARN');
    } else {
      log(`⚠️ WARN: 无可用的TP/SL参数,跳过止盈止损设置`, 'WARN');
      logOp(`💰 REDUCE: 减仓完成(无TP/SL)| 剩余 ${remainingSz}张`);
      return;
    }

    const finalSide = direction === "long" ? "sell" : "buy";

    // 拆分剩余仓位
    const ratio1 = 50;
    const szTp1 = Math.max(minSz, alignToLot(round(remainingSz * ratio1 / 100, 8)));
    // szTp2 = 剩余仓位 - TP1（不 floor，自动吸收对齐余量）
    const szTp2 = tp2 || oldOcoPrices.tp2Price ? Math.max(minSz, round(remainingSz - szTp1, 8)) : 0;
    
    logOp(`💰 REDUCE: 新止盈止损(剩余 ${remainingSz}张,入场均价=${avgPx})| SL→${slOffset} | TP1→${tp1Offset}${tp2Offset ? ` | TP2→${tp2Offset}` : ''} | 拆分: ${szTp1}张+${szTp2}张`);

    // OCO 1: TP1 + SL
    if (szTp1 >= minSz) {
      runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${direction} --sz ${szTp1} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
    }

    // OCO 2: TP2 + SL
    if (szTp2 >= minSz && tp2Offset) {
      runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${direction} --sz ${szTp2} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp2Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
    } else if (!tp2Offset && remainingSz >= minSz) {
      runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${direction} --sz ${remainingSz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
    }
  }

  logOp(`💰 REDUCE: 减仓完成 | 剩余 ${remainingSz}张`);
}

// ─── 7.4 平仓 ───
async function executeClose() {
  logOp(`💰 CLOSE: 全平仓位`);

  // 7.4.1 先取消所有挂单（算法单 + 普通单）
  cancelAllOrders(INST_ID);

  // 7.4.2 查询当前持仓并反向平仓
  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`);
  if (posData && posData.length > 0) {
    for (const pos of posData) {
      const sz = num(pos.pos);
      const direction = pos.posSide;
      if (sz <= 0) continue;

      const side = direction === 'long' ? 'sell' : 'buy';
      logOp(`💰 CLOSE: 反向市价单 → ${side} ${sz}张 (${direction})`);
      runOkxCmd(`swap place --instId ${INST_ID} --side ${side} --ordType market --sz ${sz} --tdMode isolated --posSide ${direction} --reduceOnly true`, { retries: 3, isCritical: true });
    }
  }

  // 7.4.3 确认
  await new Promise(r => setTimeout(r, 2000));
  const posCheck = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`, { retries: 3, isCritical: true });
  const stillHasPos = posCheck && posCheck.some(p => num(p.pos) > 0);
  logOp(`💰 CLOSE: 平仓确认 | ${stillHasPos ? '仍有仓位' : '已全部平仓'}`);
}

// ─── 7.5 调整止盈止损 ───
async function executeAdjust(stopLoss, tp1, tp2, tp1Ratio) {
  logOp(`💰 ADJUST: 调盈损`);

  const posData = runOkxCmd(`account positions --instId ${INST_ID} --tdMode isolated`);
  if (!posData || !posData[0]) {
    log('⚠️ 无仓位可调整止盈止损', 'WARN');
    return;
  }

  const direction = posData[0].posSide;
  const sz = num(posData[0].pos);

  // 7.5.1 获取旧订单
  const algoOrders = runOkxCmd(`swap algo orders --instId ${INST_ID} --tdMode isolated`);

  // 7.5.2 取消旧订单
  if (algoOrders && algoOrders.length > 0) {
    for (const order of algoOrders) {
      logOp(`💰 ADJUST: 取消旧算法单 → algoId=${order.algoId}`);
      runOkxCmd(`swap algo cancel --instId ${INST_ID} --algoId ${order.algoId}`, { retries: 3, isCritical: true });
    }
  }

  // 7.5.3 设新(含偏移)
  const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
  const lastPrice = num(tickerData[0].last);
  const instrumentsRaw = runOkxCmd('market instruments --instType SWAP');
  let contractInfo = null;
  if (instrumentsRaw && Array.isArray(instrumentsRaw)) {
    contractInfo = instrumentsRaw.find(i => i.instId === INST_ID);
  }
  const tickSz = contractInfo ? num(contractInfo.tickSz) || 0.00001 : 0.00001;
  const minSz = contractInfo ? num(contractInfo.minSz) : 0;
  const lotSz = contractInfo ? num(contractInfo.lotSz) : 0;
  const alignToLot = (v) => lotSz > 0 ? round(Math.floor(v / lotSz) * lotSz, 8) : round(v, 4);

  if (stopLoss && tp1) {
    const slOffset = calcPnlOffset(lastPrice, stopLoss, 'sl', direction, tickSz);
    const tp1Offset = calcPnlOffset(lastPrice, tp1, 'tp', direction, tickSz);
    const tp2Offset = tp2 ? calcPnlOffset(lastPrice, tp2, 'tp', direction, tickSz) : null;

    const finalSide = direction === "long" ? "sell" : "buy";

    // 拆分仓位:两笔 OCO 单
    const ratio1 = (tp1Ratio || 50) / 100;
    const szTp1 = Math.max(minSz, alignToLot(round(sz * ratio1, 8)));
    // szTp2 = 总仓位 - TP1（不 floor，自动吸收对齐余量）
    const szTp2 = tp2 ? Math.max(minSz, round(sz - szTp1, 8)) : 0;
    
    logOp(`💰 ADJUST: 新止盈止损 | SL→${slOffset} | TP1→${tp1Offset}${tp2 ? ` | TP2→${tp2Offset}` : ''} | 拆分: ${szTp1}张+${szTp2}张`);

    // OCO 1: TP1 + SL
    if (szTp1 >= minSz) {
      runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${direction} --sz ${szTp1} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
    }

    // OCO 2: TP2 + SL
    if (szTp2 >= minSz && tp2 && tp2Offset) {
      runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${direction} --sz ${szTp2} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp2Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
    } else if (!tp2 && sz >= minSz) {
      // 无 TP2:整单
      runOkxCmd(`swap algo place --instId ${INST_ID} --side ${finalSide} --ordType oco --tdMode isolated --posSide ${direction} --sz ${sz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`, { retries: 3, isCritical: true });
    }
  }

  logOp(`💰 ADJUST: 调盈损完成`);
}

// ════════════════════════════════════════════
// 7.1-A / 7.1-B 已废弃: 条件单 + 限价单开仓
// 原因: 难以适配组合暴露度筛选器、动态杠杆等。只保留市价开仓。
// 原代码保留于下方注释块。
// ════════════════════════════════════════════
/*
// ═══ 7.1-A 条件单开仓 (swap algo place --ordType conditional)
async function executeConditionalOpen(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, trailingRatio) {
  logOp(`💰 OPEN-COND: 条件单开仓 | direction=${direction} | nominal=${nominalFinal}u`);

  // A.1 获取价格和合约信息
  const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
  if (!tickerData || !tickerData[0]) throw new Error('获取价格失败');
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
  // ⚠️ 条件单不设止盈止损（成交后由警报系统补设）
  //    使用面板杠杆（默认 10x），无 SL 可推算
  const leverConfigured = readLeverageSetting();
  const leverActual = Math.min(leverConfigured, maxLever);

  log(`合约信息: ctVal=${ctVal}, minSz=${minSz}, lotSz=${lotSz}, 条件单保守杠杆=${leverActual}x (无止损,逐仓保守, 合约上限=${maxLever})`);

  // A.2 设置杠杆
  const leverSetResult = runOkxCmd(`swap leverage --instId ${INST_ID} --lever ${leverActual} --mgnMode isolated --posSide ${direction}`, { retries: 2 });
  if (leverSetResult) {
    log(`杠杆已设置: ${leverActual}x`);
  }

  // A.3 计算张数
  const rawSz = nominalFinal / (lastPrice * ctVal);
  let sz = rawSz;
  if (lotSz > 0) sz = round(Math.round(rawSz / lotSz) * lotSz, 8);
  sz = round(sz, 4);

  log(`张数计算: ${nominalFinal} / (${lastPrice} × ${ctVal}) = ${rawSz} → 取整 ${sz}`);

  if (sz < minSz) {
    const plannedNominal = nominalFinal;
    const minNominal = minSz * lastPrice * ctVal;
    const gapRatio = (minNominal - plannedNominal) / plannedNominal;

    if (gapRatio >= 0.30) {
      log(`⚠️ SKIP: 计划仓位 ${plannedNominal}u | 最小可开 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% ≥ 30% | 跳过条件开仓`, 'WARN');
      return;
    }

    log(`📐 ADJUST: 计划仓位 ${plannedNominal}u → 提升至最小可开 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% < 30% | 按 minSz=${minSz} 执行`);
    sz = minSz;
  }

  // A.4 确定触发参数
  const effectiveTriggerPrice = triggerPrice || (direction === 'long' ? lastPrice * 1.05 : lastPrice * 0.95);
  if (!triggerPrice) {
    log(`⚠️ 未指定 trigger_price,自动推导: ${direction==='long'?'突破追多@'+round(lastPrice*1.05,4):'追空@'+round(lastPrice*0.95,4)}`, 'WARN');
  }

  const triggerParams = getConditionalTriggerParams(direction, effectiveTriggerPrice, lastPrice);
  log(`条件单触发参数: ${triggerParams.intent} | ${triggerParams.field}=${effectiveTriggerPrice} | ${triggerParams.ordField}=-1`);

  // A.5 下单条件单
  const side = direction === 'long' ? 'buy' : 'sell';
  const posSide = direction;

  const algoCmd = `swap algo place --instId ${INST_ID} --side ${side} --ordType conditional --sz ${sz} --tdMode isolated --posSide ${posSide} --${triggerParams.field}=${effectiveTriggerPrice} --${triggerParams.ordField}=-1`;
  logOp(`💰 OPEN-COND: 条件单下单 → ${algoCmd}`);

  const algoResult = runOkxCmd(algoCmd);
  if (!algoResult || !algoResult[0]) throw new Error('条件单下单失败');

  const algoId = algoResult[0].algoId;
  const code = algoResult[0].sCode;
  const msg = algoResult[0].sMsg || '';

  if (code !== '0') {
    log(`⛔ ERROR: 条件单下单失败 | code=${code} msg=${msg}`, 'ERROR');
    throw new Error(`条件单下单失败: ${msg}`);
  }

  logOp(`💰 OPEN-COND: 条件单已挂单 | algoId=${algoId} | ${triggerParams.intent} | 触发价=${effectiveTriggerPrice} | 张数=${sz} | 市价执行`);
  logOp(`💰 OPEN-COND: ⚠️ 成交后由 notify 入场触发警报拉起即时分析 → 设止盈止损`);
}

// ════════════════════════════════════════════
// 7.1-B 限价单开仓 (swap place --ordType limit)
// ════════════════════════════════════════════
async function executeLimitOpen(direction, nominalFinal, stopLoss, tp1, tp2, tp1Ratio, trailingRatio) {
  logOp(`💰 OPEN-LIMIT: 限价单开仓 | direction=${direction} | nominal=${nominalFinal}u`);

  // ═══ 限价单硬性要求: 必须带止盈止损 ═══
  if (!stopLoss || !tp1) {
    log(`⛔ ERROR: 限价单拒绝 — 缺少止盈止损 (SL=${stopLoss}, TP1=${tp1})`, 'ERROR');
    throw new Error('限价单必须有止盈止损');
  }

  // B.1 获取价格和合约信息
  const tickerData = runOkxCmd(`market ticker ${INST_ID}`);
  if (!tickerData || !tickerData[0]) throw new Error('获取价格失败');
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
  // 先计算张数 (不依赖杠杆, 用于查 MMR 档位)
  const rawSz = nominalFinal / (lastPrice * ctVal);
  let sz = rawSz;
  if (lotSz > 0) sz = round(Math.round(rawSz / lotSz) * lotSz, 8);
  sz = round(sz, 4);

  log(`张数计算: ${nominalFinal} / (${lastPrice} × ${ctVal}) = ${rawSz} → 取整 ${sz}`);

  if (sz < minSz) {
    const plannedNominal = nominalFinal;
    const minNominal = minSz * lastPrice * ctVal;
    const gapRatio = (minNominal - plannedNominal) / plannedNominal;

    if (gapRatio >= 0.30) {
      log(`⚠️ SKIP: 计划仓位 ${plannedNominal}u | 最小可开 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% ≥ 30% | 跳过限价开仓`, 'WARN');
      return;
    }

    log(`📐 ADJUST: 计划仓位 ${plannedNominal}u → 提升至最小可开 ${minNominal.toFixed(2)}u | 差距 ${(gapRatio*100).toFixed(0)}% < 30% | 按 minSz=${minSz} 执行`);
    sz = minSz;
  }

  // 获取实际 MMR, 计算杠杆 (SL/TP 已在入口处保证存在)
  // 限价单使用 uncapped 杠杆(不钳制到 minLever), 因成交后无法调保证金
  const expectedEntry = limitPrice || lastPrice;
  const mmr = fetchContractMmr(INST_ID, sz, ctVal, expectedEntry);
  const { rawLever } = (() => {
    const e = num(expectedEntry);
    const sl = num(stopLoss);
    const slDist = Math.abs(e - sl);
    const targetLiqDist = slDist * 1.10;
    const rl = direction === 'long'
      ? e / (targetLiqDist * (1 - mmr) + mmr * e)
      : e / (targetLiqDist * (1 + mmr) + mmr * e);
    return { rawLever: rl };
  })();
  const leverActual = Math.max(1, Math.min(Math.floor(rawLever), maxLever));
  const slDistPct = Math.abs(expectedEntry - stopLoss) / expectedEntry * 100;
  log(`逐仓杠杆(限价单): 入场=${expectedEntry} ${direction} | SL距=${round(slDistPct,2)}% → 目标强平距=${round(slDistPct*1.10,2)}% | 杠杆=${leverActual}x (上限${maxLever}, raw=${rawLever.toFixed(2)}x)`);

  // B.2 设置杠杆
  const leverSetResult = runOkxCmd(`swap leverage --instId ${INST_ID} --lever ${leverActual} --mgnMode isolated --posSide ${direction}`, { retries: 2 });
  if (leverSetResult) {
    log(`杠杆已设置: ${leverActual}x`);
  }

  // B.4 确定限价
  const effectiveLimitPx = limitPrice || (direction === 'long' ? lastPrice * 0.95 : lastPrice * 1.05);
  if (!limitPrice) {
    log(`⚠️ 未指定 limit_price,自动推导: ${direction==='long'?'买单@'+round(lastPrice*0.95,4):'卖单@'+round(lastPrice*1.05,4)}`, 'WARN');
  }

  // B.5 下单限价单
  const side = direction === 'long' ? 'buy' : 'sell';
  const posSide = direction;

  // 限价单可附带 TP/SL: 如果传入了 stopLoss/tp1, 附带到限价单上(成交后自动激活)
  let limitCmd = `swap place --instId ${INST_ID} --side ${side} --ordType limit --sz ${sz} --px ${effectiveLimitPx} --tdMode isolated --posSide ${posSide}`;

  // 附带 TP/SL(必带, 成交后自动激活)
  const tickSz2 = num(contractInfo.tickSz) || 0.00001;
  const slPxOff = calcPnlOffset(effectiveLimitPx, stopLoss, 'sl', direction, tickSz2);
  const tpPxOff = calcPnlOffset(effectiveLimitPx, tp1, 'tp', direction, tickSz2);
  limitCmd += ` --slTriggerPx=${slPxOff} --slOrdPx=-1 --tpTriggerPx=${tpPxOff} --tpOrdPx=-1`;
  log(`附带TP/SL: SL=${slPxOff}, TP1=${tpPxOff}`);

  logOp(`💰 OPEN-LIMIT: 限价单下单 → ${limitCmd}`);

  const limitResult = runOkxCmd(limitCmd);
  if (!limitResult || !limitResult[0]) throw new Error('限价单下单失败');

  const ordId = limitResult[0].ordId;
  const code = limitResult[0].sCode;
  const msg = limitResult[0].sMsg || '';

  if (code !== '0') {
    log(`⛔ ERROR: 限价单下单失败 | code=${code} msg=${msg}`, 'ERROR');
    throw new Error(`限价单下单失败: ${msg}`);
  }

  const intent = direction === 'long' ? (effectiveLimitPx < lastPrice ? '抄底挂单' : '突破挂单') : (effectiveLimitPx > lastPrice ? '高位挂单' : '追空挂单');
  logOp(`💰 OPEN-LIMIT: 限价单已挂单 | ordId=${ordId} | ${intent} | 挂单价=${effectiveLimitPx} | 市价=${lastPrice} | 张数=${sz} | SL=${slPxOff} TP=${tpPxOff}(成交后自动激活)`);
}
*/
// ═══ END: 条件单/限价单已废弃 ═══

})(); // end main()
