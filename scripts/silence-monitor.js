#!/usr/bin/env node
/**
 * silence-monitor.js — 警报静默监控器
 *
 * PM2 常驻进程，每 30 分钟扫描一次活跃山寨币周期，
 * 检测警报静默时长超过阈值的周期，自动发起即时分析。
 *
 * 阈值:
 *   - 有持仓周期: 12h
 *   - 无持仓周期: 8h
 *
 * 去重: 同一周期 6h 内不重复触发
 *
 * 依赖:
 *   - scripts/stage1-instant.js  即时分析阶段一
 *   - skills/btc-alert/rules/     警报规则目录
 *   - active/alt-*                活跃山寨币周期
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════
const WORKSPACE = path.resolve(__dirname, '..');
const ACTIVE_DIR = path.join(WORKSPACE, 'active');
const RULES_DIR = path.join(WORKSPACE, 'skills', 'btc-alert', 'rules');
const STATE_FILE = path.join(WORKSPACE, 'data', 'silence-monitor-state.json');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'silence-monitor.log');
const STAGE1_SCRIPT = path.join(WORKSPACE, 'scripts', 'stage1-instant.js');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;   // 检查间隔: 30 分钟
const DEDUP_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 去重冷却: 6 小时
const SILENCE_THRESHOLD_POSITION_H = 12;      // 有持仓阈值: 12h
const SILENCE_THRESHOLD_NO_POSITION_H = 8;    // 无持仓阈值: 8h
const STAGGER_DELAY_MS = 30 * 1000;           // 周期间错开: 30s
// stage1-instant.js 合约数据获取: 单次 120s × 2次尝试 + 30s延迟 = ~270s，留足余量
const STAGE1_TIMEOUT_MS = 360 * 1000;          // stage1 超时: 360s

// ════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════

function ts() {
  return new Date(Date.now() + 8 * 3600000)
    .toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level) {
  const prefix = level ? `[${level}]` : '';
  const line = `[${ts()}] ${prefix} ${msg}`;
  console.error(line);
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* 日志写入失败不阻塞 */ }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    log(`状态文件损坏，将重新创建`, 'WARN');
  }
  return {};
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log(`状态文件写入失败: ${e.message}`, 'ERROR');
  }
}

/**
 * 从周期目录名提取币种符号
 * alt-2Z-20260525-2030 → 2Z
 * zhuang-2Z-20260525-2030 → 2Z
 */
function extractCoin(cycleDirName) {
  const parts = cycleDirName.split('-');
  // {profile}-{COIN}-YYYYMMDD-HHMM
  // COIN 可能含连字符（如 JELLYJELLY 不会，但以防万一）
  // 实际格式: {profile}-{COIN}-{8位日期}-{4位时间}
  // 取 parts[1]
  return parts[1] || null;
}

/**
 * 获取周期的最后报告时间 (Unix ms)
 * 返回 null 表示无报告
 */
function getLastReportTime(cycleDir) {
  const reportsDir = path.join(cycleDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;

  let latest = 0;
  try {
    const files = fs.readdirSync(reportsDir);
    for (const f of files) {
      const fp = path.join(reportsDir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    }
  } catch (e) {
    return null;
  }
  return latest > 0 ? latest : null;
}

/**
 * 获取周期持仓数
 */
function getPositionCount(cycleDir) {
  const posFile = path.join(cycleDir, 'positions.json');
  if (!fs.existsSync(posFile)) return 0;

  try {
    const data = JSON.parse(fs.readFileSync(posFile, 'utf8'));
    // 字段名是中文「当前持仓」
    const positions = data['当前持仓'] || data['positions'] || [];
    const count = data['汇总']?.['当前持仓数'] || positions.length || 0;
    return count;
  } catch (e) {
    return 0;
  }
}

/**
 * 检查周期是否有活跃警报规则
 */
function hasActiveRules(coin) {
  if (!fs.existsSync(RULES_DIR)) return false;

  try {
    const files = fs.readdirSync(RULES_DIR);
    // 匹配 {COIN}-*.js 或 {COIN}_*.js（排除 BTC 复合规则）
    const prefix = coin.toUpperCase();
    return files.some(f => {
      if (!f.endsWith('.js')) return false;
      // 精确匹配: 文件名以 "{COIN}-" 开头
      const upper = f.toUpperCase();
      return upper.startsWith(prefix + '-') || upper.startsWith(prefix + '_');
    });
  } catch (e) {
    return false;
  }
}

/**
 * 检查是否在去重冷却期内
 */
function isInCooldown(state, cycleId) {
  const entry = state[cycleId];
  if (!entry || !entry.lastTriggeredAt) return false;
  const elapsed = Date.now() - new Date(entry.lastTriggeredAt).getTime();
  return elapsed < DEDUP_COOLDOWN_MS;
}

/**
 * 休眠
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════

async function runCheck() {
  const startTime = Date.now();
  log('══════════ 静默检查开始 ══════════');

  // 加载去重状态
  const state = loadState();
  let totalCycles = 0;
  let silentCycles = 0;
  let triggeredCycles = 0;
  let skippedCycles = 0;

  // 扫描活跃山寨币周期
  if (!fs.existsSync(ACTIVE_DIR)) {
    log('active/ 目录不存在，跳过检查', 'WARN');
    return;
  }

  let cycleDirs;
  try {
    cycleDirs = fs.readdirSync(ACTIVE_DIR)
      .filter(d => d.startsWith('alt-') || d.startsWith('zhuang-'))
      .sort();
  } catch (e) {
    log(`扫描 active/ 失败: ${e.message}`, 'ERROR');
    return;
  }

  totalCycles = cycleDirs.length;
  const altCount = cycleDirs.filter(d => d.startsWith('alt-')).length;
  const zhuangCount = cycleDirs.filter(d => d.startsWith('zhuang-')).length;
  log(`发现 ${totalCycles} 个活跃周期（山寨 ${altCount} | 庄币 ${zhuangCount}）`);

  // 收集静默周期
  const silentList = [];

  for (const dirName of cycleDirs) {
    const cycleDir = path.join(ACTIVE_DIR, dirName);
    const coin = extractCoin(dirName);

    if (!coin) {
      log(`无法提取币种: ${dirName}`, 'WARN');
      continue;
    }

    // 检查是否有活跃规则
    const hasRules = hasActiveRules(coin);
    if (!hasRules) {
      // 无活跃规则的不在检测范围内（cycle-health-check 会处理）
      continue;
    }

    // 获取最后报告时间
    const lastReportMs = getLastReportTime(cycleDir);
    let silenceHours;

    if (lastReportMs === null) {
      // 无报告 → 用周期目录的修改时间作为参考
      try {
        const dirStat = fs.statSync(cycleDir);
        silenceHours = (Date.now() - dirStat.mtimeMs) / (3600 * 1000);
      } catch (e) {
        silenceHours = Infinity;
      }
    } else {
      silenceHours = (Date.now() - lastReportMs) / (3600 * 1000);
    }

    // 获取持仓数，决定阈值
    const posCount = getPositionCount(cycleDir);
    const threshold = posCount > 0
      ? SILENCE_THRESHOLD_POSITION_H
      : SILENCE_THRESHOLD_NO_POSITION_H;

    if (silenceHours < threshold) {
      continue; // 未超阈值，跳过
    }

    // 去重检查
    if (isInCooldown(state, dirName)) {
      const lastTrigger = state[dirName].lastTriggeredAt;
      const sinceLastTrigger = ((Date.now() - new Date(lastTrigger).getTime()) / (3600 * 1000)).toFixed(1);
      log(`  ${dirName} (${coin}) 静默 ${silenceHours.toFixed(1)}h — 跳过（距上次触发 ${sinceLastTrigger}h，冷却中）`);
      skippedCycles++;
      continue;
    }

    silentList.push({
      dirName,
      coin,
      cycleDir,
      silenceHours,
      posCount,
      threshold,
      hasRules,
    });
  }

  silentCycles = silentList.length;
  log(`静默周期: ${silentCycles} 个（跳过冷却: ${skippedCycles} 个）`);

  // 逐周期触发即时分析（错开避免并发冲击）
  for (const item of silentList) {
    const { dirName, coin, cycleDir, silenceHours, posCount, threshold } = item;

    log(`触发静默检查: ${dirName} (${coin}) | 静默 ${silenceHours.toFixed(1)}h | 持仓 ${posCount} | 阈值 ${threshold}h`);

    // 构造合成警报
    const alertData = {
      coin: coin,
      alertName: 'silence-check',
      alertType: 'silence',
      triggerPrice: null,
      currentPrice: null,
      silenceHours: Math.round(silenceHours * 10) / 10,
      reason: `警报静默超过${threshold}小时（实际${silenceHours.toFixed(1)}h），持仓${posCount}个，存在活跃规则但长期未触发，自动发起重评估`,
    };

    const alertJson = JSON.stringify(alertData);

    const cmd = `node "${STAGE1_SCRIPT}" '${alertJson.replace(/'/g, "'\\''")}'`;
      let output = '';
      let stage1Ok = false;
      let stage1TimedOut = false;

      try {
        output = execSync(cmd, {
          encoding: 'utf8',
          timeout: STAGE1_TIMEOUT_MS,
          cwd: WORKSPACE,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, REQUIRE_CONTRACT: '1' },
        });
      } catch (e) {
        // execSync 抛异常：可能是超时，也可能是 REQUIRE_CONTRACT 模式下的主动退出
        output = (e.stdout || '') + '\n' + (e.stderr || '');
        if (e.message && e.message.includes('ETIMEDOUT')) {
          stage1TimedOut = true;
        }
      }

      // 检查 stage1 输出
      // 静默检查强制要求合约数据成功（REQUIRE_CONTRACT=1 时失败会 exit(1)）
      const lines = output.trim().split('\n');
      for (const line of lines.reverse()) {
        if (line.startsWith('{') && line.includes('"status"')) {
          try {
            const result = JSON.parse(line);
            if (result.status === 'success' && result.contract_ok) {
              stage1Ok = true;
              log(`  ✅ ${coin} 阶段一完成 | 合约=OK | 报告=${result.report_count || 0}篇`);
            } else if (result.status === 'success' && !result.contract_ok) {
              log(`  ⚠️ ${coin} 阶段一完成但合约数据失败，不派发阶段二`, 'WARN');
            }
          } catch (_) {}
          break;
        }
      }

      if (stage1Ok) {
        state[dirName] = {
          coin,
          lastTriggeredAt: new Date().toISOString(),
          silenceHours: Math.round(silenceHours * 10) / 10,
          posCount,
        };
        triggeredCycles++;
      } else {
        const reason = stage1TimedOut ? 'stage1超时且无法确认完成' : 'stage1执行失败';
        log(`  ❌ ${coin} ${reason}，未更新去重状态`, 'ERROR');
      }

    // 保存状态（每触发一个就保存，防止中途崩溃丢状态）
    saveState(state);

    // 错开下一个周期的触发
    if (silentList.indexOf(item) < silentList.length - 1) {
      await sleep(STAGGER_DELAY_MS);
    }
  }

  // 清理过期状态记录（30 天前的记录）
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let cleanedCount = 0;
  for (const [key, entry] of Object.entries(state)) {
    if (entry.lastTriggeredAt && new Date(entry.lastTriggeredAt).getTime() < cutoff) {
      delete state[key];
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    saveState(state);
    log(`清理过期状态记录: ${cleanedCount} 条`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`══════════ 静默检查完成 | 扫描 ${totalCycles} | 静默 ${silentCycles} | 触发 ${triggeredCycles} | 跳过 ${skippedCycles} | 耗时 ${elapsed}s ══════════`);
}

// ════════════════════════════════════════════
// 入口
// ════════════════════════════════════════════

async function main() {
  log('🚀 警报静默监控器启动');
  log(`配置: 有持仓阈值=${SILENCE_THRESHOLD_POSITION_H}h | 无持仓阈值=${SILENCE_THRESHOLD_NO_POSITION_H}h | 检查间隔=${CHECK_INTERVAL_MS / 60000}min | 去重冷却=${DEDUP_COOLDOWN_MS / 3600000}h`);

  // 确保日志目录存在
  const logsDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  // 确保 data 目录存在
  const dataDir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // 启动后立即执行一次检查
  await runCheck();

  // 定时循环
  setInterval(async () => {
    try {
      await runCheck();
    } catch (e) {
      log(`定时检查异常: ${e.message}`, 'ERROR');
    }
  }, CHECK_INTERVAL_MS);
}

main().catch(e => {
  log(`启动失败: ${e.message}\n${e.stack}`, 'ERROR');
  process.exit(1);
});
