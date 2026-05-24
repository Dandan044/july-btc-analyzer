#!/usr/bin/env node
/**
 * BTC 警报器引擎
 * 
 * 加载 rules/ 目录下的所有规则，为每个规则启动独立定时器
 * 自动记录所有规则的执行日志
 * 支持规则归档（过期或完成时移动到 rules-archive/）
 */

const fs = require('fs');
const path = require('path');
const CONFIG = require('../../tasks/global-config.json');

const RULES_DIR = path.join(__dirname, 'rules');
const ARCHIVE_DIR = path.join(__dirname, 'rules-archive');
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const RULES_STATE_FILE = path.join(__dirname, 'rules-state.json');

// ═══ 运行时状态（与规则定义文件分离，避免引擎自写入触发热重载死循环） ═══
// 结构: { [filename]: { lastCheckedAt: 'ISO' } }
// 引擎启动时从 rules-state.json 加载，每次 check() 后写回
let ruleState = {};

// 扫描间隔：检查规则文件是否存在
const SCAN_INTERVAL = 60 * 1000; // 1分钟

// 4小时窗口（毫秒）
const THRESHOLD_WINDOW_MS = 4 * 60 * 60 * 1000;

// 存储每个规则的定时器
const timers = new Map();

// 存储正在运行的规则信息（用于扫描检查）
const activeRules = new Map();

// 存储每个规则的错误统计
// 结构: { consecutiveErrors, threshold5HitCount, threshold5FirstTime }
const ruleErrorStats = new Map();

// [已废弃] 触发冷却时间 — 触发即归档后不再需要
// 结构: { cooldownUntil: timestamp, lastTriggerTime: timestamp }
// const triggerCooldowns = new Map();

// 存储自愈状态（每个规则只给一次自愈机会）
// 结构: { attempted: boolean, spawnTime: timestamp }
const selfHealState = new Map();

// [已废弃] 默认冷却时间 — 触发即归档后不再需要
// const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

// 自愈等待期：10分钟（毫秒）
const SELF_HEAL_GRACE_PERIOD = 10 * 60 * 1000;

// ═══ 并发控制：最多同时 3 条规则在执行 API 调用 ═══
const MAX_CONCURRENT_CHECKS = 3;
let activeChecks = 0;
const waitingQueue = [];

function acquireSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    waitingQueue.push(resolve);
  });
}

function releaseSlot() {
  activeChecks--;
  if (waitingQueue.length > 0 && activeChecks < MAX_CONCURRENT_CHECKS) {
    const next = waitingQueue.shift();
    activeChecks++;
    next();
  }
}

// ========== 日志系统 ==========

// 日志级别控制（环境变量 LOG_LEVEL 可覆盖，默认 INFO）
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * 格式化时间戳 (北京时间 GMT+8)
 */
function timestamp() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijing.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * 写入引擎日志（统一输出到控制台，由PM2捕获到单一日志文件）
 * 带级别标签，所有日志保留输出（不过滤）
 */
function logEngine(level, ruleName, message, data = null) {
  const levelTag = `[${level}]`;
  const prefix = level === 'ERROR' ? '[❌警报引擎错误]' : '[🔧警报引擎]';
  const consoleMsg = `${prefix} ${levelTag} [${ruleName}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}`;
  
  if (level === 'ERROR') {
    console.error(consoleMsg);
  } else {
    console.log(consoleMsg);
  }
}

/**
 * 记录规则事件
 */
function logRuleEvent(ruleName, event, details = {}) {
  // 根据事件类型分配级别，但所有事件都保留输出
  let level = 'INFO';
  if (event === 'CHECK_PASSED' /* [已废弃] || event === 'COOLDOWN_ACTIVE' */) {
    level = 'DEBUG';
  }
  logEngine(level, ruleName, event, details);
}

// ========== 错误监控与通知 ==========

/**
 * 通知十四月（通过QQ告知主人）
 */
function notifyShisiyue(message) {
  const { spawn } = require('child_process');
  const now = new Date().toISOString();
  const jobName = `notify-shisiyue-${Date.now()}`;
  
  const spawnMessage = `请使用 message 工具通过 QQ 向主人发送以下消息：

channel: qqbot
target: qqbot:c2c:3264012CFFDCF2666417B4D4ABACEFFF

---消息内容---
${message}`;

  spawn('openclaw', [
    'cron', 'add',
    '--agent', 'shisiyue',
    '--session', 'isolated',
    '--at', now,
    '--message', spawnMessage,
    '--name', jobName,
    '--delete-after-run',
    '--no-deliver'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  console.log(`[🔧警报引擎] 已派发通知给十四月 (job: ${jobName})`);
}

// ========== 网络事件缓冲池（替代即时通知）==========

/**
 * 网络事件缓冲池
 * 收集所有网络异常调整和恢复事件，每4小时发送一次汇总报告
 * 避免每次网络波动都即时通知造成骚扰
 */
const NETWORK_BUFFER_WINDOW_MS = 4 * 60 * 60 * 1000; // 4小时

// 缓冲池结构: [ { eventType, ruleName, time, fromInterval, toInterval } ]
let networkEventBuffer = [];
let lastSummaryTime = 0;
let networkSummaryTimer = null;

/**
 * 记录网络事件到缓冲池
 */
function recordNetworkEvent(eventType, ruleName, originalMs, newMs) {
  networkEventBuffer.push({
    eventType: eventType, // 'adjusted' | 'restored'
    ruleName: ruleName,
    time: Date.now(),
    fromInterval: originalMs,
    toInterval: newMs
  });
}

/**
 * 格式化间隔（毫秒 → 人类可读）
 */
function formatInterval(ms) {
  if (ms < 60000) return `${ms / 1000}s`;
  return `${ms / 60000}min`;
}

/**
 * 刷新汇总通知并清空缓冲池
 */
function flushNetworkSummary() {
  if (networkEventBuffer.length === 0) return;
  
  const now = Date.now();
  const buffer = networkEventBuffer;
  networkEventBuffer = []; // 立即清空，防止递归
  
  // 窗口截止时间
  const windowStart = new Date(now - NETWORK_BUFFER_WINDOW_MS);
  
  // 筛选当前窗口内的事件
  const windowEvents = buffer.filter(e => e.time > now - NETWORK_BUFFER_WINDOW_MS);
  if (windowEvents.length === 0) return;
  
  // 按规则分类
  const ruleMap = new Map(); // ruleName → { adjustments: [], restorations: [] }
  for (const e of windowEvents) {
    if (!ruleMap.has(e.ruleName)) {
      ruleMap.set(e.ruleName, { adjustments: [], restorations: [] });
    }
    const record = ruleMap.get(e.ruleName);
    if (e.eventType === 'adjusted') {
      record.adjustments.push(e);
    } else {
      record.restorations.push(e);
    }
  }
  
  // 构建消息
  const lines = [];
  lines.push(`主人～以下是过去4小时内网络波动影响的警报规则汇总：`);
  lines.push(``);
  
  let totalAdjust = 0, totalRestore = 0;
  for (const [name, record] of ruleMap) {
    totalAdjust += record.adjustments.length;
    totalRestore += record.restorations.length;
    
    const lastAdj = record.adjustments[record.adjustments.length - 1];
    const lastRst = record.restorations[record.restorations.length - 1];
    
    // 当前状态
    let status = '';
    let detail = '';
    if (lastAdj && (!lastRst || lastRst.time < lastAdj.time)) {
      status = '⚠️ 间隔已翻倍';
      detail = `${formatInterval(lastAdj.fromInterval)} → ${formatInterval(lastAdj.toInterval)}`;
    } else if (lastRst) {
      status = '✅ 已恢复';
      detail = `恢复至 ${formatInterval(lastRst.toInterval)}`;
    } else {
      status = '❓ 状态未知';
    }
    
    lines.push(`  ${status} ${name}`);
    if (detail) lines.push(`     ${detail}`);
    
    // 记录时间戳
    if (record.adjustments.length > 0) {
      const firstTime = new Date(record.adjustments[0].time).toLocaleString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const lastTime = new Date(record.adjustments[record.adjustments.length - 1].time).toLocaleString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      if (record.adjustments.length === 1) {
        lines.push(`     发生时间: ${firstTime}`);
      } else {
        lines.push(`     发生时段: ${firstTime} → ${lastTime} (${record.adjustments.length}次)`);
      }
    }
    lines.push(``);
  }
  
  lines.push(`总计: ${totalAdjust}条规则被调整，${totalRestore}条已恢复`);
  
  const msg = lines.join('\n');
  notifyShisiyue(msg);
  lastSummaryTime = now;
  logEngine('INFO', '网络缓冲', 'SUMMARY_SENT', {
    eventCount: windowEvents.length,
    adjustedCount: totalAdjust,
    restoredCount: totalRestore
  });
}

/**
 * 安排下一次汇总通知
 */
function scheduleNetworkSummary() {
  if (networkSummaryTimer) clearTimeout(networkSummaryTimer);
  // 4小时后或缓冲池非空时触发
  const nextFlush = NETWORK_BUFFER_WINDOW_MS;
  networkSummaryTimer = setTimeout(() => {
    flushNetworkSummary();
    scheduleNetworkSummary(); // 递归安排下一轮
  }, nextFlush);
  // 确保定时器不阻止进程退出
  if (networkSummaryTimer && networkSummaryTimer.unref) {
    networkSummaryTimer.unref();
  }
}

/**
 * 判断错误是否为网络层问题
 * 网络类错误不触发自愈 AI 任务，改为引擎内置间隔调整
 */
function isNetworkError(errorMessage) {
  const NETWORK_PATTERNS = [
    /TLS socket disconnected/i,
    /Client network socket disconnected/i,
    /read ECONNRESET/i,
    /ETIMEDOUT/i,
    /ECONNREFUSED/i,
    /socket hang up/i,
    /Too Many Requests/i,
    /请求超时/,
  ];
  return NETWORK_PATTERNS.some(p => p.test(errorMessage));
}

/**
 * 重启规则定时器（用于间隔调整后的重新调度）
 */
function restartRuleTimer(filename, ruleInfo, newIntervalMs) {
  if (timers.has(filename)) {
    clearInterval(timers.get(filename));
  }
  const { name } = ruleInfo.module;
  const timer = setInterval(async () => {
    const result = await runRule(ruleInfo);
    if (result === 'stop') {
      unloadRule(filename, name, 'lifetime_ended');
    } else if (result === 'pause') {
      unloadRule(filename, name, 'error_threshold_reached');
    }
  }, newIntervalMs);
  timers.set(filename, timer);
}

/**
 * 统计当前受网络影响的规则数
 */
function countNetworkAffectedRules() {
  let count = 0;
  for (const [, stats] of ruleErrorStats) {
    if (stats.originalInterval !== null) count++;
  }
  return count;
}

/**
 * 因网络错误调整规则间隔（翻倍，上限15分钟）
 */
function adjustIntervalForNetworkError(filename, ruleName, errorMessage) {
  const stats = getErrorStats(filename);
  
  // 已调整过，不重复调整
  if (stats.originalInterval !== null) return;
  
  const info = activeRules.get(filename);
  if (!info || !info.module) return;
  
  const rule = info.module;
  const currentMs = rule.interval;
  const newMs = Math.min(currentMs * 2, 15 * 60 * 1000);
  
  if (newMs === currentMs) return; // 已达15min上限
  
  stats.originalInterval = currentMs;
  rule.interval = newMs;
  
  const ruleInfo = { filename, module: rule, path: info.path };
  restartRuleTimer(filename, ruleInfo, newMs);
  
  logEngine('INFO', ruleName, 'NETWORK_ADJUSTED', {
    reason: errorMessage,
    newIntervalMs: newMs,
    originalIntervalMs: currentMs
  });
  
  // 记录到缓冲池（替代即时通知）
  recordNetworkEvent('adjusted', ruleName, currentMs, newMs);
}

// ========== 自愈诊断 ==========

/**
 * 派发自愈诊断任务给七月
 * 通过 cron add 创建一次性 isolated session
 */
function spawnSelfHeal(filename, ruleName, errorMessage, errorStack) {
  const { spawn } = require('child_process');
  const now = new Date().toISOString();
  const safeName = ruleName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-').substring(0, 40);
  const jobName = `selfheal-${safeName}-${Date.now()}`;
  
  // 模型从 global-config.json 读取
  const model = CONFIG.selfHeal?.model || 'deepseek/deepseek-v4-pro';
  
  const message = `[SELF_HEAL] 警报器自愈诊断任务

规则文件: skills/btc-alert/rules/${filename}
规则名称: ${ruleName}
错误信息: ${errorMessage}
错误堆栈: ${errorStack || '无堆栈信息'}

请读取 tasks/alert-self-heal.md 执行自愈诊断流程。`;

  spawn('openclaw', [
    'cron', 'add',
    '--agent', 'july',
    '--model', model,
    '--session', 'isolated',
    '--at', now,
    '--message', message,
    '--name', jobName,
    '--delete-after-run',
    '--no-deliver'
  ], { detached: true, stdio: 'ignore' });
  
  logRuleEvent(ruleName, 'SELF_HEAL_SPAWNED', { jobName, model });
  console.log(`[🔧警报引擎] 已派发自愈诊断任务: ${jobName} (model: ${model})`);
}

/**
 * 获取或初始化规则的错误统计
 */
function getErrorStats(filename) {
  if (!ruleErrorStats.has(filename)) {
    ruleErrorStats.set(filename, {
      consecutiveErrors: 0,
      threshold5HitCount: 0,
      threshold5FirstTime: null,
      originalInterval: null  // ★ 网络调整前原始间隔
    });
  }
  return ruleErrorStats.get(filename);
}

/**
 * 重置规则的错误统计
 */
function resetErrorStats(filename) {
  ruleErrorStats.set(filename, {
    consecutiveErrors: 0,
    threshold5HitCount: 0,
    threshold5FirstTime: null,
    originalInterval: null
  });
}

/**
 * 处理规则执行错误
 * @returns {boolean} true 表示应该暂停规则
 */
function handleRuleError(filename, ruleName, errorMessage, errorStack) {
  const stats = getErrorStats(filename);
  const now = Date.now();
  
  // ★ 方案四：网络错误前置拦截 → 不计入错误次数，直接翻倍间隔
  if (isNetworkError(errorMessage)) {
    adjustIntervalForNetworkError(filename, ruleName, errorMessage);
    return false; // 不暂停规则，不触发自愈
  }
  
  // 检查4小时窗口是否过期
  if (stats.threshold5HitCount > 0 && stats.threshold5FirstTime) {
    if (now - stats.threshold5FirstTime > THRESHOLD_WINDOW_MS) {
      // 超过4小时，重置计数
      stats.threshold5HitCount = 0;
      stats.threshold5FirstTime = null;
      logRuleEvent(ruleName, '错误计数窗口过期，重置');
    }
  }
  
  // 获取或初始化自愈状态
  let healState = selfHealState.get(filename);
  if (!healState) {
    healState = { attempted: false, spawnTime: 0 };
    selfHealState.set(filename, healState);
  }
  
  // ★ 自愈等待期内：错误不计入统计（给七月修复时间）
  if (healState.attempted && healState.spawnTime > 0) {
    const elapsed = now - healState.spawnTime;
    if (elapsed < SELF_HEAL_GRACE_PERIOD) {
      logEngine('INFO', ruleName, '自愈等待期内错误（不计入统计）', {
        error: errorMessage,
        elapsedSeconds: Math.floor(elapsed / 1000),
        remainingSeconds: Math.floor((SELF_HEAL_GRACE_PERIOD - elapsed) / 1000)
      });
      return false; // 不暂停
    }
    // 等待期结束，恢复统计
    logEngine('WARN', ruleName, '自愈等待期结束，恢复错误统计', {
      elapsedSeconds: Math.floor(elapsed / 1000)
    });
    healState.spawnTime = 0; // 清除等待状态
  }
  
  // 增加连续错误计数
  stats.consecutiveErrors++;
  
  logEngine('WARN', ruleName, '规则执行失败', {
    error: errorMessage,
    consecutiveErrors: stats.consecutiveErrors,
    selfHealAttempted: healState.attempted
  });
  
  // 达到5次阈值
  if (stats.consecutiveErrors === 5) {
    // 首次达到5次，记录时间
    if (stats.threshold5FirstTime === null) {
      stats.threshold5FirstTime = now;
    }
    
    if (!healState.attempted) {
      // ★ 首次触发阈值 → 派发自愈诊断
      healState.attempted = true;
      healState.spawnTime = now;
      
      // 通知十四月
      const notifyMsg = `主人～警报器规则「${ruleName}」连续失败5次，已自动派发自愈诊断任务。

规则: ${ruleName}
文件: ${filename}
错误: ${errorMessage}

七月正在诊断修复中，等待期10分钟。若自愈成功将自动恢复，若失败则归档暂停。`;
      notifyShisiyue(notifyMsg);
      
      // 派发自愈任务
      spawnSelfHeal(filename, ruleName, errorMessage, errorStack || '');
      
      // 重置错误计数（等待期内不计）
      stats.consecutiveErrors = 0;
      stats.threshold5FirstTime = null;
      
      logRuleEvent(ruleName, 'SELF_HEAL_TRIGGERED', { error: errorMessage });
      return false; // 不暂停，给自愈机会
    }
    
    // ★ 已尝试过自愈 → 直接归档（每个规则只给一次机会）
    stats.threshold5HitCount++;
    
    const archiveMsg = `主人～警报器规则「${ruleName}」自愈失败，已自动归档。

规则: ${ruleName}
文件: ${filename}
原因: 已尝试自愈修复，但错误仍然持续
最后错误: ${errorMessage}

规则文件已归档至 rules-archive/，如需重新启用请手动处理。`;
    notifyShisiyue(archiveMsg);
    
    logRuleEvent(ruleName, 'SELF_HEAL_FAILED_ARCHIVED', {
      error: errorMessage,
      threshold5HitCount: stats.threshold5HitCount
    });
    
    return true; // 暂停并归档
  }
  
  // 达到10次阈值（永不触发自愈的极端情况下的兜底保护）
  if (stats.consecutiveErrors === 10) {
    const pauseMsg = `主人～警报器规则已暂停！

规则: ${ruleName}
原因: 连续失败10次（未触发自愈阈值）
错误: ${errorMessage}

请检查后手动重启～`;
    
    notifyShisiyue(pauseMsg);
    logRuleEvent(ruleName, 'RULE_PAUSED', { reason: '连续失败10次' });
    return true; // 暂停
  }
  
  return false; // 不暂停
}

/**
 * 处理规则执行成功
 */
function handleRuleSuccess(filename, ruleName) {
  const stats = getErrorStats(filename);
  const healState = selfHealState.get(filename);
  
  if (stats.consecutiveErrors > 0 || stats.threshold5HitCount > 0 || (healState && healState.attempted)) {
    logRuleEvent(ruleName, '规则恢复正常', { 
      previousConsecutiveErrors: stats.consecutiveErrors,
      previousThreshold5HitCount: stats.threshold5HitCount,
      selfHealRecovered: healState?.attempted || false
    });
    
    // 自愈成功，通知十四月
    if (healState && healState.attempted) {
      const successMsg = `主人～警报器规则「${ruleName}」自愈成功！

规则已恢复正常运行。自愈诊断任务已完成修复～`;
      notifyShisiyue(successMsg);
    }
  }
  
  // 成功一次，完全重置
  resetErrorStats(filename);
  selfHealState.delete(filename);
}

// ========== 规则管理 ==========

/**
 * 加载运行时状态（引擎启动时调用一次）
 */
function loadRuleState() {
  try {
    if (fs.existsSync(RULES_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(RULES_STATE_FILE, 'utf8'));
      ruleState = data;
      console.log(`[🔧警报引擎] 已加载运行时状态 (${Object.keys(ruleState).length} 条记录)`);
    }
  } catch (e) {
    // 文件损坏则丢弃，从空状态开始
    console.log('[🔧警报引擎] 运行时状态文件损坏，将重新创建');
    ruleState = {};
  }
}

/**
 * 保存运行时状态到 rules-state.json
 */
function saveRuleState() {
  try {
    fs.writeFileSync(RULES_STATE_FILE, JSON.stringify(ruleState, null, 2), 'utf8');
  } catch (e) {
    // 静默失败，不阻塞规则执行
  }
}

/**
 * 更新规则的最近检测时间
 *
 * 写入运行时状态文件 rules-state.json，不再修改规则定义文件。
 * 这样规则文件的 mtime 只在真正被外部修改时才变化，不会触发热重载死循环。
 */
function updateLastChecked(filename) {
  if (!ruleState[filename]) {
    ruleState[filename] = {};
  }
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const iso = bj.toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
  ruleState[filename].lastCheckedAt = iso;
  saveRuleState();
}

/**
 * 归档规则文件（含元数据写入）
 *
 * reason → archivedBy 映射:
 *   'triggered'                  → trigger-fired
 *   'error_threshold_exceeded'   → lifetime-expired
 *   'expired' / 'completed'      → lifetime-expired
 */
function archiveRule(filename, ruleName, reason) {
  // 确保归档目录存在
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  
  const sourcePath = path.join(RULES_DIR, filename);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const archiveName = `${ts}_${filename}`;
  const archivePath = path.join(ARCHIVE_DIR, archiveName);

  // 归档来源映射
  const archivedByMap = {
    triggered: 'trigger-fired',
    trigger_collect_error: 'trigger-collect-error',
    error_threshold_exceeded: 'lifetime-expired',
    expired: 'lifetime-expired',
    completed: 'lifetime-expired',
  };
  const archivedBy = archivedByMap[reason] || 'lifetime-expired';

  try {
    // ⭐ 写入归档元数据（移动前）
    let content = fs.readFileSync(sourcePath, 'utf8');

    // status: 'active' → 'archived'（兼容各种引号写法）
    content = content.replace(/(status:\s*)['"]active['"]/, "$1'archived'");

    // archivedAt
    const now = new Date();
    const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const archiveTime = bj.toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');

    if (/archivedAt:/.test(content)) {
      content = content.replace(/(archivedAt:\s*)[^,\n]+/, `$1'${archiveTime}'`);
    } else {
      // 旧格式无归档字段 → 在 C19 END 或 name: 后注入
      const inject = [
        `status: 'archived',`,
        `archivedAt: '${archiveTime}',`,
        `archivedBy: '${archivedBy}',`,
        `archiveReason: '${reason}',`,
      ].join('\n');
      const c19Re = /(\s*\/\/\s*⭐\s*C19\s*END)/;
      if (c19Re.test(content)) {
        content = content.replace(c19Re, `${inject}\n$1`);
      } else {
        content = content.replace(/(  name:\s*['"][^'"]+['"],)/, `$1\n${inject}`);
      }
    }

    // archivedBy（仅当字段已存在时更新）
    if (/archivedBy:/.test(content)) {
      content = content.replace(/(archivedBy:\s*)[^,\n]+/, `$1'${archivedBy}'`);
    }
    // archiveReason（仅当字段已存在时更新）
    if (/archiveReason:/.test(content)) {
      content = content.replace(/(archiveReason:\s*)[^,\n]+/, `$1'${reason}'`);
    }

    fs.writeFileSync(sourcePath, content, 'utf8');

    // 移动到归档目录
    fs.renameSync(sourcePath, archivePath);
    logRuleEvent(ruleName, 'RULE_ARCHIVED', { 
      archivePath: archivePath,
      reason: reason,
      archivedBy: archivedBy
    });
    console.log(`[🔧警报引擎] 已归档规则 "${ruleName}" 到 ${archivePath} | archivedBy=${archivedBy}`);
    return true;
  } catch (error) {
    logEngine('ERROR', ruleName, '归档失败', { error: error.message });
    return false;
  }
}

/**
 * 加载单个规则文件
 * @returns {object|null} 规则信息或 null（加载失败）
 */
function loadSingleRule(file) {
  try {
    const rulePath = path.join(RULES_DIR, file);
    // 清除缓存以获取最新版本
    delete require.cache[require.resolve(rulePath)];
    
    const rule = require(rulePath);
    
    // 验证必需字段
    if (!rule.name || !rule.interval || !rule.check || !rule.collect || !rule.trigger || !rule.lifetime) {
      console.warn(`[🔧警报引擎] 规则 ${file} 缺少必需字段，跳过`);
      logEngine('WARN', 'Engine', `规则缺少必需字段: ${file}`);
      return null;
    }
    
    return {
      filename: file,
      path: rulePath,
      module: rule
    };
  } catch (error) {
    console.error(`[🔧警报引擎] 加载规则失败 ${file}:`, error.message);
    logEngine('ERROR', 'Engine', `加载规则失败: ${file}`, { error: error.message });

    // ★ 接入自愈管道：加载失败（语法错误/依赖缺失）也触发错误统计
    //    累计5次后自动派发自愈诊断任务，而非永久静默跳过
    const loadName = file.replace(/\.js$/, '');
    handleRuleError(file, loadName, error.message, error.stack);

    return null;
  }
}

/**
 * 加载所有规则
 */
function loadRules() {
  const rules = [];
  
  if (!fs.existsSync(RULES_DIR)) {
    console.log(`[🔧警报引擎] 规则目录不存在，正在创建...`);
    fs.mkdirSync(RULES_DIR, { recursive: true });
    return rules;
  }
  
  const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.js'));
  
  for (const file of files) {
    const ruleInfo = loadSingleRule(file);
    if (ruleInfo) {
      rules.push(ruleInfo);
      console.log(`[🔧警报引擎] 已加载规则: ${ruleInfo.module.name} (检查间隔: ${ruleInfo.module.interval}ms)`);
    }
  }
  
  return rules;
}

/**
 * 执行单个规则
 */
async function runRule(ruleInfo) {
  const { filename, module: rule } = ruleInfo;
  const { name, check, collect, trigger, lifetime } = rule;
  
  try {
    // 检查生命周期
    const status = lifetime.call(rule);
    if (status === 'expired' || status === 'completed') {
      logRuleEvent(name, 'RULE_STOPPED', { status });
      
      // 归档规则
      archiveRule(filename, name, status);
      return 'stop';
    }
    
    if (status !== 'active') {
      logRuleEvent(name, 'RULE_STOPPED', { status });
      return 'stop';
    }
    
    // [已废弃] 冷却期检查 — 触发即归档后不再需要，保留代码供参考
    // const cooldownInfo = triggerCooldowns.get(filename);
    // if (cooldownInfo && cooldownInfo.cooldownUntil) {
    //   const now = Date.now();
    //   if (now < cooldownInfo.cooldownUntil) {
    //     const remainingMs = cooldownInfo.cooldownUntil - now;
    //     const remainingMin = Math.ceil(remainingMs / 60000);
    //     logRuleEvent(name, 'COOLDOWN_ACTIVE', { 
    //       remainingMinutes: remainingMin,
    //       lastTriggerTime: cooldownInfo.lastTriggerTime 
    //     });
    //     return 'continue'; // 在冷却期内，跳过检测
    //   }
    // }
    
    // 记录检测开始
    logRuleEvent(name, 'CHECK_START');
    
    // ★ 获取并发槽位（最多3条规则同时执行API调用，超出的排队等待）
    await acquireSlot();
    try {
      // 执行检测（使用 .call(rule) 保持 this 绑定）
      const shouldTrigger = await check.call(rule);

      // ⭐ 更新规则文件的最近检测时间（兼容旧规则：无字段则自动创建）
      updateLastChecked(filename);
      
      if (shouldTrigger) {
        logRuleEvent(name, 'TRIGGERED');
        
        try {
          // 收集数据
          const data = await collect.call(rule);
          logRuleEvent(name, 'DATA_COLLECTED', { dataKeys: Object.keys(data || {}) });
          
          // 触发动作
          await trigger.call(rule, data);
          
          logRuleEvent(name, 'TRIGGER_COMPLETED');
          
          // ★ 只有完整链路成功才重置错误统计
          handleRuleSuccess(filename, name);
          
          // ⭐ 触发即归档（引擎层强制执行，规则无法绕过）
          // 规则文件被移动到 rules-archive/，定时器被清除
          archiveRule(filename, name, 'triggered');
          return 'stop';
        } catch (collectError) {
          // ★ check() 通过但 collect()/trigger() 崩溃 → 代码逻辑 bug
          // 重试大概率失败，ReferenceError/TypeError 直接归档终止死循环
          const isCodeBug = collectError instanceof ReferenceError
                         || collectError instanceof TypeError
                         || collectError.message?.includes('is not defined');
          
          if (isCodeBug) {
            logEngine('WARN', name, '触发后执行失败（代码bug，立即归档终止循环）', {
              error: collectError.message,
              errorType: collectError.constructor.name
            });
            archiveRule(filename, name, 'trigger_collect_error');
            return 'stop';
          }
          
          // 网络错误 → 走正常错误处理（调整间隔）
          logEngine('WARN', name, '触发后执行失败（非代码bug）', {
            error: collectError.message
          });
          const shouldPause = handleRuleError(filename, name, collectError.message, collectError.stack);
          if (shouldPause) return 'pause';
          return 'continue';
        }
      }
    } finally {
      releaseSlot();
    }
    // else: check 返回 false（正常无触发），不重置错误统计
    
    // ★ 网络恢复检测：本次正常执行成功，若之前有网络调整则恢复原始间隔
    const netStats = getErrorStats(filename);
    if (netStats.originalInterval !== null) {
      const originalMs = netStats.originalInterval;
      netStats.originalInterval = null;
      rule.interval = originalMs;
      restartRuleTimer(filename, ruleInfo, originalMs);
      logEngine('INFO', name, 'NETWORK_RESTORED', {
        restoredIntervalMs: originalMs
      });
      // 记录恢复事件到缓冲池
      recordNetworkEvent('restored', name, null, originalMs);
    }
    
    return 'continue';
  } catch (error) {
    // 处理错误，决定是否暂停
    const shouldPause = handleRuleError(filename, name, error.message, error.stack);
    
    if (shouldPause) {
      return 'pause'; // 新增暂停状态
    }
    
    return 'continue';
  }
}

/**
 * 卸载规则（停止定时器并清理）
 * 
 * 当 reason 为 error_threshold_reached 时：
 *   先将规则文件 move 到归档目录，再清理内存状态。
 *   文件从 rules/ 消失 → 扫描器找不到 → 不会复活 → 循环彻底断裂。
 */
function unloadRule(filename, ruleName, reason) {
  if (timers.has(filename)) {
    clearInterval(timers.get(filename));
    timers.delete(filename);
  }
  
  if (reason === 'error_threshold_reached') {
    // ⭐ 直接归档：文件物理消失，扫描器不会再加载它
    archiveRule(filename, ruleName, 'error_threshold_exceeded');
  }
  
  activeRules.delete(filename);
  // [已废弃] triggerCooldowns.delete(filename); — 冷却机制已移除
  
  // 清理运行时状态
  delete ruleState[filename];
  saveRuleState();
  
  logRuleEvent(ruleName, 'RULE_UNLOADED', { reason });
  console.log(`[🔧警报引擎] 正在卸载规则 "${ruleName}" (${reason})`);
}

/**
 * 获取文件的修改时间（mtime）
 * @param {string} filePath - 文件路径
 * @returns {number|null} mtime 时间戳，文件不存在时返回 null
 */
function getFileMtime(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const stats = fs.statSync(filePath);
    return stats.mtimeMs;
  } catch (e) {
    return null;
  }
}

/**
 * 重新加载被修改的规则
 * @param {string} filename - 规则文件名
 * @param {object} oldInfo - 旧的规则信息（来自 activeRules）
 */
function reloadRule(filename, oldInfo) {
  const oldName = oldInfo.name;
  
  // 1. 停止旧定时器（但不清理冷却状态，保持连续性）
  if (timers.has(filename)) {
    clearInterval(timers.get(filename));
    timers.delete(filename);
  }
  
  // 2. 加载新版本
  const ruleInfo = loadSingleRule(filename);
  if (!ruleInfo) {
    // 加载失败，保留旧版本信息但标记为问题
    logEngine('ERROR', oldName, '规则重新加载失败，保留旧版本', { file: filename });
    return;
  }
  
  const newName = ruleInfo.module.name;
  
  // 3. 更新 activeRules（包含新的 mtime 和 module）
  activeRules.set(filename, {
    name: newName,
    path: ruleInfo.path,
    filename: filename,
    mtime: getFileMtime(ruleInfo.path),
    module: ruleInfo.module  // ★ 用于网络恢复时调整间隔
  });
  
  // 4. 重置错误统计和自愈状态（新规则重新开始）
  resetErrorStats(filename);
  selfHealState.delete(filename);
  
  // 5. 启动新定时器
  logRuleEvent(newName, 'RULE_RELOADED', { 
    oldName: oldName,
    newName: newName,
    file: filename,
    interval: `${ruleInfo.module.interval / 1000}s`
  });
  console.log(`[🔧警报引擎] 热重载规则: "${oldName}" → "${newName}" (${filename})`);
  
  // 立即执行一次检查
  runRule(ruleInfo).then(result => {
    if (result === 'stop') {
      unloadRule(filename, newName, 'lifetime_ended');
    } else if (result === 'pause') {
      unloadRule(filename, newName, 'error_threshold_reached');
    }
  });
  
  // 启动定时器
  const timer = setInterval(async () => {
    const result = await runRule(ruleInfo);
    if (result === 'stop') {
      unloadRule(filename, newName, 'lifetime_ended');
    } else if (result === 'pause') {
      unloadRule(filename, newName, 'error_threshold_reached');
    }
  }, ruleInfo.module.interval);
  
  timers.set(filename, timer);
}

/**
 * 扫描检查：
 * 1. 发现规则文件被移走时自动卸载
 * 2. 发现新增规则文件时自动加载
 * 3. 发现规则文件被修改时自动重新加载
 */
function scanRuleFiles() {
  // 1. 检测移除的规则
  for (const [filename, info] of activeRules) {
    const filePath = info.path;
    
    if (!fs.existsSync(filePath)) {
      // 规则文件不存在了（被归档或删除）
      logEngine('INFO', info.name, '检测到规则文件已不存在', { path: filePath });
      unloadRule(filename, info.name, 'file_removed');
      continue;
    }
    
    // ⭐ 2. 检测文件修改（mtime 变化）
    const currentMtime = getFileMtime(filePath);
    if (currentMtime !== null && info.mtime !== currentMtime) {
      logEngine('INFO', info.name, '检测到规则文件已修改', { 
        file: filename,
        oldMtime: info.mtime,
        newMtime: currentMtime
      });
      reloadRule(filename, info);
    }
  }
  
  // 3. 检测新增的规则
  if (!fs.existsSync(RULES_DIR)) {
    return;
  }
  
  const currentFiles = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.js'));
  
  for (const file of currentFiles) {
    if (!activeRules.has(file)) {
      // 新文件，加载并启动
      const ruleInfo = loadSingleRule(file);
      if (ruleInfo) {
        startRuleTimer(ruleInfo);
        logEngine('INFO', 'Engine', '热加载新规则', { file, name: ruleInfo.module.name });
        console.log(`[🔧警报引擎] 热加载新规则: ${ruleInfo.module.name}`);
      }
    }
  }
}

/**
 * 启动规则的定时器
 */
const STAGGER_DELAY_MS = 500; // 每条规则启动延迟（毫秒）

function startRuleTimer(ruleInfo, staggerIndex = 0) {
  const { filename, path: rulePath, module: rule } = ruleInfo;
  
  // 如果已有定时器，先停止
  if (timers.has(filename)) {
    clearInterval(timers.get(filename));
  }
  
  // 初始化错误统计
  resetErrorStats(filename);
  
  // ⭐ 获取文件修改时间
  const mtime = getFileMtime(rulePath);
  
  // 记录规则信息（用于扫描检查，包含 mtime 和 module）
  activeRules.set(filename, {
    name: rule.name,
    path: rulePath,
    filename: filename,
    mtime: mtime,
    module: rule  // ★ 用于网络恢复时调整间隔
  });
  
  // 记录启动
  logRuleEvent(rule.name, 'TIMER_STARTED', {
    interval: `${rule.interval / 1000}s`,
    file: filename,
    mtime: mtime
  });
  
  const staggerMs = staggerIndex * STAGGER_DELAY_MS;
  console.log(`[🔧警报引擎] 启动规则定时器 "${rule.name}" (检查间隔: ${rule.interval / 1000}s, 打散延迟: ${staggerMs}ms)`);
  
  // 首次执行带打散延迟
  if (staggerMs > 0) {
    const firstTimer = setTimeout(() => {
      runRule(ruleInfo).then(result => {
        if (result === 'stop') {
          unloadRule(filename, rule.name, 'lifetime_ended');
        } else if (result === 'pause') {
          unloadRule(filename, rule.name, 'error_threshold_reached');
        }
      });
    }, staggerMs);
    // 存储首次执行定时器，用于清理
    if (!rule._firstTimers) rule._firstTimers = [];
    rule._firstTimers.push(firstTimer);
  } else {
    // 第一条规则立即执行
    runRule(ruleInfo).then(result => {
      if (result === 'stop') {
        unloadRule(filename, rule.name, 'lifetime_ended');
      } else if (result === 'pause') {
        unloadRule(filename, rule.name, 'error_threshold_reached');
      }
    });
  }
  
  // 启动定时器
  const timer = setInterval(async () => {
    const result = await runRule(ruleInfo);
    if (result === 'stop') {
      unloadRule(filename, rule.name, 'lifetime_ended');
    } else if (result === 'pause') {
      unloadRule(filename, rule.name, 'error_threshold_reached');
    }
  }, rule.interval);
  
  timers.set(filename, timer);
}

/**
 * 停止所有定时器
 */
function stopAllTimers() {
  for (const [filename, timer] of timers) {
    clearInterval(timer);
    console.log(`[🔧警报引擎] 已停止定时器 ${filename}`);
  }
  timers.clear();
  activeRules.clear();
}

/**
 * 主入口
 */
async function main() {
  // 记录引擎启动
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  
  logEngine('INFO', 'Engine', '引擎启动', { 
    rulesDir: RULES_DIR,
    archiveDir: ARCHIVE_DIR
  });
  
  console.log('[🔧警报引擎] 启动中...');
  console.log(`[🔧警报引擎] 规则目录: ${RULES_DIR}`);
  console.log(`[🔧警报引擎] 归档目录: ${ARCHIVE_DIR}`);
  
  // 加载运行时状态（从 rules-state.json 恢复）
  loadRuleState();
  
  // 初始加载规则
  const rules = loadRules();
  
  // 为每个规则启动定时器（带打散延迟：第N条规则延迟 N×500ms）
  for (let i = 0; i < rules.length; i++) {
    startRuleTimer(rules[i], i);
  }

  logEngine('INFO', 'Engine', '规则加载完成', { count: timers.size });
  console.log(`[🔧警报引擎] 已启动 ${timers.size} 个规则`);
  
  // 启动规则文件扫描定时器（每1分钟检查一次）
  const scanTimer = setInterval(scanRuleFiles, SCAN_INTERVAL);
  console.log(`[🔧警报引擎] 已启动文件扫描器 (检查间隔: ${SCAN_INTERVAL / 1000}s)`);
  
  // 启动网络事件缓冲池汇总定时器（每4小时发送一次报告）
  scheduleNetworkSummary();
  console.log(`[🔧警报引擎] 已启动网络缓冲汇总 (周期: 4小时)`);
  
  // 监听进程信号
  process.on('SIGINT', () => {
    logEngine('INFO', 'Engine', '引擎关闭 (SIGINT)');
    console.log('\n[🔧警报引擎] 正在关闭...');
    flushNetworkSummary(); // 关闭前发送缓冲中的网络事件
    stopAllTimers();
    clearInterval(scanTimer);
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    logEngine('INFO', 'Engine', '引擎关闭 (SIGTERM)');
    console.log('\n[🔧警报引擎] 正在关闭...');
    flushNetworkSummary(); // 关闭前发送缓冲中的网络事件
    stopAllTimers();
    clearInterval(scanTimer);
    process.exit(0);
  });
  
  // 保持进程运行
  process.stdin.resume();
}

// 启动
main().catch(error => {
  logEngine('ERROR', 'Engine', '引擎致命错误', { error: error.message });
  console.error('[🔧警报引擎] 致命错误:', error);
  process.exit(1);
});