#!/usr/bin/env node
/**
 * OKX Public API 速率限制测试 v3 — 真并发版
 * 使用 Node.js 异步并发而非串行 curl，突破代理延迟瓶颈
 */
const https = require('https');
const http = require('http');
const url = require('url');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 7890;

// 测试 endpoints
const ENDPOINTS = {
  ticker: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
  klines: 'https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=1m&limit=3',
  oi:     'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D',
  taker:  'https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D',
};

function requestViaProxy(targetUrl) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const parsed = url.parse(targetUrl);
    
    const opts = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: targetUrl,
      method: 'GET',
      headers: {
        'Host': parsed.hostname,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      timeout: 10000
    };
    
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const elapsed = Date.now() - t0;
        resolve({
          code: res.statusCode,
          timeMs: elapsed,
          bodyLen: data.length,
          success: res.statusCode === 200
        });
      });
    });
    
    req.on('error', (e) => {
      resolve({ code: 0, timeMs: Date.now() - t0, error: e.message, success: false });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ code: 0, timeMs: Date.now() - t0, error: 'timeout', success: false });
    });
    
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function summary(results) {
  const ok = results.filter(r => r.success);
  const r429 = results.filter(r => r.code === 429);
  const err = results.filter(r => !r.success && r.code !== 429);
  const avg = ok.length > 0 ? (ok.reduce((a,r) => a + r.timeMs, 0) / ok.length).toFixed(0) : '-';
  return { total: results.length, ok: ok.length, r429: r429.length, err: err.length, avgMs: avg };
}

async function runConcurrent(label, concurrency, totalRequests, endpoint = 'ticker') {
  process.stdout.write(`\n[${label}] ${endpoint} x${concurrency}并发 x${totalRequests}总: `);
  const t0 = Date.now();
  const allResults = [];
  let idx = 0;
  let first429 = 0;
  
  while (idx < totalRequests) {
    const batch = [];
    const batchSize = Math.min(concurrency, totalRequests - idx);
    for (let i = 0; i < batchSize; i++) batch.push(requestViaProxy(ENDPOINTS[endpoint]));
    
    const batchResults = await Promise.all(batch);
    for (const r of batchResults) {
      idx++;
      allResults.push(r);
      if (r.code === 429 && !first429) first429 = idx;
    }
    
    // 短暂间隔防止 CPU 过载
    if (idx < totalRequests) await sleep(50);
  }
  
  const elapsed = (Date.now() - t0) / 1000;
  const s = summary(allResults);
  const actualRps = (s.total / elapsed).toFixed(1);
  const label_out = `${s.ok}/${s.total} OK avg=${s.avgMs}ms rps=${actualRps}`;
  process.stdout.write(label_out);
  if (s.r429 > 0) {
    process.stdout.write(` ⚠️429×${s.r429} first@#${first429}`);
  }
  if (s.err > 0) {
    process.stdout.write(` ❌err×${s.err}`);
  }
  process.stdout.write('\n');
  return { ...s, actualRps: parseFloat(actualRps), first429, elapsed };
}

async function runAllEndpoints(label, rounds) {
  process.stdout.write(`\n[${label}] 4接口混合 ×${rounds}轮: `);
  const t0 = Date.now();
  const allResults = [];
  
  for (let i = 0; i < rounds; i++) {
    const names = Object.keys(ENDPOINTS);
    const batch = names.map(n => requestViaProxy(ENDPOINTS[n]));
    const batchResults = await Promise.all(batch);
    allResults.push(...batchResults);
    if (i < rounds - 1) await sleep(500);
  }
  
  const elapsed = (Date.now() - t0) / 1000;
  const s = summary(allResults);
  process.stdout.write(`${s.ok}/${s.total} OK avg=${s.avgMs}ms rps=${(s.total/elapsed).toFixed(1)} | 429×${s.r429}`);
  if (s.r429 > 0) process.stdout.write(' ⚠️');
  process.stdout.write('\n');
  return s;
}

async function main() {
  console.log('OKX Public API 速率限制测试 v3 (真并发)');
  console.log(`代理: http://${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`时间: ${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`);
  
  // 1. 连通性 & 单请求延迟
  console.log('\n=== 基准延迟 ===');
  for (const [name, ep] of Object.entries(ENDPOINTS)) {
    const r = await requestViaProxy(ep);
    console.log(`  ${name}: HTTP ${r.code} | ${r.timeMs}ms`);
  }
  
  // 2. 逐步加压 — 真并发
  console.log('\n=== 并发加压测试 ===');
  await runConcurrent('C2',  2,  10);
  await runConcurrent('C3',  3,  15);
  await runConcurrent('C5',  5,  25);
  await runConcurrent('C8',  8,  40);
  await runConcurrent('C10', 10, 50);
  await runConcurrent('C15', 15, 60);
  await runConcurrent('C20', 20, 80);
  
  // 3. 混合场景
  console.log('\n=== 混合场景 ===');
  await runAllEndpoints('MIX', 10);
  
  // 4. 极限冲刺 (20并发持续5秒)
  console.log('\n=== 极限冲刺 (20并发,5秒) ===');
  const t0 = Date.now();
  const allResults = [];
  while (Date.now() - t0 < 5000) {
    const batch = [];
    for (let i = 0; i < 20; i++) batch.push(requestViaProxy(ENDPOINTS.ticker));
    const batchResults = await Promise.all(batch);
    allResults.push(...batchResults);
  }
  const s = summary(allResults);
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`  总请求: ${s.total} in ${elapsed.toFixed(1)}s (${(s.total/elapsed).toFixed(1)} rps)`);
  console.log(`  成功: ${s.ok} | 429限流: ${s.r429} | 错误: ${s.err}`);
  if (s.r429 > 0) {
    // 找到第一个429的位置
    const first429Idx = allResults.findIndex(r => r.code === 429);
    const first429Time = first429Idx >= 0 ? allResults[first429Idx].timeMs : '?';
    console.log(`  → 限流在 ~${first429Idx+1}个请求后触发 (~${(first429Idx/elapsed).toFixed(0)} rps 时)`);
  }
  
  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
