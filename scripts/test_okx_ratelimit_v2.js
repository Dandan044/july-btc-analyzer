#!/usr/bin/env node
/**
 * OKX Public API 速率限制测试 v2 (精简版)
 * 聚焦: 找到实际限流阈值
 */
const { execSync } = require('child_process');

const PROXY = 'http://127.0.0.1:7890';
const URL = 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT';

function singleReq() {
  try {
    const out = execSync(
      `curl -s -o /dev/null -w '%{http_code}|%{time_total}' --max-time 8 --proxy "${PROXY}" "${URL}"`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    const [code, t] = out.split('|');
    return { httpCode: parseInt(code), timeMs: parseFloat(t) * 1000 };
  } catch (e) {
    return { httpCode: 0, timeMs: 0, error: e.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBurst(label, n, gapMs) {
  process.stdout.write(`\n[${label}] burst=${n} gap=${gapMs}ms: `);
  let ok = 0, r429 = 0, other = 0, first429 = 0;
  const times = [];
  for (let i = 0; i < n; i++) {
    const r = singleReq();
    times.push(r.timeMs);
    if (r.httpCode === 200) ok++;
    else if (r.httpCode === 429) { r429++; if (!first429) first429 = i + 1; }
    else other++;
    if (gapMs && i < n - 1) await sleep(gapMs);
  }
  const avg = ok > 0 ? (times.reduce((a,b)=>a+b,0)/times.length).toFixed(0) : '-';
  process.stdout.write(`OK=${ok} 429=${r429} avg=${avg}ms`);
  if (first429) process.stdout.write(` first429@#${first429}`);
  console.log('');
  return { ok, r429, other, first429 };
}

async function runSustained(label, total, targetRps) {
  const intervalMs = Math.floor(1000 / targetRps);
  process.stdout.write(`\n[${label}] ${total}req @${targetRps}/s: `);
  let ok = 0, r429 = 0, pending = 0, first429 = 0;
  const times = [];
  const t0 = Date.now();
  
  for (let i = 0; i < total; i++) {
    const loopStart = Date.now();
    const r = singleReq();
    times.push(r.timeMs);
    const elapsed = Date.now() - loopStart;
    
    if (r.httpCode === 200) ok++;
    else if (r.httpCode === 429) { r429++; if (!first429) first429 = i + 1; }
    
    const sleepNeeded = intervalMs - elapsed;
    if (sleepNeeded > 0 && i < total - 1) await sleep(sleepNeeded);
  }
  
  const elapsedS = (Date.now() - t0) / 1000;
  const actualRps = (total / elapsedS).toFixed(1);
  const avg = times.length > 0 ? (times.reduce((a,b)=>a+b,0)/times.length).toFixed(0) : '-';
  process.stdout.write(`OK=${ok} 429=${r429} avg=${avg}ms actual=${actualRps}rps`);
  if (first429) process.stdout.write(` first429@#${first429}`);
  console.log('');
  return { ok, r429, first429, actualRps };
}

async function main() {
  console.log('OKX Public API 速率限制测试 v2');
  console.log(`代理: ${PROXY} | ${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}\n`);
  
  // Step 1: 快速确认连通
  console.log('=== 连通性 ===');
  for (const e of ['ticker','1m klines','OI','taker','longshort']) {
    const ep = {
      ticker: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
      '1m klines': 'https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=1m&limit=3',
      OI: 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D',
      taker: 'https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D',
      longshort: 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D'
    }[e];
    try {
      const out = execSync(`curl -s -o /dev/null -w '%{http_code}|%{time_total}' --max-time 8 --proxy "${PROXY}" "${ep}"`, { encoding: 'utf8', timeout: 10000 }).trim();
      console.log(`  ${e}: ${out}`);
    } catch(ex) { console.log(`  ${e}: FAIL ${ex.message}`); }
  }
  
  // Step 2: 逐步加压 - 连续爆发
  console.log('\n=== 连续爆发 (无间隔) ===');
  await runBurst('B5',  5,  0);
  await runBurst('B10', 10, 0);
  await runBurst('B20', 20, 0);
  
  // Step 3: 找到限流阈值的精确 RPS
  console.log('\n=== 找到限流阈值 ===');
  await runSustained('2rps',  20, 2);
  await runSustained('5rps',  30, 5);
  await runSustained('8rps',  40, 8);
  await runSustained('10rps', 50, 10);
  
  // Step 4: 限流后恢复测试
  console.log('\n=== 限流恢复 ===');
  console.log('  (若上一步出现429，等待10秒后重试...)');
  await sleep(10000);
  const recovery = singleReq();
  console.log(`  恢复请求: HTTP ${recovery.httpCode} (${recovery.timeMs.toFixed(0)}ms)`);
  
  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
