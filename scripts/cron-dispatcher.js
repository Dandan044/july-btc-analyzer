#!/usr/bin/env node
/**
 * cron-dispatcher.js — Cron Add 中转调度器
 *
 * 功能:
 *   1. 接收 4 个调用方的 POST /submit 请求
 *   2. 优先级队列 (HIGH-3 > HIGH-2 > HIGH-1 > MED-2 > MED-1 > LOW-2 > LOW-1)
 *   3. 模型负载感知调度（按智能度分层 + 子池映射）
 *   4. 同优先级节流/错峰
 *   5. 统一参数注入
 *
 * 部署: PM2 管理的常驻进程，端口 3102
 * 守护: engine.js 的调用方降级到本进程的 /submit-nogate；不额外加 watchdog
 */

const http = require('http');
const { execSync, spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 强制清除代理环境变量（PM2 会注入大写 HTTP_PROXY 等）──
['http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].forEach(k => {
  delete process.env[k];
});

// ════════════════════════════════════════════
// 配置加载
// ════════════════════════════════════════════
const WORKSPACE = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(WORKSPACE, 'data', 'cron-dispatcher-config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

let CONFIG = loadConfig();

// 热重载：SIGHUP
process.on('SIGHUP', () => {
  try {
    CONFIG = loadConfig();
    console.error(`[${isoNow()}] [dispatcher] 配置热重载完成`);
  } catch (e) {
    console.error(`[${isoNow()}] [dispatcher] 配置重载失败: ${e.message}`);
  }
});

// ════════════════════════════════════════════
// 数据结构
// ════════════════════════════════════════════

// 优先级顺序（降序：数字越大越优先）
const PRIORITY_ORDER = ['pro', 'high-3', 'high-2', 'high-1', 'med-2', 'med-1', 'low-2', 'low-1'];

// 优先级队列: Map<priority, job[]>
const queue = new Map();
for (const p of PRIORITY_ORDER) queue.set(p, []);

// ═══ 新：动态窗口载荷跟踪 ═══
const DEFAULT_DURATION_MS = 10 * 60 * 1000; // cron 任务默认耗时（日报/复盘等长任务）
const INTERNAL_WINDOW_MS = 15 * 60 * 1000;  // internal 条目窗口：匹配分析任务实际运行时长（3-15min），防止空队列时低估负载
const OPENCLAW_CONFIG_PATH = path.join(process.env.HOME || '/home/administrator', '.openclaw', 'openclaw.json');

// 活跃任务窗口: Map<jobKey, { model, windowStart, windowEnd, source }>
// source: 'cron'（从 cron list 读取）| 'internal'（dispatcher 自己派发的）
const activeJobs = new Map();

// agent -> model 缓存（从 openclaw.json 解析）
let agentModels = new Map();
let agentModelsLoadedAt = 0;

function loadAgentModels() {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const agents = cfg.agents?.list || [];
    const defaults = cfg.agents?.defaults?.model?.primary || null;
    const prevSize = agentModels.size;
    agentModels.clear();
    for (const a of agents) {
      if (a.model) agentModels.set(a.id, a.model);
    }
    if (defaults) agentModels.set('_default', defaults);
    agentModelsLoadedAt = Date.now();
    // 仅首次或数量变化时打印
    if (prevSize === 0 || agentModels.size !== prevSize) {
      log('INFO', `Agent 模型缓存已加载: ${agentModels.size} 个 agent`);
    }
  } catch (e) {
    log('WARN', `Agent 模型缓存加载失败: ${e.message}`);
  }
}

// 解析 job 使用的模型
function resolveJobModel(job) {
  // 1. 优先 payload.model（dispatcher 注入的）
  if (job.payload?.model) return job.payload.model;
  // 2. agent 配置的模型
  const agentId = job.agentId || '';
  if (agentModels.has(agentId)) return agentModels.get(agentId);
  // 3. fallback: 默认模型
  return agentModels.get('_default') || 'unknown';
}

// 去重缓存: Map<dedupKey, timestamp>
const dedupCache = new Map();

// 节流记录: Map<priorityLevel, lastDispatchTime>
const throttleMap = new Map();
for (const p of ['pro', 'high', 'med', 'low']) throttleMap.set(p, 0);

// 任务内部状态: Map<jobId, { job, retryAfter, enqueuedAt }>
const jobMeta = new Map();

// 统计
const stats = {
  submitted: 0, dispatched: 0, rejected: 0,
  byPriority: {}, bySource: {},
  modelUsage: {},
  startedAt: Date.now(),
};
for (const p of PRIORITY_ORDER) stats.byPriority[p] = { submitted: 0, dispatched: 0, rejected: 0 };
for (const [pn, pool] of Object.entries(CONFIG.pools || {})) {
  for (const m of (pool.models || [])) stats.modelUsage[m.id] = (stats.modelUsage[m.id] || 0);
}

// 日志
const LOG_LEVELS = ['INFO', 'ENQUEUE', 'REJECT', 'DISPATCH', 'WARN', 'ERROR'];

// ════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════
function isoNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19);
}

function log(level, msg) {
  const ts = isoNow();
  const line = `[${ts}] [${level}] ${msg}`;
  // 只输出到 stderr，由 PM2 error_file 捕获（避免双重写入）
  console.error(line);
}

function jobId() {
  return `dis-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function priorityLevel(p) {
  return p.split('-')[0]; // "high-1" → "high"
}

function parsePriority(p) {
  const parts = p.split('-');
  return { level: parts[0], sub: parseInt(parts[1], 10) };
}

function comparePriority(a, b) {
  // 高优先级先出队
  const ai = PRIORITY_ORDER.indexOf(a);
  const bi = PRIORITY_ORDER.indexOf(b);
  return ai - bi; // 越小越优先（high-3=0, low-1=6）
}

// ════════════════════════════════════════════
// 队列持久化（重启不丢失）
// ════════════════════════════════════════════
let _persistTimer = null;

function persistQueue() {
  // 防抖：100ms 内只写一次，避免高频 enqueue 时频繁 IO
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const data = {};
      for (const prio of PRIORITY_ORDER) {
        const jobs = queue.get(prio);
        if (jobs.length > 0) {
          data[prio] = jobs.map(j => ({
            id: j.id,
            priority: j.priority,
            source: j.source,
            coin: j.coin,
            name: j.name,
            message: j.message,
            at: j.at,
            submittedAt: j.submittedAt,
          }));
        }
      }
      const tmp = QUEUE_PERSIST_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, QUEUE_PERSIST_FILE);
    } catch (e) {
      log('WARN', `队列持久化失败: ${e.message}`);
    }
  }, 100);
}

function restoreQueue() {
  try {
    if (!fs.existsSync(QUEUE_PERSIST_FILE)) return 0;
    const raw = fs.readFileSync(QUEUE_PERSIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    let restored = 0;
    for (const prio of PRIORITY_ORDER) {
      const jobs = data[prio] || [];
      for (const j of jobs) {
        const entry = {
          id: j.id || jobId(),
          priority: prio,
          source: j.source,
          coin: j.coin,
          name: j.name,
          message: j.message,
          at: j.at,
          model: null,
          submittedAt: j.submittedAt || Date.now(),
        };
        queue.get(prio).push(entry);
        jobMeta.set(entry.id, { job: entry, retryAfter: 0, enqueuedAt: Date.now() });
        restored++;
      }
    }
    if (restored > 0) {
      // 恢复后清空持久化文件，避免下次启动重复恢复
      try { fs.unlinkSync(QUEUE_PERSIST_FILE); } catch (_) {}
    }
    return restored;
  } catch (e) {
    log('WARN', `队列恢复失败: ${e.message}`);
    return 0;
  }
}

// ════════════════════════════════════════════
// 模型负载：从 cron list 导入 → 执行窗口（毫秒级文件读取）
// ════════════════════════════════════════════
const LOAD_CACHE_FILE = path.join(WORKSPACE, 'data', 'cron-list-cache.json');
const QUEUE_PERSIST_FILE = path.join(WORKSPACE, 'data', 'cron-dispatcher-queue.json');

function importCronJobs() {
  // 定时刷新 agent 模型缓存（每 5min）
  if (Date.now() - agentModelsLoadedAt > 300000) loadAgentModels();

  let list;
  try {
    if (!fs.existsSync(LOAD_CACHE_FILE)) return;
    const raw = fs.readFileSync(LOAD_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : (parsed.jobs || parsed.items || []);
  } catch (e) {
    log('WARN', `负载缓存读取失败: ${e.message}`);
    return;
  }

  const now = Date.now();

  // 清理旧的 cron 来源条目和已完成的 dispatch-pending 条目
  for (const [key, val] of activeJobs) {
    if (val.source === 'cron') activeJobs.delete(key);
    // dispatch-pending 条目由 spawn 回调清理，这里只清理过期的
    if (val.source === 'dispatch-pending' && val.windowEnd < now) activeJobs.delete(key);
  }

  for (const job of list) {
    const state = job.state || {};
    const modelId = resolveJobModel(job);
    if (!modelId || modelId === 'unknown') continue;

    // 仅统计在所有池子模型中存在的
    let inAnyPool = false;
    for (const pool of Object.values(CONFIG.pools || {})) {
      if ((pool.models || []).some(m => m.id === modelId)) { inAnyPool = true; break; }
    }
    if (!inAnyPool) continue;

    let windowStart, windowEnd;

    if (state.runningAtMs) {
      // 正在执行 — 窗口至少延伸到 now+60s，防止被过期剔除
      const duration = state.lastDurationMs || DEFAULT_DURATION_MS;
      windowStart = state.runningAtMs;
      windowEnd = Math.max(state.runningAtMs + duration, now + 60000);
    } else if (state.nextRunAtMs && state.nextRunAtMs <= now) {
      // 已到期但未执行（gateway 排队中），保守假设即将开始
      windowStart = now;
      windowEnd = now + (state.lastDurationMs || DEFAULT_DURATION_MS);
    } else if (state.nextRunAtMs && state.nextRunAtMs > now) {
      // 未来调度
      const duration = state.lastDurationMs || DEFAULT_DURATION_MS;
      windowStart = state.nextRunAtMs;
      windowEnd = state.nextRunAtMs + duration;
    } else {
      continue;
    }

    // 过期清理：窗口已结束的跳过
    if (windowEnd < now) continue;

    // internal 条目仅用于填补「派发→缓存刷新」的 ~30s 间隙。
    // 一旦 cron 出现在 gateway 列表中，cron 条目（含 gateway 提供的 running/scheduled
    // 窗口信息）就是权威数据源，internal 应退场，避免双计。
    for (const [key, val] of activeJobs) {
      if (val.source === 'internal' && val.name === job.name) {
        activeJobs.delete(key);
        break;
      }
    }

    activeJobs.set('cron:' + job.id, {
      model: modelId,
      windowStart,
      windowEnd,
      source: 'cron',
      name: job.name,
      coin: extractCoinFromName(job.name),
    });
  }
}

/** 从任务名中提取币种简称 */
function extractCoinFromName(name) {
  if (!name) return '-';
  const m = name.match(/^(?:alt-instant|review-alt|alt-sentiment|selfheal)-([A-Za-z0-9]+)-/);
  if (m) return m[1];
  if (name.startsWith('review-cycle-')) return 'BTC';
  if (name.includes('btc')) return 'BTC';
  return '-';
}

// 兼容旧名称
function pollModelLoad() {
  importCronJobs();
}

// 后台更新缓存文件（detached spawn，不阻塞不等待）
function refreshLoadCache() {
  const tmpFile = LOAD_CACHE_FILE + '.tmp';
  const child = spawn('bash', ['-c',
    `openclaw cron list --json > "${tmpFile}" && mv "${tmpFile}" "${LOAD_CACHE_FILE}"`
  ], {
    detached: true, stdio: 'ignore', timeout: 15000,
    env: { ...process.env, PATH: process.env.PATH },
  });
  child.unref();
  child.on('error', (e) => log('WARN', `缓存更新 spawn 失败: ${e.message}`));
}

function getModelById(id) {
  for (const pool of Object.values(CONFIG.pools || {})) {
    const m = (pool.models || []).find(m => m.id === id);
    if (m) return m;
  }
  return null;
}

function getPoolModels(poolName) {
  return CONFIG.pools[poolName]?.models || [];
}

// ════════════════════════════════════════════
// 动态载荷计算 + 模型选择
// ════════════════════════════════════════════

// 计算模型在时间窗口 [taskAt, taskAt+duration] 内的并发数
// 去重：同一任务可能有 internal 和 cron 两种条目（按 name 后缀匹配），只计一次
function computeLoad(modelId, taskAt, taskDuration) {
  const windowEnd = taskAt + taskDuration;
  // 先收集所有匹配条目，按 job name 去重
  const seenNames = new Set();
  let count = 0;
  for (const [, job] of activeJobs) {
    if (job.model !== modelId) continue;
    // 窗口重叠检测
    if (job.windowStart < windowEnd && taskAt < job.windowEnd) {
      // 去重：同一任务名只计一次（internal 和 cron 条目共享 name 后缀）
      const dedupKey = job.name || job.dedupKey;
      if (dedupKey && seenNames.has(dedupKey)) continue;
      if (dedupKey) seenNames.add(dedupKey);
      count++;
    }
  }
  // 加上自身（新任务也占一个槽位）
  return count + 1;
}

function selectModel(priority, poolName, taskAt, taskDuration) {
  const candidates = getPoolModels(poolName);

  // 1. 滤掉满载的（新任务自己占 1 个槽位）
  const available = candidates.filter(m => {
    const load = computeLoad(m.id, taskAt, taskDuration);
    return load <= m.max_concurrent; // computeLoad 已包含自身 +1
  });

  if (available.length === 0) {
    if (priorityLevel(priority) === 'high') {
      candidates.sort((a, b) => b.weight - a.weight);
      return { id: candidates[0].id, waiting: true };
    }
    return null;
  }

  // 2. 按负载率升序，同负载率按 weight 降序
  available.sort((a, b) => {
    const ra = computeLoad(a.id, taskAt, taskDuration) / a.max_concurrent;
    const rb = computeLoad(b.id, taskAt, taskDuration) / b.max_concurrent;
    if (Math.abs(ra - rb) > 0.01) return ra - rb;
    return b.weight - a.weight;
  });

  return { id: available[0].id, waiting: false };
}

// ════════════════════════════════════════════
// 节流检查
// ════════════════════════════════════════════
function throttleCheck(priority) {
  const level = priorityLevel(priority);
  const cfg = CONFIG.throttle[level];
  if (!cfg || cfg.min_interval_ms === 0) return true;

  const last = throttleMap.get(level) || 0;
  return (Date.now() - last) >= cfg.min_interval_ms;
}

// ════════════════════════════════════════════
// 去重检查
// ════════════════════════════════════════════
function isDuplicate(job) {
  const key = `${job.source}:${job.coin}:${job.priority}`;
  const last = dedupCache.get(key);
  if (last && (Date.now() - last) < CONFIG.dedup.window_seconds * 1000) {
    return true;
  }
  dedupCache.set(key, Date.now());
  return false;
}

function cleanDedupCache() {
  const cutoff = Date.now() - CONFIG.dedup.window_seconds * 1000 * 2;
  for (const [k, v] of dedupCache) {
    if (v < cutoff) dedupCache.delete(k);
  }
}

// ════════════════════════════════════════════
// Cron Add 执行
// ════════════════════════════════════════════
function executeCronAdd(job) {
  const d = CONFIG.defaults;
  const now = Date.now();

  // 计算 --at: 当前时间（UTC）+ job 指定的延迟
  let atTime;
  if (job.at) {
    if (job.at === 'now' || job.at === '0s') {
      atTime = new Date(now);
    } else if (job.at.endsWith('s') || job.at.endsWith('m') || job.at.endsWith('h')) {
      atTime = new Date(now + parseDelay(job.at));
    } else {
      // 假定是 ISO 时间戳（如 review cron 的 24h 绝对时间）
      atTime = new Date(job.at);
    }
  } else {
    atTime = new Date(now + 60000); // 默认 1min
  }

  const atStr = atTime.toISOString();

  log('DISPATCH', `${job.priority} | ${job.coin || '-'} | ${job.source} | model=${job.model} | name=${job.name}`);

  // 用 spawn 传数组参数，绕过 shell 转义问题
  const openclawArgs = ['cron', 'add',
    '--name', job.name,
    '--agent', d.agent,
    '--session', d.session,
    '--at', atStr,
    '--message', job.message,
  ];
  if (job.model) openclawArgs.push('--model', job.model);
  if (d.delete_after_run) openclawArgs.push('--delete-after-run');
  if (d.no_deliver) openclawArgs.push('--no-deliver');

  // ── 按优先级注入超时：防止长时间分析任务占用模型池 ──
  const priorityLevelKey = priorityLevel(job.priority);
  const timeoutCfg = CONFIG.timeout?.[priorityLevelKey];
  if (timeoutCfg?.timeout_seconds) {
    openclawArgs.push('--timeout-seconds', String(timeoutCfg.timeout_seconds));
  }

  // ── Bug2 修复：同步写入 activeJobs（dispatch-pending），不等 spawn 回调 ──
  // 防止 schedulerTick while 循环在同一个 tick 内派发多个任务到同一模型
  const taskAt = job.taskAt || Date.now();
  const pendingKey = 'pending:' + job.name;
  activeJobs.set(pendingKey, {
    model: job.model,
    windowStart: taskAt,
    windowEnd: taskAt + INTERNAL_WINDOW_MS,
    source: 'dispatch-pending',
    name: job.name,
    coin: job.coin || extractCoinFromName(job.name),
  });

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 3000;

  function doAttempt(attempt) {
    const child = spawn('openclaw', openclawArgs, {
      env: { ...process.env, PATH: process.env.PATH },
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutOut = '';
    let stderrOut = '';
    child.stdout.on('data', c => stdoutOut += c);
    child.stderr.on('data', c => stderrOut += c);

    child.on('close', (code, signal) => {
      if (code === 0) {
        // 成功
        activeJobs.delete(pendingKey);
        stats.dispatched++;
        stats.byPriority[job.priority].dispatched++;
        if (job.model) stats.modelUsage[job.model] = (stats.modelUsage[job.model] || 0) + 1;
        const jobKey = 'internal:' + job.name;
        for (const [key, val] of activeJobs) {
          if (val.source === 'cron' && key.endsWith(job.name)) activeJobs.delete(key);
        }
        activeJobs.set(jobKey, {
          model: job.model,
          windowStart: taskAt,
          windowEnd: taskAt + INTERNAL_WINDOW_MS,
          source: 'internal',
          name: job.name,
          coin: extractCoinFromName(job.name),
        });
        if (attempt > 1) {
          log('INFO', `cron add 重试成功 [${job.name}] (第${attempt}次尝试)`);
        }
        return;
      }

      // ── 失败：拼装详细诊断信息 ──
      const parts = [];
      parts.push(`exit=${code}`);
      if (signal) parts.push(`signal=${signal}`);
      if (stdoutOut.trim()) {
        parts.push(`stdout="${stdoutOut.trim().slice(0, 300)}"`);
      } else {
        parts.push('stdout=(空)');
      }
      if (stderrOut.trim()) {
        parts.push(`stderr="${stderrOut.trim().slice(0, 300)}"`);
      } else {
        parts.push('stderr=(空)');
      }
      const errDetail = parts.join(' | ');

      if (attempt < MAX_ATTEMPTS) {
        log('WARN', `cron add 失败 [${job.name}] 第${attempt}/${MAX_ATTEMPTS}次: ${errDetail} — ${RETRY_DELAY_MS / 1000}s 后重试...`);
        setTimeout(() => doAttempt(attempt + 1), RETRY_DELAY_MS);
      } else {
        // 最终失败
        activeJobs.delete(pendingKey);
        const reasonHint = signal
          ? `被信号 ${signal} 终止`
          : (code === null ? '进程异常退出' : `退出码 ${code}`);
        log('ERROR', `cron add 最终失败 [${job.name}] (${MAX_ATTEMPTS}次尝试, ${reasonHint}): ${errDetail}`);
        stats.rejected++;
        stats.byPriority[job.priority].rejected++;
      }
    });

    child.on('error', (err) => {
      // spawn 本身失败（如 openclaw 二进制不存在、ENOENT 等）
      const errType = err.code || 'UNKNOWN';
      if (attempt < MAX_ATTEMPTS) {
        log('WARN', `cron add spawn异常 [${job.name}] 第${attempt}/${MAX_ATTEMPTS}次: code=${errType} msg="${err.message}" — ${RETRY_DELAY_MS / 1000}s 后重试...`);
        setTimeout(() => doAttempt(attempt + 1), RETRY_DELAY_MS);
      } else {
        activeJobs.delete(pendingKey);
        log('ERROR', `cron add spawn最终异常 [${job.name}] (${MAX_ATTEMPTS}次): code=${errType} msg="${err.message}"`);
        stats.rejected++;
        stats.byPriority[job.priority].rejected++;
      }
    });
  }

  doAttempt(1);
}

function parseDelay(s) {
  const num = parseInt(s, 10);
  if (s.endsWith('s')) return num * 1000;
  if (s.endsWith('m')) return num * 60000;
  if (s.endsWith('h')) return num * 3600000;
  return 60000; // 默认 1min
}

// ════════════════════════════════════════════
// 队列操作
// ════════════════════════════════════════════
function enqueue(job) {
  const prio = job.priority;
  if (!queue.has(prio)) {
    return { status: 'rejected', reason: `unknown priority: ${prio}` };
  }

  // MED 队列深度检查
  if (priorityLevel(prio) === 'med') {
    let medDepth = 0;
    for (const p of ['med-2', 'med-1']) medDepth += queue.get(p).length;
    if (medDepth >= CONFIG.retry.med_max_queue_depth) {
      stats.rejected++;
      stats.byPriority[prio].rejected++;
      return {
        status: 'rejected',
        reason: `MED queue depth exceeded (${medDepth} >= ${CONFIG.retry.med_max_queue_depth})`,
        retry_after: CONFIG.retry.med_reject_retry_after_s,
      };
    }
  }

  // 去重
  if (isDuplicate(job)) {
    stats.rejected++;
    stats.byPriority[prio].rejected++;
    return { status: 'rejected', reason: 'duplicate within dedup window' };
  }

  const id = jobId();
  const entry = {
    id,
    priority: prio,
    source: job.source,
    coin: job.coin,
    name: job.name,
    message: job.message,
    at: job.at,
    model: null, // 出队时才分配
    submittedAt: Date.now(),
  };

  queue.get(prio).push(entry);
  jobMeta.set(id, { job: entry, retryAfter: 0, enqueuedAt: Date.now() });

  stats.submitted++;
  stats.byPriority[prio].submitted++;
  stats.bySource[job.source] = (stats.bySource[job.source] || 0) + 1;

  persistQueue();
  return { status: 'accepted', id, position: queue.get(prio).length };
}

// ════════════════════════════════════════════
// 调度循环
// ════════════════════════════════════════════
// 计算 task 的执行时间戳（毫秒，UTC）
function computeTaskAt(job) {
  const now = Date.now();
  if (!job.at || job.at === 'now' || job.at === '0s') return now;
  if (job.at.endsWith('s') || job.at.endsWith('m') || job.at.endsWith('h')) {
    return now + parseDelay(job.at);
  }
  // ISO 时间戳
  return new Date(job.at).getTime();
}

// 单 tick 内最大 dispatch 数（跨所有优先级），防止 cron 系统被并发击穿
const MAX_DISPATCH_PER_TICK = 2;

function schedulerTick() {
  cleanDedupCache();
  let tickDispatchCount = 0;

  // 按优先级顺序 dequeue
  for (const prio of PRIORITY_ORDER) {
    const jobs = queue.get(prio);
    while (jobs.length > 0) {
      const job = jobs[0];
      const meta = jobMeta.get(job.id);

      // MED/LOW 重试间隔检查 (pro/high 无延迟)
      if (!['pro','high'].includes(priorityLevel(prio)) && meta && meta.retryAfter > Date.now()) {
        break;
      }

      // 节流
      if (!throttleCheck(prio)) {
        break;
      }

      // 计算任务执行时间窗口
      const taskAt = computeTaskAt(job);
      const poolName = CONFIG.priority_pool_map[priorityLevel(prio)] || 'POOL_C';
      const result = selectModel(prio, poolName, taskAt, DEFAULT_DURATION_MS);

      if (result === null) {
        if (meta) {
          const level = priorityLevel(prio);
          if (level === 'pro' || level === 'high') {
            // pro/high 不设重试延迟，直接跳过
          } else if (level === 'med') {
            meta.retryAfter = Date.now() + CONFIG.retry.med_retry_after_ms;
          } else {
            meta.retryAfter = Date.now() + CONFIG.retry.low_retry_after_ms;
          }
        }
        break;
      }

      if (result.waiting) {
        break;
      }

      // 下发
      // 单 tick 串行化：每个 tick 最多 dispatch MAX_DISPATCH_PER_TICK 个任务
      // 防止 openclaw cron add 并发调用被 cron 系统拒绝
      if (tickDispatchCount >= MAX_DISPATCH_PER_TICK) {
        break;
      }

      jobs.shift();
      jobMeta.delete(job.id);
      job.model = result.id;
      job.taskAt = taskAt;

      throttleMap.set(priorityLevel(prio), Date.now());
      tickDispatchCount++;

      executeCronAdd(job);
      persistQueue();
    }
  }
}

// ════════════════════════════════════════════
// HTTP 服务器
// ════════════════════════════════════════════
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function jsonReply(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleSubmit(req, res) {
  jsonBody(req).then(body => {
    // 验证必填字段
    if (!body.priority || !body.source || !body.name || !body.message) {
      return jsonReply(res, 400, {
        status: 'rejected',
        reason: 'missing required fields: priority, source, name, message',
      });
    }

    // 验证优先级合法
    if (!PRIORITY_ORDER.includes(body.priority)) {
      return jsonReply(res, 400, {
        status: 'rejected',
        reason: `unknown priority: ${body.priority}. valid: ${PRIORITY_ORDER.join(', ')}`,
      });
    }

    // 干运行模式
    if (req.url.includes('dry_run=1')) {
      return jsonReply(res, 200, {
        status: 'dry_run',
        priority: body.priority,
        pool: CONFIG.priority_pool_map[priorityLevel(body.priority)],
        message: 'would have been enqueued',
      });
    }

    const result = enqueue(body);

    if (result.status === 'accepted') {
      log('ENQUEUE', `${body.priority} | ${body.coin || '-'} | ${body.source} | id=${result.id} | pos=${result.position}`);
      jsonReply(res, 202, result);
    } else {
      log('REJECT', `${body.priority} | ${body.coin || '-'} | ${body.source} | reason=${result.reason}`);
      jsonReply(res, 429, result);
    }
  }).catch(e => {
    log('ERROR', `请求解析失败: ${e.message}`);
    jsonReply(res, 400, { status: 'error', reason: e.message });
  });
}

function handleStatus(req, res) {
  const queueStatus = {};
  for (const p of PRIORITY_ORDER) {
    queueStatus[p] = queue.get(p).length;
  }

  const now = Date.now();
  const STATUS_WINDOW_MS = 10 * 60 * 1000;
  const modelStatus = [];
  for (const [pn, pool] of Object.entries(CONFIG.pools || {})) {
    for (const m of (pool.models || [])) {
      let active = 0, pending = 0;
      for (const [, job] of activeJobs) {
        if (job.model !== m.id) continue;
        if (job.windowStart <= now && now < job.windowEnd) {
          active++;
        } else if (job.windowStart > now && job.windowStart < now + STATUS_WINDOW_MS) {
          pending++;
        }
      }
      modelStatus.push({
        id: m.id,
        pool: pn,
        active,
        pending,
        max: m.max_concurrent,
        load_pct: Math.round(active / m.max_concurrent * 100),
      });
    }
  }

  const uptimeMs = Date.now() - stats.startedAt;
  const uptimeMin = Math.floor(uptimeMs / 60000);

  jsonReply(res, 200, {
    uptime_min: uptimeMin,
    queue: queueStatus,
    models: modelStatus,
    stats: {
      submitted: stats.submitted,
      dispatched: stats.dispatched,
      rejected: stats.rejected,
      by_priority: stats.byPriority,
      by_source: stats.bySource,
      model_usage: stats.modelUsage,
    },
    // 简化：只返回 level→pool 映射（pro/high/med/low）
    pool_map: CONFIG.priority_pool_map,
    level_routing: { pro: CONFIG.priority_pool_map['pro'] || 'ds-pro', high: CONFIG.priority_pool_map['high'], med: CONFIG.priority_pool_map['med'], low: CONFIG.priority_pool_map['low'] },
  });
}

function handleReload(req, res) {
  try {
    CONFIG = loadConfig();
    loadAgentModels();
    log('INFO', '配置通过 HTTP 接口热重载');
    jsonReply(res, 200, { status: 'ok', message: 'config reloaded' });
  } catch (e) {
    jsonReply(res, 500, { status: 'error', reason: e.message });
  }
}

// ════════════════════════════════════════════
// GET /details — 队列明细 + 活跃任务明细
// ════════════════════════════════════════════
function handleDetails(req, res) {
  const queueDetails = {};
  for (const p of PRIORITY_ORDER) {
    const jobs = queue.get(p) || [];
    queueDetails[p] = jobs.map(j => ({
      id: j.id,
      name: j.name || '-',
      coin: j.coin || '-',
      source: j.source || '-',
      priority: j.priority,
      model: resolveJobModel(j),
      enqueuedAt: (jobMeta.get(j.id) || {}).enqueuedAt || j.submittedAt || null,
      message: (j.message || '').slice(0, 200),
    }));
  }

  const now = Date.now();
  const activeDetails = [];
  for (const [key, job] of activeJobs) {
    activeDetails.push({
      key,
      model: job.model,
      source: job.source,
      coin: job.coin || '-',
      name: job.name || '-',
      windowStart: job.windowStart,
      windowEnd: job.windowEnd,
      remainingMs: Math.max(0, job.windowEnd - now),
      totalMs: job.windowEnd - job.windowStart,
    });
  }

  jsonReply(res, 200, { queue: queueDetails, active: activeDetails });
}

// ════════════════════════════════════════════
// GET /forecast — 24h 载荷热力图数据（按池聚合）
// ════════════════════════════════════════════
function handleClearQueue(req, res) {
  try {
    // 清空中内存队列
    for (const prio of PRIORITY_ORDER) {
      queue.set(prio, []);
    }
    jobMeta.clear();

    // 清空持久化文件
    try { if (fs.existsSync(QUEUE_PERSIST_FILE)) fs.unlinkSync(QUEUE_PERSIST_FILE); } catch (_) {}
    try { if (fs.existsSync(QUEUE_PERSIST_FILE + '.tmp')) fs.unlinkSync(QUEUE_PERSIST_FILE + '.tmp'); } catch (_) {}

    log('INFO', `队列已清空`);
    jsonReply(res, 200, { status: 'ok', cleared: true });
  } catch (e) {
    log('ERROR', `队列清空失败: ${e.message}`);
    jsonReply(res, 500, { error: e.message });
  }
}

// ════════════════════════════════════════════
// POST /admin/reset-all — 紧急重置：清空队列 + 终止运行中cron任务
// ════════════════════════════════════════════
function handleResetAll(req, res) {
  const result = { queueCleared: 0, cronDeleted: 0, activeKilled: 0, errors: [] };

  try {
    // ── 1. 清空排队队列 ──
    let queueCount = 0;
    for (const prio of PRIORITY_ORDER) {
      const arr = queue.get(prio) || [];
      queueCount += arr.length;
      queue.set(prio, []);
    }
    jobMeta.clear();
    try { if (fs.existsSync(QUEUE_PERSIST_FILE)) fs.unlinkSync(QUEUE_PERSIST_FILE); } catch (_) {}
    try { if (fs.existsSync(QUEUE_PERSIST_FILE + '.tmp')) fs.unlinkSync(QUEUE_PERSIST_FILE + '.tmp'); } catch (_) {}
    result.queueCleared = queueCount;
    log('INFO', `[reset-all] 清空队列: ${queueCount} 个任务`);

    // ── 2. 终止运行中任务：仅删除一次性 cron（kind=at），保留循环任务 ──
    // ⚠️ 不能直接删除 activeJobs 中所有 cron 条目，因为包含 morning/evening 等循环任务
    try {
      const listRaw = execSync('openclaw cron list --json 2>&1', { timeout: 15000, encoding: 'utf8' });
      const data = JSON.parse(listRaw);
      const allJobs = Array.isArray(data) ? data : (data.jobs || []);
      
      // 统计活跃的一次性任务
      const activeOneShotIds = new Set();
      for (const [key, val] of activeJobs) {
        if (val.source === 'cron') {
          const cronId = key.startsWith('cron:') ? key.slice(5) : key;
          activeOneShotIds.add(cronId);
        }
      }

      for (const job of allJobs) {
        const isOneShot = job.schedule?.kind === 'at';
        const isActive = activeOneShotIds.has(job.id);
        
        if (isOneShot) {
          // 删除所有一次性 cron（无论是否活跃）
          try {
            execSync(`openclaw cron rm ${job.id}`, { timeout: 10000, encoding: 'utf8' });
            result.cronDeleted++;
            if (isActive) result.activeKilled++;
            log('INFO', `[reset-all] 已删除一次性 cron: ${job.id} (${job.name || '未命名'})${isActive ? ' [运行中]' : ''}`);
          } catch (e) {
            result.errors.push(`删除 cron ${job.id} 失败: ${e.message}`);
          }
        }
      }
    } catch (e) {
      result.errors.push(`获取 cron 列表失败: ${e.message}`);
    }

    // ── 3. 统计 dispatch-pending 被终止数 ──
    for (const [key, val] of activeJobs) {
      if (val.source === 'dispatch-pending') {
        result.activeKilled++;
      }
    }

    // ── 4. 清空 activeJobs（循环 cron 下次 importCronJobs 会自动恢复） ──
    activeJobs.clear();

    log('INFO', `[reset-all] 完成: 清空${result.queueCleared}队列 删除${result.cronDeleted}一次性cron 终止${result.activeKilled}活跃`);
    jsonReply(res, 200, { status: 'ok', result });
  } catch (e) {
    result.errors.push(`系统异常: ${e.message}`);
    log('ERROR', `[reset-all] 失败: ${e.message}`);
    jsonReply(res, 500, { error: e.message, result });
  }
}

function handleForecast(req, res) {
  const now = Date.now();
  const SLOT_MIN = 30;
  const SLOT_MS = SLOT_MIN * 60 * 1000;
  const HORIZON_MS = 24 * 60 * 60 * 1000;
  const slots = [];

  for (let t = now; t < now + HORIZON_MS; t += SLOT_MS) {
    const slotEnd = t + SLOT_MS;
    const byPool = {};
    for (const [, job] of activeJobs) {
      if (job.windowStart < slotEnd && t < job.windowEnd) {
        // 找到这个模型属于哪个池子
        let poolName = 'default';
        for (const [pn, pool] of Object.entries(CONFIG.pools || {})) {
          if ((pool.models || []).some(m => m.id === job.model)) { poolName = pn; break; }
        }
        byPool[poolName] = (byPool[poolName] || 0) + 1;
      }
    }
    slots.push({ ts: t, loads: byPool });
  }

  // 池子元数据
  const poolMeta = {};
  for (const [pn, pool] of Object.entries(CONFIG.pools || {})) {
    const models = pool.models || [];
    poolMeta[pn] = {
      models: models.map(m => ({ id: m.id, label: m.id.split('/').pop(), max: m.max_concurrent })),
      total_max: models.reduce((s, m) => s + m.max_concurrent, 0),
    };
  }

  jsonReply(res, 200, { slots, pools: poolMeta, slot_min: SLOT_MIN });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/submit')) {
    return handleSubmit(req, res);
  }
  if (req.method === 'GET' && req.url === '/status') {
    return handleStatus(req, res);
  }
  if (req.method === 'GET' && req.url === '/details') {
    return handleDetails(req, res);
  }
  if (req.method === 'GET' && req.url === '/forecast') {
    return handleForecast(req, res);
  }
  if (req.method === 'POST' && req.url === '/reload') {
    return handleReload(req, res);
  }
  if (req.method === 'POST' && req.url === '/admin/clear-queue') {
    return handleClearQueue(req, res);
  }
  if (req.method === 'POST' && req.url === '/admin/reset-all') {
    return handleResetAll(req, res);
  }
  jsonReply(res, 404, { error: 'not found' });
});

// ════════════════════════════════════════════
// 启动
// ════════════════════════════════════════════
const port = CONFIG.port || 3102;

server.listen(port, '127.0.0.1', () => {
  log('INFO', `调度器已启动，端口 ${port}`);

  // 加载 agent 模型映射
  loadAgentModels();

  // 恢复持久化队列
  const restored = restoreQueue();
  if (restored > 0) log('INFO', `队列恢复: ${restored} 个任务`);

  // 首次同步导入 cron 缓存（缓存文件通常存在，由上次运行写入）
  // 确保 activeJobs 包含正在运行的 cron 任务，防止调度器见空池子全部派发
  importCronJobs();

  // 首次缓存刷新（启动时立即获取），完成后首次导入
  refreshLoadCache();
  setTimeout(pollModelLoad, 8000);

  // 调度循环
  setInterval(schedulerTick, CONFIG.scheduler.tick_interval_ms);
  log('INFO', `调度循环已启动，间隔 ${CONFIG.scheduler.tick_interval_ms}ms`);

  // 缓存刷新（后台 spawn gateway） — 每 30s
  setInterval(refreshLoadCache, 30000);
  log('INFO', `缓存刷新已启动，间隔 30000ms`);

  // 负载采集（读缓存文件，毫秒级） — 每 5s
  setInterval(pollModelLoad, 5000);
  log('INFO', `负载采集已启动，间隔 5000ms`);

  const totalModels = Object.values(CONFIG.pools || {}).reduce((s, p) => s + (p.models || []).length, 0);
  log('INFO', `配置: ${totalModels} 个模型, ${Object.keys(CONFIG.pools || {}).length} 个池子, ${PRIORITY_ORDER.length} 个优先级`);
});

process.on('uncaughtException', (err) => {
  log('ERROR', `未捕获异常: ${err.message}\n${err.stack}`);
});

log('INFO', '调度器进程启动');
