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

const RULES_DIR = path.join(__dirname, 'rules');
const ARCHIVE_DIR = path.join(__dirname, 'rules-archive');
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

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

// 存储每个规则的触发冷却时间
// 结构: { cooldownUntil: timestamp, lastTriggerTime: timestamp }
const triggerCooldowns = new Map();

// 默认冷却时间：30分钟（毫秒）
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

// ========== 日志系统 ==========

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
 */
function logEngine(level, ruleName, message, data = null) {
  const prefix = level === 'ERROR' ? '[❌警报引擎错误]' : '[🔧警报引擎]';
  const consoleMsg = `${prefix} [${ruleName}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}`;
  
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
  logEngine('INFO', ruleName, event, details);
}

// ========== 错误监控与通知 ==========

/**
 * 通知十四月（通过QQ告知主人）
 */
function notifyShisiyue(message) {
  const { spawn } = require('child_process');
  
  const spawnMessage = `请通过QQ告诉主人这条消息：

${message}`;

  spawn('openclaw', [
    'agent',
    '--agent', 'shisiyue',
    '--message', spawnMessage
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  console.log(`[🔧警报引擎] 已发送通知给十四月`);
}

/**
 * 获取或初始化规则的错误统计
 */
function getErrorStats(filename) {
  if (!ruleErrorStats.has(filename)) {
    ruleErrorStats.set(filename, {
      consecutiveErrors: 0,
      threshold5HitCount: 0,
      threshold5FirstTime: null
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
    threshold5FirstTime: null
  });
}

/**
 * 处理规则执行错误
 * @returns {boolean} true 表示应该暂停规则
 */
function handleRuleError(filename, ruleName, errorMessage) {
  const stats = getErrorStats(filename);
  const now = Date.now();
  
  // 检查4小时窗口是否过期
  if (stats.threshold5HitCount > 0 && stats.threshold5FirstTime) {
    if (now - stats.threshold5FirstTime > THRESHOLD_WINDOW_MS) {
      // 超过4小时，重置计数
      stats.threshold5HitCount = 0;
      stats.threshold5FirstTime = null;
      logRuleEvent(ruleName, '错误计数窗口过期，重置');
    }
  }
  
  // 增加连续错误计数
  stats.consecutiveErrors++;
  
  logEngine('WARN', ruleName, `规则执行失败`, { 
    error: errorMessage,
    consecutiveErrors: stats.consecutiveErrors 
  });
  
  // 达到5次阈值
  if (stats.consecutiveErrors === 5) {
    // 首次达到5次，记录时间
    if (stats.threshold5FirstTime === null) {
      stats.threshold5FirstTime = now;
    }
    
    stats.threshold5HitCount++;
    
    // 通知十四月
    const notifyMsg = `主人～警报器规则连续失败5次！

规则: ${ruleName}
错误: ${errorMessage}
累计触发阈值: ${stats.threshold5HitCount}/3

继续运行中，若反复出现可能会暂停哦～`;
    
    notifyShisiyue(notifyMsg);
    logRuleEvent(ruleName, '达到5次错误阈值', { threshold5HitCount: stats.threshold5HitCount });
    
    // 累计3次触发5次阈值
    if (stats.threshold5HitCount >= 3) {
      const pauseMsg = `主人～警报器规则已暂停！

规则: ${ruleName}
原因: 累计触发阈值3次（4小时内反复出现5次连续失败）
错误: ${errorMessage}

请检查后手动重启～`;
      
      notifyShisiyue(pauseMsg);
      logRuleEvent(ruleName, 'RULE_PAUSED', { reason: '累计触发阈值3次' });
      return true; // 暂停
    }
  }
  
  // 达到10次阈值
  if (stats.consecutiveErrors === 10) {
    const pauseMsg = `主人～警报器规则已暂停！

规则: ${ruleName}
原因: 连续失败10次
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
  
  if (stats.consecutiveErrors > 0 || stats.threshold5HitCount > 0) {
    logRuleEvent(ruleName, '规则恢复正常', { 
      previousConsecutiveErrors: stats.consecutiveErrors,
      previousThreshold5HitCount: stats.threshold5HitCount 
    });
  }
  
  // 成功一次，完全重置
  resetErrorStats(filename);
}

// ========== 规则管理 ==========

/**
 * 归档规则文件
 */
function archiveRule(filename, ruleName, reason) {
  // 确保归档目录存在
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  
  const sourcePath = path.join(RULES_DIR, filename);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const archiveName = `${timestamp}_${filename}`;
  const archivePath = path.join(ARCHIVE_DIR, archiveName);
  
  try {
    // 移动文件到归档目录
    fs.renameSync(sourcePath, archivePath);
    logRuleEvent(ruleName, 'RULE_ARCHIVED', { 
      archivePath: archivePath,
      reason: reason 
    });
    console.log(`[🔧警报引擎] 已归档规则 "${ruleName}" 到 ${archivePath}`);
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
    const status = lifetime();
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
    
    // 检查冷却期
    const cooldownInfo = triggerCooldowns.get(filename);
    if (cooldownInfo && cooldownInfo.cooldownUntil) {
      const now = Date.now();
      if (now < cooldownInfo.cooldownUntil) {
        const remainingMs = cooldownInfo.cooldownUntil - now;
        const remainingMin = Math.ceil(remainingMs / 60000);
        logRuleEvent(name, 'COOLDOWN_ACTIVE', { 
          remainingMinutes: remainingMin,
          lastTriggerTime: cooldownInfo.lastTriggerTime 
        });
        return 'continue'; // 在冷却期内，跳过检测
      }
    }
    
    // 记录检测开始
    logRuleEvent(name, 'CHECK_START');
    
    // 执行检测（使用 .call(rule) 保持 this 绑定）
    const shouldTrigger = await check.call(rule);
    
    // 检测成功，重置错误统计
    handleRuleSuccess(filename, name);
    
    if (shouldTrigger) {
      logRuleEvent(name, 'TRIGGERED');
      
      // 收集数据
      const data = await collect.call(rule);
      logRuleEvent(name, 'DATA_COLLECTED', { dataKeys: Object.keys(data || {}) });
      
      // 触发动作
      await trigger.call(rule, data);
      
      logRuleEvent(name, 'TRIGGER_COMPLETED');
      
      // 设置冷却时间（30分钟内不再触发）
      const cooldownMs = rule.cooldownMs || DEFAULT_COOLDOWN_MS;
      triggerCooldowns.set(filename, {
        cooldownUntil: Date.now() + cooldownMs,
        lastTriggerTime: Date.now()
      });
      logRuleEvent(name, 'COOLDOWN_SET', { cooldownMinutes: cooldownMs / 60000 });
    } else {
      logRuleEvent(name, 'CHECK_PASSED');
    }
    
    return 'continue';
  } catch (error) {
    // 处理错误，决定是否暂停
    const shouldPause = handleRuleError(filename, name, error.message);
    
    if (shouldPause) {
      return 'pause'; // 新增暂停状态
    }
    
    return 'continue';
  }
}

/**
 * 卸载规则（停止定时器并清理）
 */
function unloadRule(filename, ruleName, reason) {
  if (timers.has(filename)) {
    clearInterval(timers.get(filename));
    timers.delete(filename);
  }
  activeRules.delete(filename);
  triggerCooldowns.delete(filename); // 清理冷却信息
  
  // 保留错误统计以便查看，但也可以选择清理
  // ruleErrorStats.delete(filename);
  
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
  
  // 3. 更新 activeRules（包含新的 mtime）
  activeRules.set(filename, {
    name: newName,
    path: ruleInfo.path,
    filename: filename,
    mtime: getFileMtime(ruleInfo.path)
  });
  
  // 4. 重置错误统计（新规则重新开始）
  resetErrorStats(filename);
  
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
      // 规则文件不存在了（被手动归档或删除）
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
function startRuleTimer(ruleInfo) {
  const { filename, path: rulePath, module: rule } = ruleInfo;
  
  // 如果已有定时器，先停止
  if (timers.has(filename)) {
    clearInterval(timers.get(filename));
  }
  
  // 初始化错误统计
  resetErrorStats(filename);
  
  // ⭐ 获取文件修改时间
  const mtime = getFileMtime(rulePath);
  
  // 记录规则信息（用于扫描检查，包含 mtime）
  activeRules.set(filename, {
    name: rule.name,
    path: rulePath,
    filename: filename,
    mtime: mtime  // ⭐ 新增：记录文件修改时间
  });
  
  // 记录启动
  logRuleEvent(rule.name, 'TIMER_STARTED', {
    interval: `${rule.interval / 1000}s`,
    file: filename,
    mtime: mtime
  });
  
  console.log(`[🔧警报引擎] 启动规则定时器 "${rule.name}" (检查间隔: ${rule.interval}ms)`);
  
  // 立即执行一次
  runRule(ruleInfo).then(result => {
    if (result === 'stop') {
      unloadRule(filename, rule.name, 'lifetime_ended');
    } else if (result === 'pause') {
      unloadRule(filename, rule.name, 'error_threshold_reached');
    }
  });
  
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
  
  // 初始加载规则
  const rules = loadRules();
  
  // 为每个规则启动定时器
  for (const rule of rules) {
    startRuleTimer(rule);
  }

  logEngine('INFO', 'Engine', '规则加载完成', { count: timers.size });
  console.log(`[🔧警报引擎] 已启动 ${timers.size} 个规则`);
  
  // 启动规则文件扫描定时器（每1分钟检查一次）
  const scanTimer = setInterval(scanRuleFiles, SCAN_INTERVAL);
  console.log(`[🔧警报引擎] 已启动文件扫描器 (检查间隔: ${SCAN_INTERVAL / 1000}s)`);
  
  // 监听进程信号
  process.on('SIGINT', () => {
    logEngine('INFO', 'Engine', '引擎关闭 (SIGINT)');
    console.log('\n[🔧警报引擎] 正在关闭...');
    stopAllTimers();
    clearInterval(scanTimer);
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    logEngine('INFO', 'Engine', '引擎关闭 (SIGTERM)');
    console.log('\n[🔧警报引擎] 正在关闭...');
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