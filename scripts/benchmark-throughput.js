#!/usr/bin/env node
/**
 * OpenClaw 模型吞吐速率基准测试
 *
 * 用法:
 *   node scripts/benchmark-throughput.js                         # 测试每个供应商一个代表模型
 *   node scripts/benchmark-throughput.js --all                   # 测试所有模型
 *   node scripts/benchmark-throughput.js --model deepseek/deepseek-v4-flash
 *   node scripts/benchmark-throughput.js --concurrency 5 --requests 10
 *   node scripts/benchmark-throughput.js --stream                # 使用流式 API
 *   node scripts/benchmark-throughput.js --output results.json   # 导出结果
 *   node scripts/benchmark-throughput.js --timeout 60            # 单请求超时（秒）
 *
 * 环境变量:
 *   OPENCLAW_PORT     (默认: 18789)
 *   OPENCLAW_TOKEN    (默认: 从配置文件读取)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── 配置 ───
const CONFIG_PATH = path.resolve(__dirname, '..', 'openclaw.json');
if (!fs.existsSync(CONFIG_PATH)) {
  // fallback: try standard location
}

const DEFAULT_PORT = 18789;

// ─── 参数解析 ───
const args = process.argv.slice(2);
const flags = {
  all: args.includes('--all'),
  stream: args.includes('--stream'),
  concurrency: 3,
  requests: 5,
  timeout: 120,
  model: null,
  output: null,
  verbose: args.includes('--verbose') || args.includes('-v'),
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--concurrency' && i + 1 < args.length) flags.concurrency = parseInt(args[++i]);
  if (args[i] === '--requests' && i + 1 < args.length) flags.requests = parseInt(args[++i]);
  if (args[i] === '--timeout' && i + 1 < args.length) flags.timeout = parseInt(args[++i]);
  if (args[i] === '--model' && i + 1 < args.length) flags.model = args[++i];
  if (args[i] === '--output' && i + 1 < args.length) flags.output = args[++i];
}

// ─── 从配置文件读取 token ───
function getConfig() {
  try {
    const raw = fs.readFileSync(
      '/home/administrator/.openclaw/openclaw.json', 'utf8'
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getAuthToken(config) {
  return config?.gateway?.auth?.token;
}

function getPort(config) {
  return config?.gateway?.port || DEFAULT_PORT;
}

// ─── 提取所有模型 ───
function extractModels(config) {
  const providers = config?.models?.providers || {};
  const result = [];

  for (const [provider, pconf] of Object.entries(providers)) {
    const models = pconf.models || [];
    for (const m of models) {
      const id = m.id || m.name || '?';
      const name = m.name || id;
      const qualified = `${provider}/${id}`;
      result.push({
        provider,
        id,
        name,
        qualified,
        reasoning: !!m.reasoning,
        api: m.api || pconf.api || 'openai-completions',
        baseUrl: pconf.baseUrl || '',
      });
    }
  }
  return result;
}

// ─── 获取代表模型（每个 provider 一个） ───
function getRepresentativeModels(models) {
  const seen = new Set();
  return models.filter(m => {
    // prefer non-reasoning models for speed test (faster responses)
    if (seen.has(m.provider)) return false;
    seen.add(m.provider);
    return true;
  });
}

// ─── HTTP 请求 ───
function httpRequest(options, body, stream = false) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      let firstChunkTime = null;
      let startTime = Date.now();

      if (stream) {
        // 流式：累积直到收到第一个 data 事件（不解析完整 SSE）
        res.once('data', (chunk) => {
          firstChunkTime = Date.now();
        });
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
            ttft: firstChunkTime ? firstChunkTime - startTime : null,
            totalTime: Date.now() - startTime,
          });
        });
      } else {
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
            ttft: null,
            totalTime: Date.now() - startTime,
          });
        });
      }
    });

    req.on('error', reject);
    req.setTimeout(flags.timeout * 1000, () => {
      req.destroy(new Error(`Request timeout after ${flags.timeout}s`));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ─── 发送单次 chat completion 请求 ───
async function sendCompletion(host, port, token, model, stream = false) {
  const body = JSON.stringify({
    model: model.qualified,
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Keep responses very short.' },
      { role: 'user', content: 'Reply only with the word "ok".' },
    ],
    max_tokens: 10,
    temperature: 0.1,
    stream,
  });

  const startTime = Date.now();
  const res = await httpRequest(
    {
      hostname: host,
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body,
    stream
  );

  const result = {
    model: model.qualified,
    status: res.status,
    totalTime: res.totalTime,
    ttft: res.ttft,
    success: res.status >= 200 && res.status < 300,
    error: null,
  };

  if (result.success) {
    try {
      const parsed = JSON.parse(res.body);
      result.usage = parsed.usage || null;
      if (parsed.usage) {
        result.inputTokens = parsed.usage.prompt_tokens || 0;
        result.outputTokens = parsed.usage.completion_tokens || 0;
        result.totalTokens = parsed.usage.total_tokens || 0;
      }
      result.content = parsed.choices?.[0]?.message?.content || '';
    } catch (e) {
      result.parseError = e.message;
    }
  } else {
    result.error = res.body.slice(0, 200);
  }

  return result;
}

// ─── 并发测试单一模型 ───
async function testModel(host, port, token, model, concurrency, numRequests, useStream) {
  const allStart = Date.now();
  const batch = [];

  // 创建并发请求池
  for (let i = 0; i < numRequests; i++) {
    batch.push(sendCompletion(host, port, token, model, useStream));
  }

  const results = await Promise.allSettled(batch);

  const allEnd = Date.now();
  const elapsed = allEnd - allStart;

  const succeeded = [];
  const failed = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.success) {
        succeeded.push(r.value);
      } else {
        failed.push(r.value);
      }
    } else {
      failed.push({ error: r.reason?.message || 'Unknown rejection' });
    }
  }

  // 统计
  const totalTimes = succeeded.map(r => r.totalTime);
  const tokensPerReq = succeeded.map(r => r.totalTokens || 0);
  const outputTokensPerReq = succeeded.map(r => r.outputTokens || 0);

  const stats = {
    model: model.qualified,
    provider: model.provider,
    name: model.name || model.id,
    reasoning: model.reasoning,
    api: model.api,
    concurrency,
    requestsAttempted: numRequests,
    succeeded: succeeded.length,
    failed: failed.length,
    successRate: `${((succeeded.length / numRequests) * 100).toFixed(1)}%`,
    elapsedMs: elapsed,
    throughput: `${((succeeded.length / elapsed) * 1000).toFixed(2)} req/s`,
    avgLatencyMs: avg(totalTimes),
    minLatencyMs: Math.min(...totalTimes),
    maxLatencyMs: Math.max(...totalTimes),
    p50Ms: percentile(totalTimes, 50),
    p95Ms: percentile(totalTimes, 95),
    avgTotalTokens: avg(tokensPerReq),
    avgOutputTokens: avg(outputTokensPerReq),
    tokensPerSecond: totalTimes.length > 0
      ? ((tokensPerReq.reduce((a, b) => a + b, 0) / elapsed) * 1000).toFixed(2)
      : 'N/A',
    errors: failed.map(f => f.error?.slice(0, 80)).filter(Boolean),
    ttft: succeeded.some(r => r.ttft !== null)
      ? {
          avgMs: avg(succeeded.filter(r => r.ttft !== null).map(r => r.ttft)),
          minMs: Math.min(...succeeded.filter(r => r.ttft !== null).map(r => r.ttft)),
          p50Ms: percentile(succeeded.filter(r => r.ttft !== null).map(r => r.ttft), 50),
        }
      : null,
  };

  return stats;
}

// ─── 帮助函数 ───
function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const copy = [...sorted].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * copy.length) - 1;
  return copy[Math.max(0, Math.min(idx, copy.length - 1))];
}

function pad(str, len) {
  return String(str).padEnd(len);
}

// ─── 主函数 ───
async function main() {
  const config = getConfig();
  const token = process.env.OPENCLAW_TOKEN || getAuthToken(config);
  const port = parseInt(process.env.OPENCLAW_PORT) || getPort(config);
  const host = '127.0.0.1';

  if (!token) {
    console.error('❌ 无法获取 API token。设置 OPENCLAW_TOKEN 环境变量或检查配置文件。');
    process.exit(1);
  }

  const allModels = extractModels(config);
  if (allModels.length === 0) {
    console.error('❌ 配置文件中没有找到模型。');
    process.exit(1);
  }

  let testModels;
  if (flags.model) {
    testModels = allModels.filter(m => m.qualified === flags.model);
    if (testModels.length === 0) {
      // try partial match
      testModels = allModels.filter(m =>
        m.qualified.includes(flags.model) || m.id.includes(flags.model)
      );
    }
    if (testModels.length === 0) {
      console.error(`❌ 未找到匹配模型: ${flags.model}`);
      console.log(`可用模型示例: ${allModels.slice(0, 5).map(m => m.qualified).join(', ')}...`);
      process.exit(1);
    }
  } else if (flags.all) {
    testModels = allModels;
  } else {
    testModels = getRepresentativeModels(allModels);
    console.log(`提示: 使用 --all 测试全部 ${allModels.length} 个模型`);
    console.log(`当前: 每个 provider 选一个代表模型（共 ${testModels.length} 个）\n`);
  }

  // 过滤掉 anthropic-messages api 的模型（我们的测试使用 OpenAI 格式）
  const openaiModels = testModels.filter(m =>
    m.api === 'openai-completions' || m.api === undefined
  );
  const skipped = testModels.filter(m => m.api === 'anthropic-messages');
  if (skipped.length > 0) {
    console.log(`⏭️  跳过 ${skipped.length} 个 anthropic-messages API 模型（本脚本仅测试 OpenAI 兼容接口）`);
    if (flags.verbose) {
      for (const m of skipped) {
        console.log(`   ⏭️  ${m.qualified} (${m.api})`);
      }
    }
    console.log('');
  }

  if (openaiModels.length === 0) {
    console.error('❌ 没有可测试的 OpenAI 兼容模型。');
    process.exit(1);
  }

  const { concurrency, requests, stream } = flags;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  OpenClaw 模型吞吐基准测试`);
  console.log(`  端点: http://${host}:${port}/v1/chat/completions`);
  console.log(`  并发: ${concurrency} | 每模型请求: ${requests} | 流式: ${stream}`);
  console.log(`  测试模型数: ${openaiModels.length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const results = [];

  for (let i = 0; i < openaiModels.length; i++) {
    const model = openaiModels[i];
    const label = `${i + 1}/${openaiModels.length}`;

    process.stdout.write(`[${label}] ${model.qualified} ... `);

    try {
      const stats = await testModel(host, port, token, model, concurrency, requests, stream);

      const status = stats.failed === 0 ? '✅' : stats.failed < stats.requestsAttempted ? '⚠️ ' : '❌';
      process.stdout.write(`${status} ${stats.throughput} | avg ${stats.avgLatencyMs.toFixed(0)}ms | succ ${stats.succeeded}/${stats.requestsAttempted}\n`);

      results.push(stats);
    } catch (err) {
      process.stdout.write(`❌ ${err.message}\n`);
      results.push({
        model: model.qualified,
        provider: model.provider,
        name: model.name,
        error: err.message,
        failed: requests,
        succeeded: 0,
      });
    }

    // 模型间间隔，防止请求太快导致网关限流
    if (i < openaiModels.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ─── 输出表格 ───
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  结果汇总');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 按吞吐量排序
  const sorted = [...results].filter(r => r.succeeded > 0)
    .sort((a, b) => parseFloat(b.throughput || '0') - parseFloat(a.throughput || '0'));

  if (sorted.length === 0) {
    console.log('❌ 所有模型测试均失败。');
    console.log('\n失败详情:');
    for (const r of results) {
      if (r.errors?.length > 0) {
        console.log(`  ${r.model}: ${r.errors[0]}`);
      }
    }
    process.exit(1);
  }

  // 表头
  console.log(` ${pad('模型', 45)} ${pad('吞吐量', 14)} ${pad('延迟(avg)', 12)} ${pad('P95', 10)} ${pad('成功率', 10)} ${pad('Token/s', 12)}`);
  console.log(` ${'-'.repeat(45)} ${'-'.repeat(14)} ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(12)}`);

  for (const r of sorted) {
    const tp = r.throughput || '-';
    const lat = r.avgLatencyMs ? `${r.avgLatencyMs.toFixed(0)}ms` : '-';
    const p95 = r.p95Ms ? `${r.p95Ms.toFixed(0)}ms` : '-';
    const sr = r.successRate || '-';
    const tps = r.tokensPerSecond || '-';

    console.log(` ${pad(r.model, 45)} ${pad(tp, 14)} ${pad(lat, 12)} ${pad(p95, 10)} ${pad(sr, 10)} ${pad(String(tps), 12)}`);
  }

  // 若使用流式，输出 TTFT
  if (stream && sorted.some(r => r.ttft)) {
    console.log('\n  --- 首 Token 延迟 (TTFT) ---\n');
    for (const r of sorted.filter(r => r.ttft)) {
      console.log(` ${pad(r.model, 45)} avg ${r.ttft.avgMs.toFixed(0)}ms | min ${r.ttft.minMs}ms | p50 ${r.ttft.p50Ms}ms`);
    }
  }

  // 失败汇总
  const failedModels = results.filter(r => r.failed > 0);
  if (failedModels.length > 0) {
    console.log(`\n⚠️  ${failedModels.length} 个模型有失败请求:`);
    for (const r of failedModels) {
      console.log(`   ${r.model}: ${r.succeeded}/${r.requestsAttempted || requests} 成功`);
      if (r.errors?.length > 0) {
        for (const e of r.errors.slice(0, 2)) {
          console.log(`     错误: ${e}`);
        }
      }
    }
  }

  // ─── 导出结果 ───
  if (flags.output) {
    const outputPath = path.resolve(flags.output);
    const exportData = {
      timestamp: new Date().toISOString(),
      config: {
        host,
        port,
        concurrency,
        requestsPerModel: requests,
        stream,
      },
      results: results.map(r => ({
        model: r.model,
        provider: r.provider,
        name: r.name,
        reasoning: r.reasoning,
        throughput: r.throughput,
        avgLatencyMs: r.avgLatencyMs,
        minLatencyMs: r.minLatencyMs,
        maxLatencyMs: r.maxLatencyMs,
        p50Ms: r.p50Ms,
        p95Ms: r.p95Ms,
        successRate: r.successRate,
        succeeded: r.succeeded,
        failed: r.failed,
        avgTotalTokens: r.avgTotalTokens,
        avgOutputTokens: r.avgOutputTokens,
        tokensPerSecond: r.tokensPerSecond,
        errors: r.errors,
      })),
    };
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
    console.log(`\n📄 结果已导出: ${outputPath}`);
  }

  console.log('\n✅ 测试完成');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
