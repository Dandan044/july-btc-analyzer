#!/usr/bin/env node
/**
 * calc-alt-hedge-y.js — 山寨币 BTC 趋势对冲系数计算
 *
 * 用法:
 *   node scripts/calc-alt-hedge-y.js --coin ETH --direction long --btc-trend bearish
 *
 * 逻辑:
 *   1. 判逆势: 山寨方向 vs BTC 趋势
 *      - btc=bearish, alt=long    → 逆势
 *      - btc=bullish, alt=short   → 逆势
 *      - 其他/btc=sideways       → 顺势 (y=1.0)
 *
 *   2. 若逆势: 获取 BTC 跟踪度 corr
 *      y = 1.0 - 0.5 × (corr - CORR_MIN) / (CORR_MAX - CORR_MIN)
 *      clamped [0.5, 1.0]
 *
 *   3. 若顺势/震荡: y = 1.0
 *
 * 基准常量:
 *   CORR_MAX = 0.85  (ETH/SOL 级别最高 BTC 跟踪度)
 *   CORR_MIN = 0.15  (强庄币最低 BTC 跟踪度)
 */

const { execSync } = require('child_process');
const path = require('path');

// ---- 基准常量 ----
const CORR_MIN = 0.15;
const CORR_MAX = 0.85;

// ---- 配置 ----
const PROXY_URL = 'http://127.0.0.1:7890';
const BAR = '1H';
const LIMIT = 72;

// ---- 参数解析 ----
const args = process.argv.slice(2);
let coin = null, direction = null, btcTrend = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--coin' && i + 1 < args.length) {
    coin = args[++i].toUpperCase();
  } else if (args[i] === '--direction' && i + 1 < args.length) {
    direction = args[++i].toLowerCase();
  } else if (args[i] === '--btc-trend' && i + 1 < args.length) {
    btcTrend = args[++i].toLowerCase();
  }
}

if (!coin || !direction || !btcTrend) {
  console.error('Usage: node calc-alt-hedge-y.js --coin ETH --direction long --btc-trend bearish');
  process.exit(1);
}

if (!['long', 'short'].includes(direction)) {
  console.error('direction must be "long" or "short"');
  process.exit(1);
}

if (!['bullish', 'bearish', 'sideways'].includes(btcTrend)) {
  console.error('btc-trend must be "bullish", "bearish", or "sideways"');
  process.exit(1);
}

// ---- 工具函数 ----

/** 判断是否逆势 */
function isCounterTrend(altDir, btcTrend) {
  if (btcTrend === 'sideways') return false;
  if (btcTrend === 'bearish' && altDir === 'long') return true;
  if (btcTrend === 'bullish' && altDir === 'short') return true;
  return false;
}

/** 获取 K 线收盘价序列 */
function getCloses(coinSymbol) {
  const instId = `${coinSymbol}-USDT-SWAP`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${BAR}&limit=${LIMIT}`;
  
  try {
    const raw = execSync(
      `curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`,
      { encoding: 'utf8', timeout: 20000 }
    );
    const data = JSON.parse(raw);
    
    if (!data.data || data.data.length === 0) {
      return { error: `无 K 线数据: ${instId}`, closes: null };
    }
    
    const closes = data.data
      .map(c => parseFloat(c[4]))
      .reverse();
    
    if (closes.length < LIMIT * 0.8) {
      return { error: `K 线不足: ${instId} (${closes.length}/${LIMIT})`, closes: null };
    }
    
    return { error: null, closes };
  } catch (e) {
    return { error: `请求失败: ${instId} - ${e.message}`, closes: null };
  }
}

/** 对数收益率 */
function logReturns(closes) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  return rets;
}

/** Pearson 相关系数 */
function pearson(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n === 0) return null;
  
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  
  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

/** 计算 BTC 跟踪度 */
function calcBtcCorrelation(coinSymbol) {
  // 获取 BTC K 线
  const btcResult = getCloses('BTC');
  if (btcResult.error) return { error: `BTC K线: ${btcResult.error}`, corr: null };
  
  // 获取山寨 K 线
  const altResult = getCloses(coinSymbol);
  if (altResult.error) return { error: `{coinSymbol} K线: ${altResult.error}`, corr: null };
  
  // 计算相关系数
  const btcRets = logReturns(btcResult.closes);
  const altRets = logReturns(altResult.closes);
  const minLen = Math.min(btcRets.length, altRets.length);
  
  const corr = pearson(btcRets.slice(0, minLen), altRets.slice(0, minLen));
  
  return { error: null, corr, btcCandles: btcResult.closes.length, altCandles: altResult.closes.length };
}

// ---- 主逻辑 ----
function main() {
  const counter = isCounterTrend(direction, btcTrend);
  
  // 顺势/震荡: 不调整
  if (!counter) {
    const result = {
      coin,
      direction,
      btc_trend: btcTrend,
      is_counter: false,
      corr: null,
      y: 1.0,
      hedge_action: 'none',
      note: btcTrend === 'sideways' ? 'BTC 震荡，不调整' : '顺势，不调整'
    };
    output(result);
    return;
  }
  
  // 逆势: 计算 BTC 跟踪度
  const corrResult = calcBtcCorrelation(coin);
  
  if (corrResult.error || corrResult.corr === null) {
    // 跟踪度计算失败 → 视为中等跟踪度，y ≈ 0.75
    const fallbackCorr = 0.5;
    const yFallback = clampY(1.0 - 0.5 * (fallbackCorr - CORR_MIN) / (CORR_MAX - CORR_MIN));
    const result = {
      coin,
      direction,
      btc_trend: btcTrend,
      is_counter: true,
      corr: null,
      corr_error: corrResult.error || '计算失败',
      y: yFallback,
      hedge_action: yFallback < 0.95 ? 'reduce' : 'none',
      note: `BTC 跟踪度计算失败，回退使用中等跟踪度 corr=${fallbackCorr} → y=${yFallback}`
    };
    output(result);
    return;
  }
  
  let corr = corrResult.corr;
  
  // 负相关视为 0（不跟踪）
  if (corr < 0) corr = 0;
  
  // y = 1.0 - 0.5 × (corr - CORR_MIN) / (CORR_MAX - CORR_MIN)
  const yRaw = 1.0 - 0.5 * (corr - CORR_MIN) / (CORR_MAX - CORR_MIN);
  const y = clampY(yRaw);
  
  let hedgeAction = 'none';
  if (y < 0.55) hedgeAction = 'heavy_reduce';
  else if (y < 0.85) hedgeAction = 'reduce';
  else hedgeAction = 'none';
  
  const result = {
    coin,
    direction,
    btc_trend: btcTrend,
    is_counter: true,
    corr: round3(corr),
    btc_candles: corrResult.btcCandles,
    alt_candles: corrResult.altCandles,
    y: round3(y),
    hedge_action: hedgeAction,
    formula: `y = 1.0 - 0.5 × (${round3(corr)} - ${CORR_MIN}) / (${CORR_MAX} - ${CORR_MIN})`
  };
  
  output(result);
}

// ---- 输出 ----
function output(data) {
  // 始终输出 JSON（stage3 用 python3 解析）
  console.log(JSON.stringify(data, null, 2));
}

function clampY(y) {
  return Math.max(0.5, Math.min(1.0, y));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

main();
