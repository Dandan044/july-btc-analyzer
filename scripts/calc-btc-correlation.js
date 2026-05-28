#!/usr/bin/env node
/**
 * calc-btc-correlation.js — 山寨币 BTC 跟踪度计算
 *
 * 用法:
 *   node scripts/calc-btc-correlation.js --coin ETH   [单个币种]
 *   node scripts/calc-btc-correlation.js --coins ETH,SOL,DOGE  [批量]
 *
 * 逻辑:
 *   - 获取 BTC 和目标的 72 根 1H K 线收盘价（3 天）
 *   - 计算对数收益率序列
 *   - Pearson 相关系数
 *   - 输出 [-1, 1] 之间的值
 *
 * 数据源: OKX REST API (public, no auth)
 *   GET /api/v5/market/candles?instId={instId}&bar=1H&limit=72
 */

const { execSync } = require('child_process');

const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const BAR = '1H';
const LIMIT = 72;  // 3 天

// ---- 参数解析 ----
const args = process.argv.slice(2);
let coins = [];

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--coin' || args[i] === '--coins') && i + 1 < args.length) {
    coins = args[i + 1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    i++;
  }
}

if (coins.length === 0) {
  console.error('Usage: node calc-btc-correlation.js --coin ETH');
  console.error('       node calc-btc-correlation.js --coins ETH,SOL,DOGE');
  process.exit(1);
}

// ---- 工具函数 ----

/** 获取 K 线收盘价序列 (从 API 返回 newest→oldest, 调为 oldest→newest) */
function getCloses(coin) {
  const instId = `${coin}-USDT-SWAP`;
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
    
    // OKX candles: [ts, open, high, low, close, vol, volCcy, ...]
    // 返回 newest→oldest, 调转
    const closes = data.data
      .map(c => parseFloat(c[4]))
      .reverse(); // oldest→newest
    
    if (closes.length < LIMIT * 0.8) {
      return { error: `K 线不足: ${instId} 仅有 ${closes.length} 根`, closes: null };
    }
    
    return { error: null, closes };
  } catch (e) {
    return { error: `请求失败: ${instId} - ${e.message}`, closes: null };
  }
}

/** 计算对数收益率序列 */
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

// ---- 主逻辑 ----
async function main() {
  // 1. 获取 BTC K 线（只获取一次）
  process.stderr.write(`[calc-btc-correlation] 获取 BTC 1H K线...\n`);
  const btcResult = getCloses('BTC');
  if (btcResult.error) {
    console.error(btcResult.error);
    process.exit(1);
  }
  const btcRets = logReturns(btcResult.closes);
  process.stderr.write(`[calc-btc-correlation] BTC: ${btcResult.closes.length} 根 → ${btcRets.length} 收益率\n`);

  const results = [];
  
  for (const coin of coins) {
    if (coin === 'BTC') {
      results.push({ coin: 'BTC', correlation: 1.0, status: 'ok', note: 'self' });
      continue;
    }
    
    process.stderr.write(`[calc-btc-correlation] 获取 ${coin} 1H K线...\n`);
    const altResult = getCloses(coin);
    
    if (altResult.error) {
      results.push({ coin, correlation: null, status: 'error', error: altResult.error });
      continue;
    }
    
    const altRets = logReturns(altResult.closes);
    
    // 对齐长度（取较短的）
    const minLen = Math.min(btcRets.length, altRets.length);
    const corr = pearson(btcRets.slice(0, minLen), altRets.slice(0, minLen));
    
    let note = '';
    if (corr === null) {
      note = '计算失败';
    } else if (corr >= 0.7) {
      note = '高跟踪';
    } else if (corr >= 0.4) {
      note = '中跟踪';
    } else if (corr >= 0.2) {
      note = '低跟踪';
    } else if (corr >= 0) {
      note = '弱跟踪';
    } else {
      note = '负相关';
    }
    
    results.push({
      coin,
      correlation: corr !== null ? Math.round(corr * 1000) / 1000 : null,
      status: 'ok',
      candles: altResult.closes.length,
      note
    });
  }
  
  // 输出
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
