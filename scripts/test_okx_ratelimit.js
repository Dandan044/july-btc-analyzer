#!/usr/bin/env node
/**
 * OKX Public API 速率限制测试
 * 
 * 测试方法:
 * 1. 单接口并发测试 - 逐步增加并发数，检测 429 响应
 * 2. 多接口混合测试 - 模拟警报器实际场景（ticker + klines + OI + taker）
 */
const { execSync } = require('child_process');

const PROXY = 'http://127.0.0.1:7890';

// 测试的 OKX public endpoints
const ENDPOINTS = [
  { name: 'ticker',     url: (s) => `https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT` },
  { name: '1m klines',  url: (s) => `https://www.okx.com/api/v5/market/history-candles?instId=${s}-USDT&bar=1m&limit=3` },
  { name: '1H klines',  url: (s) => `https://www.okx.com/api/v5/market/history-candles?instId=${s}-USDT&bar=1H&limit=4` },
  { name: 'OI',         url: () => `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D` },
  { name: 'taker',      url: () => `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D` },
  { name: 'longshort',  url: () => `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D` },
];

function singleRequest(endpoint) {
  const start = Date.now();
  try {
    const url = typeof endpoint.url === 'function' ? endpoint.url('BTC') : endpoint.url;
    const cmd = `curl -s -o /dev/null -w '%{http_code}|%{time_total}' --max-time 10 --proxy "${PROXY}" "${url}"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 12000 }).trim();
    const [httpCode, timeTotal] = output.split('|');
    return { endpoint: endpoint.name, httpCode: parseInt(httpCode), timeMs: parseFloat(timeTotal) * 1000, success: httpCode === '200', latency: Date.now() - start };
  } catch (e) {
    return { endpoint: endpoint.name, httpCode: 0, timeMs: 0, success: false, error: e.message, latency: Date.now() - start };
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 测试1: 单接口爆发测试 ============
async function testBurst(endpoint, burstSize, gapMs = 50) {
  console.log(`\n[测试] ${endpoint.name} — 爆发${burstSize}个请求, 间隔${gapMs}ms`);
  const results = [];
  let first429 = null;
  let rate429Count = 0;
  
  for (let i = 0; i < burstSize; i++) {
    const r = singleRequest(endpoint);
    results.push(r);
    
    if (r.httpCode === 429) {
      rate429Count++;
      if (!first429) first429 = i + 1;
    }
    
    if (gapMs > 0 && i < burstSize - 1) {
      await sleep(gapMs);
    }
  }
  
  const ok = results.filter(r => r.success);
  const avgLatency = ok.length > 0 ? (ok.reduce((a,r) => a + r.timeMs, 0) / ok.length).toFixed(0) : '-';
  
  console.log(`  结果: ${ok.length}/${burstSize} 成功, ${rate429Count} 次限流(429)`);
  console.log(`  平均延迟: ${avgLatency}ms`);
  if (first429) console.log(`  首次429在第${first429}个请求`);
  
  return { results, first429, rate429Count };
}

// ============ 测试2: 持续高频测试 ============
async function testSustained(endpoint, totalRequests, rps) {
  const intervalMs = Math.floor(1000 / rps);
  console.log(`\n[测试] ${endpoint.name} — 持续${totalRequests}个请求 @ ${rps} req/s`);
  
  let success = 0, fail429 = 0, failOther = 0;
  const latencies = [];
  let first429At;
  
  for (let i = 0; i < totalRequests; i++) {
    const startTime = Date.now();
    const r = singleRequest(endpoint);
    const elapsed = Date.now() - startTime;
    
    if (r.success) {
      success++;
      latencies.push(r.timeMs);
    } else if (r.httpCode === 429) {
      fail429++;
      if (!first429At) first429At = i + 1;
    } else {
      failOther++;
    }
    
    // 保持目标 RPS
    if (elapsed < intervalMs && i < totalRequests - 1) {
      await sleep(intervalMs - elapsed);
    }
  }
  
  const avgLatency = latencies.length > 0 ? (latencies.reduce((a,b) => a+b, 0) / latencies.length).toFixed(0) : '-';
  console.log(`  成功: ${success}, 限流429: ${fail429}, 其他失败: ${failOther}`);
  console.log(`  平均延迟: ${avgLatency}ms`);
  if (first429At) console.log(`  首次429在第${first429At}个请求`);
  return { success, fail429, failOther, first429At, avgLatency };
}

// ============ 测试3: 多接口混合（模拟警报器）============
async function testMixed(rounds, concurrency = 3) {
  console.log(`\n[测试] 多接口混合 — ${rounds}轮, 每轮${concurrency}并发 (共${rounds * concurrency}请求)`);
  
  // 只测 core 四个接口
  const coreEndpoints = ENDPOINTS.filter(e => ['ticker','1m klines','OI','taker'].includes(e.name));
  
  let totalSuccess = 0, total429 = 0, totalOther = 0;
  
  for (let r = 0; r < rounds; r++) {
    // 当前警报器场景：ticker + 1m klines + OI + taker (4个请求同时)
    const promises = coreEndpoints.map(e => {
      return new Promise(resolve => {
        const result = singleRequest(e);
        resolve(result);
      });
    });
    
    const results = await Promise.all(promises);
    for (const r of results) {
      if (r.success) totalSuccess++;
      else if (r.httpCode === 429) total429++;
      else totalOther++;
    }
    
    console.log(`  轮${r+1}: ${results.map(r => `${r.endpoint}=${r.httpCode}`).join(' ')} | ${results.map(r => r.timeMs.toFixed(0)+'ms').join(',')}`);
    
    // 模拟实际间隔（警报器最短间隔3分钟）
    if (r < rounds - 1) await sleep(3000);
  }
  
  console.log(`  合计: 成功${totalSuccess}, 限流429:${total429}, 其他:${totalOther}`);
}

// ============ 测试4: 极限冲刺（找到硬限制）============
async function testMaxQPS(endpoint, durationMs = 5000) {
  console.log(`\n[测试] ${endpoint.name} — 极限冲刺 ${durationMs/1000}s (无间隔并发)`);
  
  const startTime = Date.now();
  let count = 0, success = 0, fail429 = 0, failOther = 0;
  const endpointStart = Date.now();
  
  while (Date.now() - startTime < durationMs) {
    const r = singleRequest(endpoint);
    count++;
    if (r.success) success++;
    else if (r.httpCode === 429) fail429++;
    else failOther++;
    
    // 无间隔，直接发下一个
    await sleep(10); // 微小间隔避免 curl 自身阻塞
  }
  
  const elapsed = (Date.now() - startTime) / 1000;
  const actualQPS = (count / elapsed).toFixed(1);
  console.log(`  总请求: ${count} in ${elapsed.toFixed(1)}s (${actualQPS} req/s)`);
  console.log(`  成功: ${success}, 限流429: ${fail429}, 其他失败: ${failOther}`);
  if (fail429 > 0) {
    console.log(`  → 限流生效于 ~${(success / elapsed).toFixed(0)} req/s`);
  }
  return { count, success, fail429, actualQPS: parseFloat(actualQPS) };
}

// ============ 主流程 ============
async function main() {
  console.log('========================================');
  console.log('  OKX Public API 速率限制测试');
  console.log(`  代理: ${PROXY}`);
  console.log(`  时间: ${new Date().toISOString()}`);
  console.log('========================================');
  
  // 1. 连通性检查
  console.log('\n▶ 阶段0: 连通性检查');
  for (const ep of ENDPOINTS) {
    const r = singleRequest(ep);
    console.log(`  ${ep.name}: HTTP ${r.httpCode} (${r.timeMs.toFixed(0)}ms)`);
  }
  
  // 2. 小爆发测试 (5个请求, 50ms间隔)
  console.log('\n▶ 阶段1: 小爆发测试 (burst=5, gap=50ms)');
  await testBurst(ENDPOINTS[0], 5, 50);
  
  // 3. 中爆发测试 (10个请求, 50ms间隔)
  console.log('\n▶ 阶段2: 中爆发测试 (burst=10, gap=50ms)');
  await testBurst(ENDPOINTS[0], 10, 50);
  
  // 4. 持续高频测试 (1 req/s, 20请求)
  console.log('\n▶ 阶段3: 持续低频 (1 req/s × 20)');
  await testSustained(ENDPOINTS[0], 20, 1);
  
  // 5. 持续中频测试 (5 req/s, 30请求)
  console.log('\n▶ 阶段4: 持续中频 (5 req/s × 30)');
  await testSustained(ENDPOINTS[0], 30, 5);
  
  // 6. 持续高频测试 (10 req/s, 40请求)
  console.log('\n▶ 阶段5: 持续高频 (10 req/s × 40)');
  await testSustained(ENDPOINTS[0], 40, 10);
  
  // 7. 混合场景测试
  console.log('\n▶ 阶段6: 混合场景 (模拟警报器)');
  await testMixed(5, 4);
  
  // 8. 极限冲刺
  console.log('\n▶ 阶段7: 极限冲刺');
  await testMaxQPS(ENDPOINTS[0], 5000);
  
  console.log('\n========================================');
  console.log('  测试完成');
  console.log('========================================');
}

main().catch(console.error);
