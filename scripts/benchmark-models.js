#!/usr/bin/env node
/**
 * benchmark-models.js — 模型吞吐速率测试
 *
 * 测试 OpenClaw 中配置的每个模型的请求吞吐：
 *   - TTFT (Time To First Token)
 *   - 总耗时
 *   - 输出 token 数
 *   - TPS (Tokens Per Second)
 *
 * 用法:
 *   node scripts/benchmark-models.js                          # 全量
 *   node scripts/benchmark-models.js --provider deepseek      # 单 provider
 *   node scripts/benchmark-models.js -p deepseek -m v4-flash  # 单模型
 *   node scripts/benchmark-models.js --rounds 5 --no-proxy
 */

const fs = require('fs');
const path = require('path');

// ── 读取配置 ──────────────────────────────────────────────
const configPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const providers = config.models.providers;

// ── 解析参数 ──────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-p') { opts.provider = args[++i]; continue; }
  if (a === '-m') { opts.model = args[++i]; continue; }
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = args[i + 1];
    if (val === undefined || val.startsWith('--')) { opts[key] = true; }
    else { opts[key] = val; i++; }
  }
}

const TARGET_PROVIDER = opts.provider || null;
const TARGET_MODEL = opts.model || null;
const ROUNDS = parseInt(opts.rounds || '3');
const NO_PROXY = opts['no-proxy'] || false;

// ── 代理 ──────────────────────────────────────────────────
const PROXY_URL = NO_PROXY ? null : (process.env.PROXY_URL || 'http://127.0.0.1:7890');

// ── 测试参数 ──────────────────────────────────────────────
const TEST_PROMPT = `Write a detailed technical analysis of Bitcoin's current market structure. Cover:
1. Key support and resistance levels (at least 5 levels with rationale)
2. Volume profile analysis and what it suggests
3. Market sentiment indicators (Fear & Greed, funding rates, open interest trends)
4. Short-term (1-3 day) outlook with probability assessment
5. Key risk factors to monitor

Be specific with price levels and percentages. Do NOT use bullet points — write in flowing paragraphs.`;

const TEST_MESSAGES = [{ role: 'user', content: TEST_PROMPT }];
const MAX_OUTPUT_TOKENS = 600;
const REQUEST_TIMEOUT_MS = 45000; // 单次请求超时 45s

// ── 颜色 ──────────────────────────────────────────────────
const CL = { r: '\x1b[0m', g: '\x1b[32m', R: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', d: '\x1b[2m' };

// ── 单次请求测试 ──────────────────────────────────────────
async function singleRequest(providerName, providerCfg, modelCfg) {
  const modelId = modelCfg.id;
  const baseUrl = providerCfg.baseUrl.replace(/\/$/, '');
  const apiKey = providerCfg.apiKey;
  const api = providerCfg.api || 'openai-completions';

  const startTime = Date.now();
  let firstTokenTime = null;
  let totalTokens = 0;
  let responseText = '';
  let chunkCount = 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let url, headers, body;

    if (api === 'anthropic-messages') {
      url = `${baseUrl}/messages`;
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
      body = JSON.stringify({
        model: modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
        messages: TEST_MESSAGES,
      });
    } else {
      url = `${baseUrl}/chat/completions`;
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };
      body = JSON.stringify({
        model: modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
        messages: TEST_MESSAGES,
      });
    }

    const fetchOpts = { method: 'POST', headers, body, signal: controller.signal };

    // 代理（尝试 undici ProxyAgent → https-proxy-agent → 直连）
    if (PROXY_URL) {
      try {
        const { ProxyAgent } = await import('undici');
        fetchOpts.dispatcher = new ProxyAgent(PROXY_URL);
      } catch {
        try {
          const { HttpsProxyAgent } = await import('https-proxy-agent');
          fetchOpts.agent = new HttpsProxyAgent(PROXY_URL);
        } catch { /* 直连 */ }
      }
    }

    const response = await fetch(url, fetchOpts);
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          if (api === 'anthropic-messages') {
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              if (!firstTokenTime) firstTokenTime = Date.now();
              responseText += parsed.delta.text;
              chunkCount++;
            }
            if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
              totalTokens = parsed.usage.output_tokens;
            }
          } else {
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              if (!firstTokenTime) firstTokenTime = Date.now();
              responseText += content;
              chunkCount++;
            }
            if (parsed.usage?.completion_tokens) {
              totalTokens = parsed.usage.completion_tokens;
            }
          }
        } catch {}
      }
    }

    // 若无 usage，用 chars/3.5 估算
    if (totalTokens === 0) {
      totalTokens = Math.max(1, Math.ceil(responseText.length / 3.5));
    }

    const endTime = Date.now();
    const ttft = firstTokenTime ? firstTokenTime - startTime : endTime - startTime;
    const totalTime = endTime - startTime;
    const tps = totalTime > 0 ? totalTokens / (totalTime / 1000) : 0;

    return {
      success: true,
      ttftMs: ttft,
      totalMs: totalTime,
      tokens: totalTokens,
      tps: parseFloat(tps.toFixed(1)),
      chunks: chunkCount,
    };

  } catch (err) {
    clearTimeout(timeout);
    const elapsed = Date.now() - startTime;
    let errMsg = err.message;
    if (err.name === 'AbortError') errMsg = `timeout after ${elapsed}ms`;
    return { success: false, error: errMsg, totalMs: elapsed };
  }
}

// ── 模型测试（多轮） ──────────────────────────────────────
async function testModel(providerName, providerCfg, modelCfg) {
  const results = [];
  for (let r = 0; r < ROUNDS; r++) {
    const res = await singleRequest(providerName, providerCfg, modelCfg);
    results.push({ round: r + 1, ...res });
  }
  return results;
}

// ── 格式化输出 ────────────────────────────────────────────
function printModelResult(fullName, results) {
  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);

  if (ok.length > 0) {
    const avgTTFT = ok.reduce((s, r) => s + r.ttftMs, 0) / ok.length;
    const avgTotal = ok.reduce((s, r) => s + r.totalMs, 0) / ok.length;
    const avgTPS = ok.reduce((s, r) => s + r.tps, 0) / ok.length;
    const avgTokens = ok.reduce((s, r) => s + r.tokens, 0) / ok.length;
    const minTTFT = Math.min(...ok.map(r => r.ttftMs));
    const maxTTFT = Math.max(...ok.map(r => r.ttftMs));
    const minTPS = Math.min(...ok.map(r => r.tps));
    const maxTPS = Math.max(...ok.map(r => r.tps));

    const icon = fail.length === 0 ? `${CL.g}✅${CL.r}` : `${CL.y}⚠️${CL.r}`;
    console.log(`  ${icon} ${fullName}`);
    console.log(`     TTFT: ${CL.c}${avgTTFT.toFixed(0)}${CL.r}ms (${minTTFT.toFixed(0)}~${maxTTFT.toFixed(0)}) | Total: ${avgTotal.toFixed(0)}ms | TPS: ${CL.b}${avgTPS.toFixed(1)}${CL.r} (${minTPS.toFixed(1)}~${maxTPS.toFixed(1)}) | Tokens: ${avgTokens.toFixed(0)}`);

    for (const f of fail) {
      console.log(`     ${CL.R}❌ R${f.round}:${CL.r} ${f.error}`);
    }
  } else {
    console.log(`  ${CL.R}❌ ${fullName}${CL.r} — all ${ROUNDS} failed`);
    for (const f of fail) {
      console.log(`     R${f.round}: ${f.error}`);
    }
  }

  return { fullName, results, ok, fail };
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  console.log(`${CL.b}══════════════════════════════════════════════${CL.r}`);
  console.log(`${CL.b}  Model Throughput Benchmark${CL.r}`);
  console.log(`${CL.d}  Rounds: ${ROUNDS} | Max tokens: ${MAX_OUTPUT_TOKENS} | Timeout: ${REQUEST_TIMEOUT_MS / 1000}s | Proxy: ${PROXY_URL || 'disabled'}${CL.r}`);
  console.log(`${CL.b}══════════════════════════════════════════════${CL.r}\n`);

  const targets = {};
  for (const [pName, pCfg] of Object.entries(providers)) {
    if (TARGET_PROVIDER && pName !== TARGET_PROVIDER) continue;
    if (!pCfg.apiKey) {
      if (TARGET_PROVIDER) console.log(`${CL.y}⚠ Provider "${pName}" 没有 API key，跳过${CL.r}`);
      continue;
    }
    const models = TARGET_MODEL
      ? pCfg.models.filter(m => m.id === TARGET_MODEL || m.alias === TARGET_MODEL)
      : pCfg.models;
    if (models.length === 0) {
      if (TARGET_MODEL) console.log(`${CL.y}⚠ Model "${TARGET_MODEL}" not found in "${pName}"${CL.r}`);
      continue;
    }
    targets[pName] = { cfg: pCfg, models };
  }

  if (Object.keys(targets).length === 0) {
    console.log(`${CL.R}No matching providers/models found.${CL.r}`);
    process.exit(1);
  }

  const startAll = Date.now();
  const allSummaries = [];

  // Provider 级别并发
  const providerPromises = Object.entries(targets).map(async ([pName, { cfg, models }]) => {
    const summaries = [];
    for (const model of models) {
      const fullName = `${pName}/${model.id}`;
      const results = await testModel(pName, cfg, model);
      summaries.push(printModelResult(fullName, results));
    }
    return summaries;
  });

  const providerResults = await Promise.all(providerPromises);
  const allResults = providerResults.flat();

  // ── 汇总表 ──────────────────────────────────────────────
  const totalElapsed = ((Date.now() - startAll) / 1000).toFixed(1);
  console.log(`\n${CL.b}══════════════════════════════════════════════${CL.r}`);
  console.log(`${CL.b}  Summary (total: ${totalElapsed}s)${CL.r}`);
  console.log(`${CL.b}══════════════════════════════════════════════${CL.r}`);

  const sorted = allResults
    .filter(s => s.ok.length > 0)
    .sort((a, b) => {
      const aTPS = a.ok.reduce((s, r) => s + r.tps, 0) / a.ok.length;
      const bTPS = b.ok.reduce((s, r) => s + r.tps, 0) / b.ok.length;
      return bTPS - aTPS;
    });

  const N = 'Model'.padEnd(44);
  console.log(`${CL.d}  ${N} ${'TTFT'.padStart(8)} ${'Total'.padStart(8)} ${'TPS'.padStart(8)} ${'Tokens'.padStart(7)} ${'OK'.padStart(6)}${CL.r}`);
  console.log(`  ${'─'.repeat(44)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)}`);

  for (const s of sorted) {
    const avgTTFT = s.ok.reduce((sum, r) => sum + r.ttftMs, 0) / s.ok.length;
    const avgTotal = s.ok.reduce((sum, r) => sum + r.totalMs, 0) / s.ok.length;
    const avgTPS = s.ok.reduce((sum, r) => sum + r.tps, 0) / s.ok.length;
    const avgTok = s.ok.reduce((sum, r) => sum + r.tokens, 0) / s.ok.length;
    const rate = `${s.ok.length}/${ROUNDS}`;

    const nc = avgTPS > 60 ? CL.g : avgTPS > 30 ? CL.y : CL.r;
    console.log(`  ${nc}${s.fullName.padEnd(44)}${CL.r} ${String(avgTTFT.toFixed(0) + 'ms').padStart(8)} ${String(avgTotal.toFixed(0) + 'ms').padStart(8)} ${String(avgTPS.toFixed(1)).padStart(8)} ${String(avgTok.toFixed(0)).padStart(7)} ${rate.padStart(6)}`);
  }

  // 失败的
  const dead = allResults.filter(s => s.ok.length === 0);
  if (dead.length > 0) {
    console.log(`\n${CL.R}  Unreachable (${dead.length}):${CL.r}`);
    for (const d of dead) {
      const firstErr = d.fail[0]?.error || '?';
      console.log(`    ${CL.R}✗${CL.r} ${d.fullName.padEnd(44)} ${firstErr}`);
    }
  }

  // 部分失败
  const partial = allResults.filter(s => s.ok.length > 0 && s.fail.length > 0);
  if (partial.length > 0) {
    console.log(`\n${CL.y}  Partial failures (${partial.length}):${CL.r}`);
    for (const p of partial) {
      console.log(`    ${CL.y}△${CL.r} ${p.fullName}: ${p.ok.length}/${ROUNDS} ok, errors: ${p.fail.map(f => f.error).join('; ')}`);
    }
  }

  console.log(`\n${CL.d}  Done in ${totalElapsed}s.${CL.r}`);
}

main().catch(err => {
  console.error(`${CL.R}Fatal:${CL.r}`, err);
  process.exit(1);
});
