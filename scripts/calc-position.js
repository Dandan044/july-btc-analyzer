#!/usr/bin/env node
/**
 * calc-position.js — 山寨币止损位 & 仓位计算器
 *
 * 基于 BTC 4H ATR(14) 锚定 + 山寨币 ATR(14)×X 动态计算止损位和仓位。
 *
 * 用法:
 *   node calc-position.js --coin YB --direction short --entry 0.13 --x 2.0 --levels 0.155,0.16,0.18
 *   node calc-position.js --coin YB --direction short --entry 0.13 --x 2.0 --levels 0.155,0.16,0.18 --instType SPOT
 *   node calc-position.js --json '{"coin":"YB","dir":"short","entry":0.13,"x":2.0,"levels":[0.155,0.16,0.18]}'
 *
 * 输出: JSON
 *
 * 逻辑:
 *   1. BTC 4H ATR(14) → BTC_ATR% → 基线 = BTC_ATR% × 1.5
 *   2. 山寨 4H ATR(14) → ALT_ATR% → 原始止损% = ALT_ATR% × X
 *   3. 如果原始止损% > 50% → REJECT
 *   4. 向更远处偏移到最近的技术位 → 最终止损价格 & 最终止损%
 *   5. 如果最终止损% > 50% → REJECT
 *   6. 仓位: 最终止损% ≤ BTC基线% → 40; 最终止损% ∈ (基线%, 50%) → 线性 40→20
 */

const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const url = require('url');

// ── 配置 ────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const OKX_BASE = 'https://www.okx.com';
const TIMEOUT_MS = 15000;

// ── HTTP 请求（走代理） ────────────────────────────
function fetchOKX(path) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${OKX_BASE}${path}`;
    const parsed = url.parse(fullUrl);
    const proxy = url.parse(PROXY_URL);

    const opts = {
      hostname: proxy.hostname,
      port: proxy.port || 80,
      path: fullUrl,
      method: 'GET',
      timeout: TIMEOUT_MS,
      headers: {
        'Host': parsed.hostname,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── K线获取 ────────────────────────────────────────
async function getKlines(instId, bar = '4H', limit = 15) {
  const path = `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
  const res = await fetchOKX(path);
  if (res.code !== '0') throw new Error(`OKX API error: ${res.msg}`);
  return res.data.map(c => ({
    ts: parseInt(c[0]),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol: parseFloat(c[5]),
  })).reverse(); // OKX 返回的是最新的在前
}

// ── ATR(14) 计算 ────────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) {
    throw new Error(`需要至少 ${period + 1} 根 K 线，实际 ${candles.length}`);
  }
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }
  // Wilder's smoothing: first ATR = simple average of first N TRs, then smoothed
  if (trValues.length <= period) {
    return trValues.reduce((a, b) => a + b, 0) / trValues.length;
  }
  let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }
  return atr;
}

// ── 寻找最近的技术位（向更远处偏移） ──────────────
function findNearestFartherLevel(rawStopPrice, levels, direction) {
  // direction: 'long' → stop 在 entry 下方 → farther = 价格更低
  // direction: 'short' → stop 在 entry 上方 → farther = 价格更高
  const fartherLevels = levels.filter(lvl => {
    if (direction === 'long') {
      return lvl <= rawStopPrice; // 比 rawStop 更低（更远）
    } else {
      return lvl >= rawStopPrice; // 比 rawStop 更高（更远）
    }
  });

  if (fartherLevels.length === 0) return null; // 没有更远的技术位

  // 找最近的那个
  fartherLevels.sort((a, b) => a - b);
  if (direction === 'long') {
    return fartherLevels[fartherLevels.length - 1]; // 最高（最近）的
  } else {
    return fartherLevels[0]; // 最低（最近）的
  }
}

const MAX_STOP_PCT = 25;

function calcPosition(finalStopPct, btcBaselinePct) {
  if (finalStopPct <= btcBaselinePct) return 40;
  const raw = 40 - 20 * (finalStopPct - btcBaselinePct) / (MAX_STOP_PCT - btcBaselinePct);
  return Math.round(raw);
}

// ── 格式化币种 instId ──────────────────────────────
// 山寨币分析默认使用 SWAP（永续合约），可通过 --instType SPOT 切换
function toInstId(coin, instType = 'SWAP') {
  const upper = coin.toUpperCase();
  // 提取基础币种名：去掉已有的 -USDT 或 -USDT-SWAP 后缀
  const base = upper.replace(/(-USDT)?(-SWAP)?$/, '');
  const suffix = instType === 'SWAP' ? '-USDT-SWAP' : '-USDT';
  return base + suffix;
}

// ── 主流程 ──────────────────────────────────────────
async function main() {
  // 解析参数
  let coin, direction, entry, x, levels, instType = 'SWAP';

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && args[i + 1]) {
      const j = JSON.parse(args[i + 1]);
      coin = j.coin;
      direction = j.dir || j.direction;
      entry = parseFloat(j.entry);
      x = parseFloat(j.x);
      levels = (j.levels || []).map(Number);
      if (j.instType) instType = j.instType.toUpperCase();
      break;
    }
    if (args[i] === '--coin') coin = args[++i];
    if (args[i] === '--direction' || args[i] === '--dir') direction = args[++i];
    if (args[i] === '--entry') entry = parseFloat(args[++i]);
    if (args[i] === '--x') x = parseFloat(args[++i]);
    if (args[i] === '--levels') levels = args[++i].split(',').map(Number);
    if (args[i] === '--instType') instType = args[++i].toUpperCase();
  }

  // 校验
  if (!coin || !direction || !entry || !x || !levels || levels.length === 0) {
    console.error('用法: calc-position.js --coin <COIN> --direction <long|short> --entry <PRICE> --x <1.5-2.0> --levels <L1,L2,...> [--instType SWAP|SPOT]');
    console.error('  or: calc-position.js --json \'{"coin":"YB","dir":"short","entry":0.13,"x":2.0,"levels":[0.155,0.16]}\'');
    console.error('  --instType 默认 SWAP（永续合约），可选 SPOT（现货）');
    process.exit(1);
  }

  direction = direction.toLowerCase();
  instType = instType.toUpperCase();
  if (!['SWAP', 'SPOT'].includes(instType)) {
    console.error('--instType 必须是 SWAP 或 SPOT');
    process.exit(1);
  }
  if (!['long', 'short'].includes(direction)) {
    console.error('--direction 必须是 long 或 short');
    process.exit(1);
  }
  if (x < 1.5 || x > 2.0) {
    console.error(`⚠️ X=${x} 超出推荐范围 [1.5, 2.0]，但仍继续计算`);
  }
  if (isNaN(entry) || entry <= 0) {
    console.error('--entry 必须是正数价格');
    process.exit(1);
  }

  const coinUpper = coin.toUpperCase();

  try {
    // ── 1. 获取 BTC 数据 ──
    const btcInstId = 'BTC-USDT';
    const [btcKlines, btcTicker] = await Promise.all([
      getKlines(btcInstId, '4H', 15),
      fetchOKX(`/api/v5/market/ticker?instId=${btcInstId}`),
    ]);

    const btcPrice = parseFloat(btcTicker.data[0].last);
    const btcATR = calcATR(btcKlines, 14);
    const btcATRPct = (btcATR / btcPrice) * 100;
    const btcBaselinePct = btcATRPct * 1.5;

    // ── 2. 获取山寨币数据 ──
    const altInstId = toInstId(coinUpper, instType);
    const [altKlines, altTicker] = await Promise.all([
      getKlines(altInstId, '4H', 15),
      fetchOKX(`/api/v5/market/ticker?instId=${altInstId}`),
    ]);

    const altPrice = parseFloat(altTicker.data[0].last);
    const altATR = calcATR(altKlines, 14);
    const altATRPct = (altATR / altPrice) * 100;
    const rawStopPct = altATRPct * x;

    // ── 3. 原始止损检查 ──
    if (rawStopPct > MAX_STOP_PCT) {
      console.log(JSON.stringify({
        status: 'REJECT',
        reason: `原始止损幅度 ${rawStopPct.toFixed(2)}% 超过 ${MAX_STOP_PCT}% 上限`,
        btc: { price: btcPrice, atr: btcATR, atr_pct: roundPct(btcATRPct), baseline_pct: roundPct(btcBaselinePct) },
        altcoin: { price: altPrice, atr: altATR, atr_pct: roundPct(altATRPct), x, raw_stop_pct: roundPct(rawStopPct) },
      }, null, 2));
      return;
    }

    // ── 4. 原始止损价格 ──
    const rawStopPrice = direction === 'long'
      ? entry * (1 - rawStopPct / 100)
      : entry * (1 + rawStopPct / 100);

    // ── 5. 向更远处偏移到最近技术位 ──
    const offsetLevel = findNearestFartherLevel(rawStopPrice, levels, direction);
    let finalStopPrice, finalStopPct, offsetNote;

    if (offsetLevel === null) {
      // 没有更远的技术位，使用原始止损
      finalStopPrice = rawStopPrice;
      finalStopPct = rawStopPct;
      offsetNote = '无更远技术位，使用原始 ATR 止损';
    } else {
      finalStopPrice = offsetLevel;
      finalStopPct = direction === 'long'
        ? ((entry - offsetLevel) / entry) * 100
        : ((offsetLevel - entry) / entry) * 100;
      offsetNote = `从 ${rawStopPct.toFixed(2)}% 偏移至技术位 $${offsetLevel}`;
    }

    // ── 6. 最终止损检查 ──
    if (finalStopPct > MAX_STOP_PCT) {
      console.log(JSON.stringify({
        status: 'REJECT',
        reason: `偏移后止损幅度 ${finalStopPct.toFixed(2)}% 超过 ${MAX_STOP_PCT}% 上限`,
        btc: { price: btcPrice, atr: btcATR, atr_pct: roundPct(btcATRPct), baseline_pct: roundPct(btcBaselinePct) },
        altcoin: { price: altPrice, atr: altATR, atr_pct: roundPct(altATRPct), x, raw_stop_pct: roundPct(rawStopPct) },
        offset: { raw_stop_price: rawStopPrice, final_stop_price: finalStopPrice, final_stop_pct: roundPct(finalStopPct), note: offsetNote },
        position: null,
      }, null, 2));
      return;
    }

    // ── 7. 仓位计算 ──
    const position = calcPosition(finalStopPct, btcBaselinePct);

    // ── 8. 输出 ──
    const result = {
      status: 'OK',
      btc: {
        price: btcPrice,
        atr_4h_14: roundPrice(btcATR),
        atr_pct: roundPct(btcATRPct),
        baseline_pct: roundPct(btcBaselinePct),
      },
      altcoin: {
        symbol: coinUpper,
        inst_id: altInstId,
        price: altPrice,
        atr_4h_14: roundPrice(altATR),
        atr_pct: roundPct(altATRPct),
        x,
        raw_stop_pct: roundPct(rawStopPct),
        raw_stop_price: roundPrice(rawStopPrice),
      },
      offset: {
        direction: 'farther',
        raw_stop_price: roundPrice(rawStopPrice),
        raw_stop_pct: roundPct(rawStopPct),
        nearest_farther_level: offsetLevel ? roundPrice(offsetLevel) : null,
        final_stop_price: roundPrice(finalStopPrice),
        final_stop_pct: roundPct(finalStopPct),
        note: offsetNote,
      },
      position: {
        size: position,
        nominal_value: `${position}u`,
        formula: `40 - 20 × (${finalStopPct.toFixed(2)} - ${btcBaselinePct.toFixed(2)}) / (${MAX_STOP_PCT} - ${btcBaselinePct.toFixed(2)}) = ${position}`,
      },
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ status: 'ERROR', message: err.message }, null, 2));
    process.exit(1);
  }
}

function roundPct(v) { return parseFloat(v.toFixed(2)); }
function roundPrice(v) { return parseFloat(v.toFixed(8)); }

main();
