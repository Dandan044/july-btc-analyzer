#!/usr/bin/env node
/**
 * stage4-executor.js — 阶段四：警报规则执行（全脚本化）
 *
 * 用法: node stage4-executor.js <COIN> <CYCLE_DIR> <DECISION_JSON>
 *   或: node stage4-executor.js <COIN> <CYCLE_DIR>
 *       （自动查找最新的 stage4-decision-*.json）
 *
 * 输入: reports/alert-candidates-{COIN}-*.json（阶段二输出）
 *
 * 功能:
 *   1. 读取决策 JSON
 *   2. 归档失效规则（archive-rules.js）
 *   3. 按模板生成新规则文件
 *   4. 记录日志
 *
 * 输出: JSON 到 stdout（最后一行 __STAGE4_EXEC_OUTPUT__）
 * 日志: 追加到 logs/alt-{COIN}-process.log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const COIN = process.argv[2];
let CYCLE_DIR = process.argv[3];
const DECISION_FILE_ARG = process.argv[4] || null;

if (!COIN || !CYCLE_DIR) {
  console.error('用法: node stage4-executor.js <COIN> <CYCLE_DIR> [DECISION_JSON]');
  process.exit(1);
}

// 容错：去除可能的 active/ 前缀
CYCLE_DIR = CYCLE_DIR.replace(/^active\//, '');

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', `alt-${COIN}-process.log`);
const RULES_DIR = path.join(WORKSPACE, 'skills', 'btc-alert', 'rules');
const ARCHIVE_SCRIPT = path.join(WORKSPACE, 'scripts', 'archive-rules.js');

// ─── 工具函数 ───
function nowTs() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level = 'INFO') {
  const ts = nowTs();
  let line;
  if (level === 'WARN') line = `[${ts}] [阶段四] ⚠️ WARN: ${msg}`;
  else if (level === 'ERROR') line = `[${ts}] [阶段四] ⛔ ERROR: ${msg}`;
  else line = `[${ts}] [阶段四] ${msg}`;
  console.error(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function output(data) {
  console.log('__STAGE4_EXEC_OUTPUT__');
  console.log(JSON.stringify(data));
}

function nowISO() {
  return new Date(Date.now() + 8 * 3600000).toISOString();
}

// ════════════════════════════════════════════
// 步骤 1: 记录阶段开始
// ════════════════════════════════════════════
log('开始执行 - 警报规则操作');

// ════════════════════════════════════════════
// 步骤 2: 定位决策 JSON
// ════════════════════════════════════════════
let decisionFile = DECISION_FILE_ARG;
let decision;

if (!decisionFile) {
  // 自动查找
  const reportsDir = path.join(WORKSPACE, 'active', CYCLE_DIR, 'reports');
  try {
    const files = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith(`alert-candidates-${COIN}-`) && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) {
      log('⛔ ERROR: 未找到 alert-candidates JSON', 'ERROR');
      output({ status: 'error', reason: 'no alert-candidates json' });
      process.exit(1);
    }
    decisionFile = path.join(reportsDir, files[0].name);
  } catch (err) {
    log(`决策文件定位失败: err.message`, 'ERROR');
    output({ status: 'error', reason: e.message });
    process.exit(1);
  }
}

try {
  decision = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  log(`决策文件读取: ${path.basename(decisionFile)}`);
} catch (err) {
  log(`决策文件解析失败: err.message`, 'ERROR');
  output({ status: 'error', reason: 'decision parse error' });
  process.exit(1);
}

// ════════════════════════════════════════════
// 步骤 3: 归档失效规则
// ════════════════════════════════════════════
const archiveRules = decision.archive_rules || [];
let archivedCount = 0;
let archivedNames = [];

for (const ruleName of archiveRules) {
  const rulePath = path.join(RULES_DIR, ruleName);
  if (!fs.existsSync(rulePath)) {
    log(`归档跳过: ${ruleName} (文件已被引擎或前期步骤归档，无需重复操作)`, 'WARN');
    archivedCount++;
    archivedNames.push(`${ruleName} (已前置归档)`);
    continue;
  }

  try {
    const archiveCmd = `node "${ARCHIVE_SCRIPT}" --rule ${ruleName} --by stage4-cleanup --reason "${decision.archive_reason || '阶段四正常清理'}"`;
    execSync(archiveCmd, { encoding: 'utf8', timeout: 10000 });
    archivedCount++;
    archivedNames.push(ruleName);
    log(`归档规则: ${ruleName} | 原因: ${decision.archive_reason || '阶段四正常清理'}`);
  } catch (err) {
    log(`归档失败: ${ruleName} → err.message`, 'ERROR');
  }
}

log(`归档完成: ${archivedCount} 个 | ${archivedCount > 0 ? archivedNames.join(', ') : '无归档'}`);

// ════════════════════════════════════════════
// 步骤 4: 创建新规则
// ════════════════════════════════════════════
const createRules = decision.create_rules || [];
let createdCount = 0;
let createdNames = [];

for (const rule of createRules) {
  try {
    const filename = rule.filename || `${COIN}-${rule.type}.js`;
    const filePath = path.join(RULES_DIR, filename);

    if (rule.type === 'price-levels') {
      writePriceLevelRule(filePath, rule, decision);
    } else {
      writeNonPriceRule(filePath, rule, decision);
    }

    createdCount++;
    createdNames.push(filename);
    log(`创建规则: ${filename} | 类型: ${rule.type}`);
  } catch (err) {
    log(`创建规则失败: ${rule.filename} → err.message`, 'ERROR');
  }
}

// ════════════════════════════════════════════
// 步骤 5: 记录结束
// ════════════════════════════════════════════
log(`警报管理完成 | 活跃规则: ${createdCount} 个 | 归档规则: ${archivedCount} 个 | 本次创建: ${createdCount} 个`);
log('[📋API诉求检查] 无新诉求');
log('完成执行');
log('========== 阶段四结束 ==========');
log('========== 山寨分析流程结束 ==========');

output({
  status: 'success',
  coin: COIN,
  cycle_dir: CYCLE_DIR,
  archived: { count: archivedCount, rules: archivedNames },
  created: { count: createdCount, rules: createdNames }
});

// ════════════════════════════════════════════
// 规则文件生成函数
// ════════════════════════════════════════════

/**
 * 生成多价位规则文件
 */
function writePriceLevelRule(filePath, rule, decision) {
  const levels = rule.price_levels || [];
  if (levels.length === 0) throw new Error('price_levels 为空');
  if (levels.length > 6) throw new Error(`价位超过6个限制 (${levels.length})`);

  const reportPath = decision.report_path || '';
  const maxRetracePct = rule.max_retrace_pct || 0.3;

  const levelsCode = levels.map(l => {
    // 自动计算 confirmMs
    let confirmMs = 0;
    switch (l.confirmPolicy || 'hold') {
      case 'instant': confirmMs = 0; break;
      case 'touch': confirmMs = 3 * 60 * 1000; break;
      case 'hold': confirmMs = 15 * 60 * 1000; break;
      case 'deep_hold': confirmMs = 25 * 60 * 1000; break;
      default: confirmMs = 15 * 60 * 1000;
    }
    return `  { price: ${l.price}, type: '${l.type}', label: '${l.label}',
    action: '${l.action || ''}', priority: '${l.priority || 'high'}',
    confirmPolicy: '${l.confirmPolicy || 'hold'}', confirmMs: ${confirmMs} }`;
  }).join(',\n');

  const summary = levels.map(l =>
    `${l.type === 'resistance' ? '⬆️' : '⬇️'} $${l.price} (${l.label})`
  ).join(', ');

  const content = `/**
 * ${COIN} 多价位监控（延迟确认）
 *
 * 来源报告: ${reportPath}
 * 设立理由: 阶段二交叉验证分析识别的关键价位
 * 监控价位: ${summary}
 *
 * [山寨] 文件名: ${COIN}-price-levels.js
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn, execSync } = require('child_process');
const path = require('path');

const COIN = '${COIN}';
const COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================
// 价位配置（${levels.length}个）
// ============================================================
const PRICE_LEVELS = [
${levelsCode}
];

// ============================================================
// K 线参数（间隔翻倍时 limit 自动缩放）
// ============================================================
const BAR = '5m';
const BAR_MS = 5 * 60 * 1000;

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: ${maxRetracePct},
  resetOnCrossback: true
};

module.exports = {
  name: '${COIN}-多价位监控',

  // ═══ C19: 规则元数据 ═══
  ruleType: 'price-levels',
  coin: '${COIN}',
  cycleId: '${CYCLE_DIR}',
  status: 'active',
  createdAt: '${nowISO()}',
  createdBy: 'alt-intel-stage4',
  sourceReport: '${reportPath}',
  archivedAt: null,
  archivedBy: null,
  archiveReason: null,
  // ═══ C19 END ═══

  interval: 10 * 60 * 1000,
  lastTriggered: 0,
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},
  longShortRatio: null,
  takerBuyRatio: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const limit = Math.max(2, Math.round(this.interval / BAR_MS));
      const klines = await api.getOKXKlines(COIN, BAR, limit, 'SWAP');
      if (!klines || klines.length === 0) return false;

      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      try {
        const lsData = await api.getOKXLongShortRatio(COIN);
        this.longShortRatio = lsData?.currentRatio;
      } catch (_) {}
      try {
        const takerData = await api.getOKXTakerRatio(COIN, '1H');
        this.takerBuyRatio = takerData?.currentRatio;
      } catch (_) {}

      const now = Date.now();
      const confirmedLevels = [];
      const allLogs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];

        const touched = (level.type === 'resistance' && periodHigh >= level.price)
                     || (level.type === 'support' && periodLow <= level.price);

        if (!touched) {
          if (state.firstTouch && !state.confirmed) {
            const aboveLevel = (level.type === 'resistance' && latestPrice < level.price)
                            || (level.type === 'support' && latestPrice > level.price);
            if (aboveLevel) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(\`\${level.label}: 回穿 \${retrace.toFixed(2)}%，重置\`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(\`\${level.label}: INSTANT 触发\`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(\`\${level.label}: 首次触及，\${level.confirmMs / 60000}min 确认中\`);
          continue;
        }

        if (!this.breakoutExtremes[key]) this.breakoutExtremes[key] = latestPrice;
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs && !state.confirmed) {
          state.confirmed = true;
          confirmedLevels.push(level);
          allLogs.push(\`\${level.label}: 确认完成 (\${Math.floor(elapsed / 60000)}min)\`);
        } else {
          allLogs.push(\`\${level.label}: 确认中 (\${Math.floor(elapsed / 60000)}/\${level.confirmMs / 60000}min)\`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(\`[🔍警报检查] [API] OKX获取\${COIN} \${limit}根\${BAR} K线 | [进度] \${this.name} | 区间: $\${periodLow.toFixed(5)}-$\${periodHigh.toFixed(5)} | 当前: $\${latestPrice.toFixed(5)} | \${statusStr} | 触发: \${confirmedLevels.length > 0} | [来源] ${reportPath.split('/').pop()}: "关键价位监控"\`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;

    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');

      let oiData = null;
      try { oiData = await api.getOKXOpenInterest(COIN); } catch (_) {}
      let frData = null;
      try { frData = await api.getOKXFundingRate(COIN); } catch (_) {}

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,

        triggeredLevels: triggeredLevels.map(l => {
          const key = String(l.price);
          const state = this.levelStates[key] || {};
          return {
            price: l.price,
            type: l.type,
            label: l.label,
            action: l.action,
            priority: l.priority,
            confirmPolicy: l.confirmPolicy,
            confirmMs: l.confirmMs,
            firstTouchTime: state.firstTouch ? new Date(state.firstTouch).toISOString() : null,
            confirmedAt: new Date(now).toISOString(),
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0,
              crossbacks: state.crossbacks || 0,
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price,
              maxRetracePct: l.confirmPolicy === 'instant' ? null
                : Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),

        periodRange: {
          high: Math.max(...klines4h.slice(-3).map(k => k.high)),
          low: Math.min(...klines4h.slice(-3).map(k => k.low))
        },

        openInterest: oiData?.currentOI,
        fundingRate: frData?.fundingRate,
        longShortRatio: this.longShortRatio,
        takerBuyRatio: this.takerBuyRatio,
        klines4h: klines4h ? klines4h.slice(0, 3).map(k => ({
          time: k.datetime || k.time, open: k.open, high: k.high,
          low: k.low, close: k.close, volume: k.volume
        })) : null,

        alertType: 'price-multi-level',
        significance: this._buildSignificance(triggeredLevels)
      };

    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  _buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    const labels = levels.map(l => \`\${l.label}($\${l.price})\`);
    const actions = levels.map(l => l.action).filter(Boolean).join('；');
    return \`\${labels.join('、')} 触发\${actions ? '；' + actions : ''}\`;
  },

  async trigger(data) {
    // 调用 stage1-instant.js 采集即时数据 + 自动派发阶段二分析
    const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'stage1-instant.js');
    const json = JSON.stringify(data);
    try {
      execSync(\`node "\${scriptPath}" '\${json.replace(/'/g, "'\\\\\\\\''")}' 2>/dev/null\`, {
        timeout: 35000, stdio: 'pipe'
      });
      console.log(\`[🔔警报触发] \${this.name} | 即时数据采集完成 → 阶段二已派发\`);
    } catch (err) {
      console.error(\`[❌警报触发失败] \${err.message}\`);
    }

    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    return 'active';
  }
};
`;

  fs.writeFileSync(filePath, content, 'utf8');
  log(`规则文件已写入: ${path.basename(filePath)} (${levels.length}个价位)`);
}

/**
 * 生成非价格规则文件
 */
function writeNonPriceRule(filePath, rule, decision) {
  const reportPath = decision.report_path || '';
  const ruleType = rule.type || 'oi-monitor';
  const threshold = rule.threshold_value || rule.threshold_pct || 5;
  const thresholdType = rule.threshold_type || 'pct';  // 'pct'=百分比 | 'absolute'=绝对值（仅 oi-monitor）
  const label = rule.label || `${COIN} ${ruleType} 监控`;
  const rawTemplate = rule.significance_template || `${ruleType} 触发`;
  const direction = rule.direction || 'above';
  const reason = rule.reason || '阶段二分析识别的监控条件';

  // 转义 significance_template 中的危险字符，防止 LLM 输出注入到生成的 JS 代码中
  // ${...} → \${...}（防止在生成文件的模板字面量中被当作变量引用）
  // ` → \`（防止提前终止模板字面量）
  // ' → \'（防止提前终止单引号字符串）
  const significanceTemplate = rawTemplate
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  // 确定规则类型对应的方法名
  let ruleTypeLabel;
  let apiMethodName;
  switch (ruleType) {
    case 'oi-monitor':
      ruleTypeLabel = 'OI持仓量异动';
      apiMethodName = 'getOKXOpenInterest';
      break;
    case 'funding-reversal':
      ruleTypeLabel = '资金费率极端/反转';
      apiMethodName = 'getOKXFundingRate';
      break;
    case 'taker-ratio':
      ruleTypeLabel = 'Taker买卖比偏离';
      apiMethodName = 'getOKXTakerRatio';
      break;
    case 'ls-reversal':
      ruleTypeLabel = '多空比反转';
      apiMethodName = 'getOKXLongShortRatio';
      break;
    case 'volume-anomaly':
      ruleTypeLabel = '成交量异常';
      apiMethodName = 'getOKXKlines';
      break;
    default:
      ruleTypeLabel = ruleType;
      apiMethodName = 'getOKXOpenInterest';
  }

  // ═══ 按类型生成 check/collect 逻辑 ═══
  let checkLogic, collectLogic;

  if (ruleType === 'oi-monitor') {
    if (thresholdType === 'absolute') {
      // ── OI 绝对值阈值 ──
      const cmpOp = direction === 'below' ? '<=' : '>=';
      const cmpLabel = direction === 'below' ? '≤' : '≥';
      checkLogic = `      const oiData = await api.getOKXOpenInterest(COIN);
      if (!oiData || oiData.currentOI === undefined) {
        console.log(\`[🔍警报检查] [API] \${COIN} OI数据获取失败 | [进度] \${this.name} | 跳过\`);
        return false;
      }
      const currentOI = oiData.currentOI;
      const triggered = currentOI ${cmpOp} ${threshold};
      console.log(\`[🔍警报检查] [API] OKX获取\${COIN} OI数据 | [进度] \${this.name} | 当前OI: \${currentOI.toFixed(0)} | 阈值: ${cmpLabel}${threshold} | 触发: \${triggered} | [来源] ${reportPath.split('/').pop()}: "${reason}"\`);`;
    } else {
      // ── OI 百分比阈值（从创建时基准 OI 起算增量，避免用 24h 累计变化导致立即触发）──
      checkLogic = `      const oiData = await api.getOKXOpenInterest(COIN);
      if (!oiData || oiData.currentOI === undefined) {
        console.log(\`[🔍警报检查] [API] \${COIN} OI数据获取失败 | [进度] \${this.name} | 跳过\`);
        return false;
      }
      // 首次检查时记录当前 OI 为基准值，后续按基准起算增量
      if (!this.baseOI) {
        this.baseOI = oiData.currentOI;
        console.log(\`[🔍警报检查] [基准] \${COIN} OI基准值已设定: \${this.baseOI.toFixed(0)} | [进度] \${this.name} | 阈值: 从基准起 ${direction === 'absolute' ? '|变化|' : direction === 'below' ? '下跌' : '上涨'} ≥${threshold}%\`);
        return false;
      }
      const currentOI = oiData.currentOI;
      const changeFromBase = ((currentOI - this.baseOI) / this.baseOI) * 100;
      const triggered = ${direction === 'absolute' ? 'Math.abs(changeFromBase) >= ' + threshold : direction === 'below' ? 'changeFromBase <= -' + threshold : 'changeFromBase >= ' + threshold};
      console.log(\`[🔍警报检查] [API] OKX获取\${COIN} OI数据 | [进度] \${this.name} | 当前OI: \${currentOI.toFixed(0)} | 基准OI: \${this.baseOI.toFixed(0)} | 变化: \${changeFromBase.toFixed(2)}% | 阈值: ${direction === 'below' ? '≤-' : direction === 'absolute' ? '|≥|' : '≥'}${threshold}% | 触发: \${triggered} | [来源] ${reportPath.split('/').pop()}: "${reason}"\`);`;
    }

    collectLogic = `      const oiData = await api.getOKXOpenInterest(COIN);
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');
      const changePct = oiData?.change24h || 0;
      const currentOI = oiData?.currentOI || 0;
      return {
        coin: COIN, alertName: \`\${this.name}\`, alertTime: new Date().toISOString(), currentPrice: ticker.price,
        alertType: 'oi-monitor',
        oiData: { currentOI: oiData?.currentOI, change24h: oiData?.change24h, timestamp: new Date().toISOString() },
        openInterest: oiData?.currentOI,
        klines4h: klines4h ? klines4h.slice(0,3).map(k => ({ time: k.datetime||k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })) : null,
        significance: \`${significanceTemplate}\`
          .replace(/\\{change_pct\\}/g, changePct.toFixed(2))
          .replace(/\\{current_oi\\}/g, currentOI.toFixed(0))
          .replace(/\\{threshold\\}/g, '${threshold}')
      };`;

  } else if (ruleType === 'funding-reversal') {
    // ── 资金费率监控 ──
    checkLogic = `      const frData = await api.getOKXFundingRate(COIN);
      if (!frData || frData.fundingRate === undefined) {
        console.log(\`[🔍警报检查] [API] \${COIN} 资金费率获取失败 | [进度] \${this.name} | 跳过\`);
        return false;
      }
      const rate = frData.fundingRate;
      const triggered = ${direction === 'absolute' ? 'Math.abs(rate) >= ' + threshold : direction === 'below' ? 'rate <= -' + threshold : 'rate >= ' + threshold};
      console.log(\`[🔍警报检查] [API] OKX获取\${COIN} 资金费率 | [进度] \${this.name} | 费率: \${(rate*100).toFixed(4)}% | 阈值: ${direction === 'below' ? '≤-' : direction === 'absolute' ? '|≥|' : '≥'}${Number(threshold)*100}% | 触发: \${triggered} | [来源] ${reportPath.split('/').pop()}: "${reason}"\`);`;

    collectLogic = `      const frData = await api.getOKXFundingRate(COIN);
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');
      const rate = frData?.fundingRate || 0;
      const fundingRatePct = (rate * 100).toFixed(4);  // 百分比显示值，供占位符 {funding_rate} 使用
      return {
        coin: COIN, alertName: \`\${this.name}\`, alertTime: new Date().toISOString(), currentPrice: ticker.price,
        alertType: 'funding-reversal',
        fundingRate: rate,
        fundingRatePct: fundingRatePct + '%',
        nextFundingRate: frData?.nextFundingRate,
        isLongPay: frData?.isLongPay,
        klines4h: klines4h ? klines4h.slice(0,3).map(k => ({ time: k.datetime||k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })) : null,
        significance: \`${significanceTemplate}\`
          .replace(/\\{funding_rate\\}/g, fundingRatePct)
          .replace(/\\{threshold\\}/g, '${threshold}')
      };`;

  } else if (ruleType === 'taker-ratio') {
    // ── Taker 买卖比监控 ──
    checkLogic = `      const takerData = await api.getOKXTakerRatio(COIN, '1H');
      if (!takerData || takerData.currentRatio === undefined) {
        console.log(\`[🔍警报检查] [API] \${COIN} Taker比获取失败 | [进度] \${this.name} | 跳过\`);
        return false;
      }
      const ratio = takerData.currentRatio;
      const triggered = ${direction === 'below' ? 'ratio <= ' + threshold : 'ratio >= ' + threshold};
      console.log(\`[🔍警报检查] [API] OKX获取\${COIN} Taker买卖比 | [进度] \${this.name} | 当前比率: \${ratio.toFixed(2)} | 阈值: ${direction === 'below' ? '≤' : '≥'}${threshold} | 触发: \${triggered} | [来源] ${reportPath.split('/').pop()}: "${reason}"\`);`;

    collectLogic = `      const takerData = await api.getOKXTakerRatio(COIN, '1H');
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');
      const ratio = takerData?.currentRatio || 1;
      const buyVol = takerData?.buyVolume || 0;
      const sellVol = takerData?.sellVolume || 0;
      return {
        coin: COIN, alertName: \`\${this.name}\`, alertTime: new Date().toISOString(), currentPrice: ticker.price,
        alertType: 'taker-ratio',
        takerRatio: ratio,
        prevRatio: takerData?.prevRatio,
        buyVolume: buyVol,
        sellVolume: sellVol,
        change: takerData?.change,
        klines4h: klines4h ? klines4h.slice(0,3).map(k => ({ time: k.datetime||k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })) : null,
        significance: \`${significanceTemplate}\`
          .replace(/\\{current_ratio\\}/g, ratio.toFixed(2))
          .replace(/\\{threshold\\}/g, '${threshold}')
      };`;

  } else if (ruleType === 'ls-reversal') {
    // ── 多空比监控 ──
    checkLogic = `      const lsData = await api.getOKXLongShortRatio(COIN);
      if (!lsData || lsData.currentRatio === undefined) {
        console.log(\`[🔍警报检查] [API] \${COIN} 多空比获取失败 | [进度] \${this.name} | 跳过\`);
        return false;
      }
      const ratio = lsData.currentRatio;
      const triggered = ${direction === 'below' ? 'ratio <= ' + threshold : 'ratio >= ' + threshold};
      console.log(\`[🔍警报检查] [API] OKX获取\${COIN} 多空比 | [进度] \${this.name} | 比率: \${ratio.toFixed(2)} | 阈值: ${direction === 'below' ? '≤' : '≥'}${threshold} | 触发: \${triggered} | [来源] ${reportPath.split('/').pop()}: "${reason}"\`);`;

    collectLogic = `      const lsData = await api.getOKXLongShortRatio(COIN);
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');
      const ratio = lsData?.currentRatio || 1;
      return {
        coin: COIN, alertName: \`\${this.name}\`, alertTime: new Date().toISOString(), currentPrice: ticker.price,
        alertType: 'ls-reversal',
        longShortRatio: ratio,
        prevRatio: lsData?.prevRatio,
        klines4h: klines4h ? klines4h.slice(0,3).map(k => ({ time: k.datetime||k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })) : null,
        significance: \`${significanceTemplate}\`
          .replace(/\\{current_ratio\\}/g, ratio.toFixed(2))
          .replace(/\\{threshold\\}/g, '${threshold}')
      };`;

  } else if (ruleType === 'volume-anomaly') {
    // ── 成交量异动监控 ──
    checkLogic = `      const klines = await api.getOKXKlines(COIN, '1H', 24, 'SWAP');
      if (!klines || klines.length < 2) {
        console.log(\`[🔍警报检查] [API] \${COIN} K线获取失败 | [进度] \${this.name} | 跳过\`);
        return false;
      }
      // 最新1根 vs 前23根均值（共24根）
      const latestVol = klines[0].volume;
      const avgVol = klines.slice(1).reduce((s,k) => s + k.volume, 0) / (klines.length - 1);
      const ratio = latestVol / avgVol;
      const triggered = ${direction === 'below' ? 'ratio <= ' + threshold : 'ratio >= ' + threshold};
      console.log(\`[🔍警报检查] [API] OKX获取\${COIN} 1H K线 | [进度] \${this.name} | 当前量: \${latestVol.toFixed(0)} | 均量: \${avgVol.toFixed(0)} | 比率: \${ratio.toFixed(2)}x | 阈值: ${direction === 'below' ? '≤' : '≥'}${threshold}x | 触发: \${triggered} | [来源] ${reportPath.split('/').pop()}: "${reason}"\`);`;

    collectLogic = `      const klines = await api.getOKXKlines(COIN, '1H', 24, 'SWAP');
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const latestVol = klines?.[0]?.volume || 0;
      const avgVol = (klines?.length > 1) ? klines.slice(1).reduce((s,k) => s + k.volume, 0) / (klines.length - 1) : 0;
      const volRatio = avgVol > 0 ? latestVol / avgVol : 1;
      return {
        coin: COIN, alertName: \`\${this.name}\`, alertTime: new Date().toISOString(), currentPrice: ticker.price,
        alertType: 'volume-anomaly',
        latestVolume: latestVol,
        avgVolume: avgVol,
        volumeRatio: volRatio,
        klines1h: klines ? klines.slice(0,5).map(k => ({ time: k.datetime||k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })) : null,
        significance: \`${significanceTemplate}\`
          .replace(/\\{volume_ratio\\}/g, volRatio.toFixed(2))
          .replace(/\\{threshold\\}/g, '${threshold}')
      };`;

  } else {
    // 未知类型 → 存根（安全回退）
    checkLogic = `      // 未知规则类型: ${ruleType}
      console.log(\`[🔍警报检查] [API] \${COIN} ${ruleType} | [进度] \${this.name} | 未知类型，跳过\`);
      return false;`;
    collectLogic = `      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      return { coin: COIN, alertName: \`\${this.name}\`, alertTime: new Date().toISOString(), currentPrice: ticker.price, alertType: '${ruleType}', significance: '${significanceTemplate}' };`;
  }

  const content = `/**
 * ${COIN} ${label}
 *
 * 来源报告: ${reportPath}
 * 设立理由: ${reason}
 *
 * [山寨] 文件名: ${COIN}-${ruleType}.js
 */

const api = require('../../btc-market-lite/scripts/api');
const { execSync } = require('child_process');
const path = require('path');

const COIN = '${COIN}';
const COOLDOWN_MS = ${ruleType === 'oi-monitor' ? '2' : '1'} * 60 * 60 * 1000;
const THRESHOLD = ${threshold};

module.exports = {
  name: '${COIN}-${label}',

  // ═══ C19: 规则元数据 ═══
  ruleType: '${ruleType}',
  coin: '${COIN}',
  cycleId: '${CYCLE_DIR}',
  status: 'active',
  createdAt: '${nowISO()}',
  createdBy: 'alt-intel-stage4',
  sourceReport: '${reportPath}',
  archivedAt: null,
  archivedBy: null,
  archiveReason: null,
  // ═══ C19 END ═══

  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
${checkLogic}

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
${collectLogic}
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    // 调用 stage1-instant.js 采集即时数据 + 自动派发阶段二分析
    const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'stage1-instant.js');
    const json = JSON.stringify(data);
    try {
      execSync(\`node "\${scriptPath}" '\${json.replace(/'/g, "'\\\\\\\\''")}' 2>/dev/null\`, {
        timeout: 35000, stdio: 'pipe'
      });
      console.log(\`[🔔警报触发] \${this.name} | 即时数据采集完成 → 阶段二已派发\`);
    } catch (err) {
      console.error(\`[❌警报触发失败] \${err.message}\`);
    }

    this.lastTriggered = Date.now();
  },

  lifetime() {
    return 'active';
  }
};
`;

  fs.writeFileSync(filePath, content, 'utf8');
  log(`规则文件已写入: ${path.basename(filePath)} (${ruleTypeLabel})`);
}
