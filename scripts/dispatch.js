#!/usr/bin/env node
/**
 * dispatch.js — Cron Add 调度器客户端（Node.js 版）
 *
 * 用法:
 *   node scripts/dispatch.js \
 *     --priority "med-2" \
 *     --source "scanner" \
 *     --coin "PROVE" \
 *     --name "alt-sentiment-PROVE-123" \
 *     --at "10s" \
 *     --message "多行\n消息"
 *
 *   或从文件读取消息:
 *   node scripts/dispatch.js --priority "med-2" ... --message-file /tmp/msg.txt
 *
 * 环境变量:
 *   DISPATCHER_URL      默认 http://127.0.0.1:3102
 *   DISPATCHER_FALLBACK  1=降级直连 openclaw cron add
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

// ─── 参数解析 ───
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].replace(/^--/, '');
    if (key === 'dry-run') {
      args['dry_run'] = true;
    } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      args[key] = process.argv[i + 1];
      i++;
    }
  }
}

// 从文件读取消息
if (args['message-file']) {
  try {
    args.message = fs.readFileSync(args['message-file'], 'utf8').trim();
  } catch (e) {
    console.error(`[dispatch] ⛔ ERROR: 无法读取消息文件: ${args['message-file']} — ${e.message}`);
    process.exit(1);
  }
}

// 校验必填
for (const f of ['priority', 'source', 'name', 'message']) {
  if (!args[f]) {
    console.error(`[dispatch] ⛔ ERROR: 缺少必填参数: --${f}`);
    process.exit(1);
  }
}

const DISPATCHER_URL = process.env.DISPATCHER_URL || 'http://127.0.0.1:3102';
const DISPATCHER_FALLBACK = process.env.DISPATCHER_FALLBACK === '1';

const payload = JSON.stringify({
  priority: args.priority,
  source: args.source,
  coin: args.coin || '',
  name: args.name,
  at: args.at || '1m',
  message: args.message,
});

// 干运行
if (args.dry_run) {
  const url = new URL(DISPATCHER_URL);
  console.log(`[dispatch] DRY_RUN: ${DISPATCHER_URL}/submit?dry_run=1`);
  console.log(`[dispatch] priority=${args.priority} source=${args.source} coin=${args.coin || '-'}`);
  process.exit(0);
}

// ─── POST 到调度器 ───
function postToDispatcher() {
  return new Promise((resolve, reject) => {
    const url = new URL(DISPATCHER_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/submit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({ code: res.statusCode, result });
        } catch (e) {
          reject(new Error(`HTTP ${res.statusCode}: invalid JSON`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── 降级直连 ───
function fallbackDirect() {
  const openclaw = process.env.OPENCLAW_BIN || 'openclaw';
  const msgEscaped = args.message.replace(/'/g, "'\\''");
  execSync(
    `${openclaw} cron add --name "${args.name}" --agent july --at "${args.at}" --message '${msgEscaped}' --session isolated --delete-after-run --no-deliver`,
    { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

// ─── 主流程 ───
postToDispatcher().then(({ code, result }) => {
  if (code === 200 || code === 202) {
    console.log(`[dispatch] ✅ 已提交 | ${args.priority} | ${args.coin || '-'} | ${args.source} | id=${result.id}`);
    process.exit(0);
  }
  // 429 rejected
  console.error(`[dispatch] ⚠️  REJECTED: ${result.reason || 'unknown'}`);
  if (DISPATCHER_FALLBACK) {
    console.error('[dispatch] 🔄 降级直连...');
    fallbackDirect();
    console.log(`[dispatch] ✅ 已降级直连 | ${args.name}`);
    process.exit(0);
  }
  process.exit(1);
}).catch(e => {
  console.error(`[dispatch] ⛔ ERROR: 调度器不可达 — ${e.message}`);
  if (DISPATCHER_FALLBACK) {
    console.error('[dispatch] 🔄 降级直连...');
    try {
      fallbackDirect();
      console.log(`[dispatch] ✅ 已降级直连 | ${args.name}`);
      process.exit(0);
    } catch (e2) {
      console.error(`[dispatch] ⛔ ERROR: 降级直连也失败 — ${e2.message}`);
      process.exit(1);
    }
  }
  process.exit(1);
});
