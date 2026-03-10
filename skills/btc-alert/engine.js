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
const ENGINE_LOG = path.join(LOGS_DIR, 'alert-engine.log');

// 扫描间隔：检查规则文件是否存在
const SCAN_INTERVAL = 60 * 1000; // 1分钟

// 存储每个规则的定时器
const timers = new Map();

// 存储正在运行的规则信息（用于扫描检查）
const activeRules = new Map();

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
 * 写入引擎日志
 */
function logEngine(level, ruleName, message, data = null) {
  const logLine = `[${timestamp()}] [${level}] [${ruleName}] ${message}${data ? '\n  ' + JSON.stringify(data) : ''}\n`;
  
  // 确保日志目录存在
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  
  // 追加到日志文件
  fs.appendFileSync(ENGINE_LOG, logLine);
  
  // 同时输出到控制台
  const consoleMsg = `[Alert Engine] [${ruleName}] ${message}`;
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
    console.log(`[Alert Engine] Archived rule "${ruleName}" to ${archivePath}`);
    return true;
  } catch (error) {
    logEngine('ERROR', ruleName, '归档失败', { error: error.message });
    return false;
  }
}

/**
 * 加载所有规则
 */
function loadRules() {
  const rules = [];
  
  if (!fs.existsSync(RULES_DIR)) {
    console.log('[Alert Engine] Rules directory does not exist, creating...');
    fs.mkdirSync(RULES_DIR, { recursive: true });
    return rules;
  }
  
  const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.js'));
  
  for (const file of files) {
    try {
      const rulePath = path.join(RULES_DIR, file);
      // 清除缓存以获取最新版本
      delete require.cache[require.resolve(rulePath)];
      
      const rule = require(rulePath);
      
      // 验证必需字段
      if (!rule.name || !rule.interval || !rule.check || !rule.collect || !rule.trigger || !rule.lifetime) {
        console.warn(`[Alert Engine] Rule ${file} missing required fields, skipping`);
        logEngine('WARN', 'Engine', `规则缺少必需字段: ${file}`);
        continue;
      }
      
      rules.push({
        filename: file,
        path: rulePath,
        module: rule
      });
      
      console.log(`[Alert Engine] Loaded rule: ${rule.name} (interval: ${rule.interval}ms)`);
    } catch (error) {
      console.error(`[Alert Engine] Failed to load rule ${file}:`, error.message);
      logEngine('ERROR', 'Engine', `加载规则失败: ${file}`, { error: error.message });
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
    
    // 记录检测开始
    logRuleEvent(name, 'CHECK_START');
    
    // 执行检测
    const shouldTrigger = await check();
    
    if (shouldTrigger) {
      logRuleEvent(name, 'TRIGGERED');
      
      // 收集数据
      const data = await collect();
      logRuleEvent(name, 'DATA_COLLECTED', { dataKeys: Object.keys(data || {}) });
      
      // 触发动作
      await trigger(data);
      
      logRuleEvent(name, 'TRIGGER_COMPLETED');
    } else {
      logRuleEvent(name, 'CHECK_PASSED');
    }
    
    return 'continue';
  } catch (error) {
    logEngine('ERROR', name, '执行错误', { error: error.message, stack: error.stack });
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
  
  logRuleEvent(ruleName, 'RULE_UNLOADED', { reason });
  console.log(`[Alert Engine] Unloaded rule "${ruleName}" (${reason})`);
}

/**
 * 扫描检查：发现规则文件被移走时自动卸载
 */
function scanRuleFiles() {
  for (const [filename, info] of activeRules) {
    const filePath = info.path;
    
    if (!fs.existsSync(filePath)) {
      // 规则文件不存在了（被手动归档或删除）
      logEngine('INFO', info.name, '检测到规则文件已不存在', { path: filePath });
      unloadRule(filename, info.name, 'file_removed');
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
  
  // 记录规则信息（用于扫描检查）
  activeRules.set(filename, {
    name: rule.name,
    path: rulePath,
    filename: filename
  });
  
  // 记录启动
  logRuleEvent(rule.name, 'TIMER_STARTED', {
    interval: `${rule.interval / 1000}s`,
    file: filename
  });
  
  console.log(`[Alert Engine] Starting timer for rule "${rule.name}" (interval: ${rule.interval}ms)`);
  
  // 立即执行一次
  runRule(ruleInfo).then(result => {
    if (result === 'stop') {
      unloadRule(filename, rule.name, 'lifetime_ended');
    }
  });
  
  // 启动定时器
  const timer = setInterval(async () => {
    const result = await runRule(ruleInfo);
    if (result === 'stop') {
      unloadRule(filename, rule.name, 'lifetime_ended');
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
    console.log(`[Alert Engine] Stopped timer for ${filename}`);
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
    archiveDir: ARCHIVE_DIR,
    logFile: ENGINE_LOG 
  });
  
  console.log('[Alert Engine] Starting...');
  console.log(`[Alert Engine] Rules directory: ${RULES_DIR}`);
  console.log(`[Alert Engine] Archive directory: ${ARCHIVE_DIR}`);
  console.log(`[Alert Engine] Log file: ${ENGINE_LOG}`);
  
  // 初始加载规则
  const rules = loadRules();
  
  // 为每个规则启动定时器
  for (const rule of rules) {
    startRuleTimer(rule);
  }

  logEngine('INFO', 'Engine', '规则加载完成', { count: timers.size });
  console.log(`[Alert Engine] Started ${timers.size} rule(s)`);
  
  // 启动规则文件扫描定时器（每1分钟检查一次）
  const scanTimer = setInterval(scanRuleFiles, SCAN_INTERVAL);
  console.log(`[Alert Engine] Started file scanner (interval: ${SCAN_INTERVAL / 1000}s)`);
  
  // 监听进程信号
  process.on('SIGINT', () => {
    logEngine('INFO', 'Engine', '引擎关闭 (SIGINT)');
    console.log('\n[Alert Engine] Shutting down...');
    stopAllTimers();
    clearInterval(scanTimer);
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    logEngine('INFO', 'Engine', '引擎关闭 (SIGTERM)');
    console.log('\n[Alert Engine] Shutting down...');
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
  console.error('[Alert Engine] Fatal error:', error);
  process.exit(1);
});