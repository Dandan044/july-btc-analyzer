#!/usr/bin/env node
/**
 * calc-btc-correlation.js — 山寨币 BTC 跟踪度计算（多时间框架 + Beta + 下行半相关）
 *
 * 用法:
 *   node scripts/calc-btc-correlation.js --coin ETH
 *   node scripts/calc-btc-correlation.js --coins JTO,NEAR,TON,W
 *
 * 输出指标:
 *   - Pearson 相关系数（方向一致性）
 *   - Beta 系数（幅度放大倍数: BTC 1% → ALT β%）
 *   - 下行半相关（仅 BTC 下跌区间的 Pearson）
 *
 * 时间框架: 1H(3天) / 4H(3天) / 1D(7天)
 */

const { execSync } = require('child_process');

const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';

const TIMEFRAMES = [
  { bar: '1H', limit: 72, label: '1H(3天)' },
  { bar: '4H', limit: 18, label: '4H(3天)' },
  { bar: '1D', limit: 7,  label: '1D(7天)' },
];

// ---- 参数 ----
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
  process.exit(1);
}

// ---- 工具 ----
function getCloses(coin, bar, limit) {
  const instId = `${coin}-USDT-SWAP`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
  try {
    const raw = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, { encoding: 'utf8', timeout: 20000 });
    const data = JSON.parse(raw);
    if (!data.data || data.data.length === 0) return { error: `无数据: ${instId} ${bar}`, closes: null };
    const closes = data.data.map(c => parseFloat(c[4])).reverse();
    if (closes.length < limit * 0.8) return { error: `K线不足: ${closes.length}/${limit}`, closes: null };
    return { error: null, closes };
  } catch (e) {
    return { error: `${instId} ${bar}: ${e.message}`, closes: null };
  }
}

function logReturns(closes) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  return rets;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n === 0) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

function beta(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n === 0) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; cov += dx * (ys[i] - my); vx += dx * dx; }
  if (vx === 0) return null;
  return cov / vx;
}

function downsideCorrelation(btcRets, altRets) {
  const n = Math.min(btcRets.length, altRets.length);
  const bd = [], ad = [];
  for (let i = 0; i < n; i++) { if (btcRets[i] < 0) { bd.push(btcRets[i]); ad.push(altRets[i]); } }
  if (bd.length < 5) return { corr: null, count: bd.length, note: '样本不足(<5)' };
  return { corr: pearson(bd, ad), count: bd.length, note: null };
}

function noteFor(corr) {
  if (corr === null) return '失败';
  if (corr >= 0.7) return '高跟踪';
  if (corr >= 0.4) return '中跟踪';
  if (corr >= 0.2) return '低跟踪';
  if (corr >= 0) return '弱跟踪';
  return '负相关';
}

// ---- 主逻辑 ----
async function main() {
  const results = [];

  for (const coin of coins) {
    if (coin === 'BTC') {
      results.push({ coin, timeframes: { '1H(3天)': { correlation: 1, beta: 1, downside_corr: 1, downside_count: 0 } }, status: 'ok', note: 'self' });
      continue;
    }

    const tfResults = {};
    let ok = false;

    for (const tf of TIMEFRAMES) {
      process.stderr.write(`[calc-btc-correlation] ${coin} ${tf.label}...\n`);
      const btc = getCloses('BTC', tf.bar, tf.limit);
      const alt = getCloses(coin, tf.bar, tf.limit);
      if (btc.error || alt.error) { tfResults[tf.label] = { error: btc.error || alt.error }; continue; }

      const br = logReturns(btc.closes);
      const ar = logReturns(alt.closes);
      const ml = Math.min(br.length, ar.length);

      const c = pearson(br.slice(0, ml), ar.slice(0, ml));
      const b = beta(br.slice(0, ml), ar.slice(0, ml));
      const ds = downsideCorrelation(br, ar);

      tfResults[tf.label] = {
        correlation: c !== null ? Math.round(c * 1000) / 1000 : null,
        beta: b !== null ? Math.round(b * 1000) / 1000 : null,
        downside_corr: ds.corr !== null ? Math.round(ds.corr * 1000) / 1000 : null,
        downside_count: ds.count,
        candles: alt.closes.length,
      };
      ok = true;
    }

    if (!ok) { results.push({ coin, timeframes: {}, status: 'error', error: '所有框架获取失败' }); continue; }

    results.push({ coin, timeframes: tfResults, status: 'ok', note: noteFor(tfResults['1H(3天)']?.correlation) });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
