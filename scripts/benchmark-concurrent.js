#!/usr/bin/env node
/**
 * 单模型并发吞吐测试
 * 用法: node scripts/benchmark-concurrent.js --provider astroncodingplan --model astron-code-latest --concurrency 1,2,3,4,5
 */
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'openclaw.json'), 'utf8'));
const providers = config.models.providers;

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-p') { opts.provider = args[++i]; continue; }
  if (args[i] === '-m') { opts.model = args[++i]; continue; }
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    const v = args[i + 1];
    opts[k] = (v === undefined || v.startsWith('--')) ? true : (args[++i], v);
  }
}

const TARGET_PROVIDER = opts.provider;
const TARGET_MODEL = opts.model;
const CONCURRENCIES = (opts.concurrency || '1,2,3,4,5').split(',').map(Number);
const NO_PROXY = opts['no-proxy'];
const PROXY_URL = NO_PROXY ? null : (process.env.PROXY_URL || 'http://127.0.0.1:7890');
const REQUEST_TIMEOUT_MS = 120000;

const TEST_PROMPT = `Write a detailed technical analysis of Bitcoin's current market structure. Cover:
1. Key support and resistance levels (at least 5 levels with rationale)
2. Volume profile analysis and what it suggests
3. Market sentiment indicators (Fear & Greed, funding rates, open interest trends)
4. Short-term (1-3 day) outlook with probability assessment
5. Key risk factors to monitor
Be specific with price levels and percentages. Do NOT use bullet points — write in flowing paragraphs.`;

const MAX_TOKENS = 600;
const CL = { r: '\x1b[0m', g: '\x1b[32m', R: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', d: '\x1b[2m' };

async function singleRequest(pCfg, modelCfg) {
  const baseUrl = pCfg.baseUrl.replace(/\/$/, '');
  const api = pCfg.api || 'openai-completions';
  const t0 = Date.now();
  let firstToken = null, totalTokens = 0, text = '';

  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const isAnthropic = api === 'anthropic-messages';
    const url = isAnthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`;
    const headers = isAnthropic
      ? { 'Content-Type': 'application/json', 'x-api-key': pCfg.apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pCfg.apiKey}` };
    const body = JSON.stringify({
      model: modelCfg.id,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: TEST_PROMPT }],
    });

    const fetchOpts = { method: 'POST', headers, body, signal: ctrl.signal };
    if (PROXY_URL) {
      try { const { ProxyAgent } = await import('undici'); fetchOpts.dispatcher = new ProxyAgent(PROXY_URL); } catch {}
    }

    const res = await fetch(url, fetchOpts);
    clearTimeout(tm);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const p = JSON.parse(d);
          if (isAnthropic) {
            if (p.type === 'content_block_delta' && p.delta?.text) { if (!firstToken) firstToken = Date.now(); text += p.delta.text; }
            if (p.type === 'message_delta' && p.usage?.output_tokens) totalTokens = p.usage.output_tokens;
          } else {
            const c = p.choices?.[0]?.delta?.content;
            if (c) { if (!firstToken) firstToken = Date.now(); text += c; }
            if (p.usage?.completion_tokens) totalTokens = p.usage.completion_tokens;
          }
        } catch {}
      }
    }

    if (!totalTokens) totalTokens = Math.max(1, Math.ceil(text.length / 3.5));
    const end = Date.now();
    return {
      ok: true,
      ttft: firstToken ? firstToken - t0 : end - t0,
      total: end - t0,
      tokens: totalTokens,
      tps: +(totalTokens / ((end - t0) / 1000)).toFixed(1),
    };
  } catch (e) {
    clearTimeout(tm);
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, total: Date.now() - t0 };
  }
}

async function testConcurrency(pCfg, modelCfg, N) {
  console.log(`\n${CL.b}── Concurrency = ${N} ──${CL.r}`);
  const startAll = Date.now();
  const promises = Array.from({ length: N }, () => singleRequest(pCfg, modelCfg));
  const results = await Promise.all(promises);
  const wallTime = Date.now() - startAll;

  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);

  if (ok.length > 0) {
    const stats = (arr, key) => {
      const vals = arr.map(r => r[key]);
      return {
        avg: vals.reduce((a,b) => a+b, 0) / vals.length,
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    };
    const ttft = stats(ok, 'ttft');
    const total = stats(ok, 'total');
    const tps = stats(ok, 'tps');
    const tok = stats(ok, 'tokens');
    const throughput = ok.length / (wallTime / 1000);

    console.log(`  ${CL.g}✅${CL.r} ${ok.length}/${N} ok | Wall: ${(wallTime/1000).toFixed(1)}s | Throughput: ${CL.b}${throughput.toFixed(2)}${CL.r} req/s`);
    console.log(`     TTFT: ${CL.c}${ttft.avg.toFixed(0)}${CL.r}ms (${ttft.min.toFixed(0)}~${ttft.max.toFixed(0)}) | Total: ${total.avg.toFixed(0)}ms | TPS: ${CL.b}${tps.avg.toFixed(1)}${CL.r} | Tokens: ${tok.avg.toFixed(0)}`);
    // Per-request detail
    for (let i = 0; i < ok.length; i++) {
      const r = ok[i];
      console.log(`     ${CL.d}#${i+1}${CL.r} TTFT=${r.ttft}ms Total=${r.total}ms TPS=${r.tps} Tok=${r.tokens}`);
    }
  }
  for (const f of fail) {
    console.log(`  ${CL.R}❌${CL.r} ${f.error} (${f.total}ms)`);
  }
  return { N, ok: ok.length, fail: fail.length, wallTime, throughput: ok.length / (wallTime / 1000), results: ok };
}

async function main() {
  const pCfg = providers[TARGET_PROVIDER];
  if (!pCfg) { console.error(`Provider "${TARGET_PROVIDER}" not found`); process.exit(1); }
  const mCfg = pCfg.models.find(m => m.id === TARGET_MODEL || m.alias === TARGET_MODEL);
  if (!mCfg) { console.error(`Model "${TARGET_MODEL}" not found in "${TARGET_PROVIDER}"`); process.exit(1); }

  const fullName = `${TARGET_PROVIDER}/${mCfg.id}`;
  console.log(`${CL.b}══════════════════════════════════════════${CL.r}`);
  console.log(`${CL.b}  Concurrency Benchmark: ${fullName}${CL.r}`);
  console.log(`${CL.d}  Max tokens: ${MAX_TOKENS} | Timeout: ${REQUEST_TIMEOUT_MS/1000}s | Proxy: ${PROXY_URL||'off'}${CL.r}`);
  console.log(`${CL.b}══════════════════════════════════════════${CL.r}`);

  const summaries = [];
  for (const N of CONCURRENCIES) {
    summaries.push(await testConcurrency(pCfg, mCfg, N));
  }

  // Summary table
  console.log(`\n${CL.b}══════════════════════════════════════════${CL.r}`);
  console.log(`${CL.b}  Summary${CL.r}`);
  console.log(`${CL.d}  ${'Conc'.padEnd(6)} ${'Wall'.padStart(8)} ${'Throughput'.padStart(14)} ${'TTFT avg'.padStart(10)} ${'Total avg'.padStart(10)} ${'TPS avg'.padStart(9)} ${'OK'.padStart(5)}${CL.r}`);
  console.log(`  ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(14)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(9)} ${'─'.repeat(5)}`);
  for (const s of summaries) {
    const ok = s.results;
    const avgTTFT = ok.length > 0 ? ok.reduce((a,r) => a+r.ttft,0)/ok.length : 0;
    const avgTotal = ok.length > 0 ? ok.reduce((a,r) => a+r.total,0)/ok.length : 0;
    const avgTPS = ok.length > 0 ? ok.reduce((a,r) => a+r.tps,0)/ok.length : 0;
    const nc = s.throughput > 0.5 ? CL.g : s.throughput > 0.2 ? CL.y : CL.R;
    console.log(`  ${String(s.N).padEnd(6)} ${(s.wallTime/1000).toFixed(1)+'s'.padStart(8)} ${nc}${s.throughput.toFixed(3)+' r/s'.padStart(14)}${CL.r} ${String(avgTTFT.toFixed(0)+'ms').padStart(10)} ${String(avgTotal.toFixed(0)+'ms').padStart(10)} ${String(avgTPS.toFixed(1)).padStart(9)} ${String(s.ok+'/'+s.N).padStart(5)}`);
  }
  console.log(`\n${CL.d}  Done.${CL.r}`);
}

main().catch(e => { console.error(e); process.exit(1); });
