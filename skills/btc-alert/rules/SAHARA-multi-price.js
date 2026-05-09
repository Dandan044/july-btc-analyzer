/**
 * SAHARA 多价位延迟确认警报
 * 
 * 监控 SAHARA 的支撑/阻力关键价位
 * 价格触及价位后等待确认，避免假突破误触发
 *
 * 来源: alt-SAHARA-20260509-0404/reports/alt-report-SAHARA-2026-05-09-0408.md
 * 报告观点: 观望——价格已反弹37%接近4H Fib 100%阻力($0.03124)，等待关键位置突破或跌破
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'SAHARA';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// 多价位配置（5个价位，带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（阻力突破）
  { price: 0.03124, type: 'resistance', label: '4H Fib 100%阻力',
    action: '突破阻力，确认上涨趋势延续，评估做多',
    priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.03150, type: 'resistance', label: '阻力上方确认位',
    action: '放量突破确认，追多信号',
    priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 },

  // 下方价位（支撑跌破）
  { price: 0.02670, type: 'support', label: '5/9低点支撑',
    action: '支撑跌破，短线多头退出，评估做空',
    priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.02500, type: 'support', label: 'EMA均线密集区+4H 61.8%',
    action: '关键支撑失守，反弹趋势可能结束',
    priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.02200, type: 'support', label: '4月底低点',
    action: '深度支撑位，若失守则反弹完全失败',
    priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 }
];

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: 'SAHARA多价位监控（延迟确认）',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取最新价格
      const ticker = await api.getTicker('SAHARA');
      const price = parseFloat(ticker.price);

      const now = Date.now();
      const confirmedLevels = [];
      const allLogs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];

        const wasTouched = (level.type === 'resistance' && price >= level.price) ||
                          (level.type === 'support' && price <= level.price);

        if (!wasTouched) {
          if (state.firstTouch && !state.confirmed) {
            const isAboveLevel = (level.type === 'resistance' && price < level.price) ||
                                 (level.type === 'support' && price > level.price);
            if (isAboveLevel) {
              const retrace = Math.abs((price - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`$${level.price}(${level.label}): 假突破，回穿${retrace.toFixed(2)}%，重置`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`$${level.price}(${level.label}): INSTANT触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`$${level.price}(${level.label}): 首次触及，开始${level.confirmMs/60000}分钟确认...`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = price;
        }
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], price);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], price);
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          if (!state.confirmed) {
            state.confirmed = true;
            confirmedLevels.push(level);
            allLogs.push(`$${level.price}(${level.label}): 确认完成(${(elapsed/60000).toFixed(0)}分钟)`);
          }
        } else {
          allLogs.push(`$${level.price}(${level.label}): 确认中(${(elapsed/60000).toFixed(0)}/${level.confirmMs/60000}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取SAHARA价格 | [进度] ${this.name} | 当前价: $${price.toFixed(5)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

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

      const ticker = await api.getTicker('SAHARA');
      const klines15m = await api.getKlines('SAHARA', '15m', 8);

      return {
        coin: 'SAHARA',
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
              breakoutExtreme: this.breakoutExtremes[key] || parseFloat(ticker.price),
              maxRetracePct: l.confirmPolicy === 'instant' ? null : 
                Math.abs((parseFloat(ticker.price) - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),

        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: '多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels),
        alertSource: 'SAHARA周期扫描-阶段四'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    if (levels.length === 1) {
      const l = levels[0];
      const confirmDesc = l.confirmPolicy === 'instant' ? '立即触发' : `确认${l.confirmMs/60000}分钟后触发`;
      return l.action
        ? `${l.label}($${l.price}) ${confirmDesc}，${l.action}`
        : `${l.label}($${l.price}) ${confirmDesc}`;
    }
    const labels = levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`);
    return `多价位确认触发: ${labels.join('、')}`;
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-SAHARA-multi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
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

    console.log(`[SAHARA警报触发] 已派发即时分析任务: ${jobName} | ${alertData.triggeredLevels.length}个价位触发`);
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired'; // 5天有效期
  }
};
