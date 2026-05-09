/**
 * 仓位管理多价位监控警报 (v2 - $80K收复后更新)
 * 
 * 来源: 2026-05-08 22:43即时分析 (cycle-20260508-001)
 * 仓位: 0.09 long @ $80,169.8, 3x isolated
 * OCO: TP1=$80,500 (0.05张), TP2=$80,978 (0.04张), SL=$78,978
 * 市场判断: $80,000假跌破后被放量收复, V型反转, 关注TP1=$80,500是否触发
 * 
 * 价位说明:
 * 上方: $80,500(TP1止盈区域), $80,978(TP2终极止盈), $81,500(突破确认/趋势反转)
 * 下方: $80,000(支撑验证), $79,400(减仓线), $78,978(SL止损线/OCO自动)
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'BTC';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000;

// 多价位配置（每个价位带独立确认策略）
const PRICE_LEVELS = [
  // ---- 上方价位（上行监控） ----
  { price: 80500, type: 'resistance', label: 'TP1止盈区域/OCO自动触发',
    action: '价格触及TP1=$80,500，OCO将自动平仓0.05张，剩余0.04张需重新评估策略', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 80978, type: 'resistance', label: 'TP2终极止盈区域',
    action: '价格接近TP2=$80,978，OCO将自动平仓剩余0.04张，多单全部离场', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },

  { price: 81500, type: 'resistance', label: '突破确认/趋势反转',
    action: '突破$81,500，4H级别趋势可能转为多头，需重新评估整体策略', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 },

  // ---- 下方价位（下行风险监控） ----
  { price: 80000, type: 'support', label: '支撑验证/$80K重测',
    action: '$80,000再次面临威胁，关注能否守住假跌破后回收的重要防线', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 79400, type: 'support', label: '减仓触发线',
    action: '价格跌至$79,400减仓线，应减仓至0.05张，降低风险敞口', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 78978, type: 'support', label: 'SL止损最后防线',
    action: '止损触发价$78,978到达，OCO将自动全平，评估是否提前离场', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 }
];

const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: '仓位管理多价位监控-v2 ($80K收复后)',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('BTC', '1m', 3);
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;
      const now = Date.now();
      const confirmedLevels = [];
      const logs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];

        const wasTouched = (level.type === 'resistance' && periodHigh >= level.price) ||
                          (level.type === 'support' && periodLow <= level.price);

        if (!wasTouched) {
          if (state.firstTouch && !state.confirmed) {
            const isRetraced = (level.type === 'resistance' && latestPrice < level.price) ||
                               (level.type === 'support' && latestPrice > level.price);
            if (isRetraced) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                logs.push(`${level.label}: 回穿${retrace.toFixed(2)}%，重置`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          logs.push(`${level.label}: 即时触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          logs.push(`${level.label}: 首次触及，${level.confirmMs/60000}min确认`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        } else if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          if (!state.confirmed) {
            state.confirmed = true;
            confirmedLevels.push(level);
            logs.push(`${level.label}: ✅ 确认(${Math.floor(elapsed/60000)}min)`);
          }
        } else {
          logs.push(`${level.label}: 确认中(${Math.floor(elapsed/60000)}/${Math.floor(level.confirmMs/60000)}min)`);
        }
      }

      const statusStr = logs.length > 0 ? logs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取BTC 3根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-08 22:43即时分析: "$80,000假跌破被放量收复，关注TP1=$80,500是否触发"`);

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
      const ticker = await api.getTicker('BTC');
      const klines15m = await api.getKlines('BTC', '15m', 8);

      return {
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
              maxRetracePct: l.confirmPolicy === 'instant' ? null :
                Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),
        periodRange: {
          high: Math.max(...klines15m.slice(-3).map(k => k.high)),
          low: Math.min(...klines15m.slice(-3).map(k => k.low))
        },
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: '仓位管理多价位触发',
        significance: triggeredLevels.length === 1
          ? `${triggeredLevels[0].label}($${triggeredLevels[0].price}) ${triggeredLevels[0].confirmPolicy === 'instant' ? '即时' : `确认${triggeredLevels[0].confirmMs/60000}分钟后`}触发，${triggeredLevels[0].action || '需重新评估'}`
          : `多价位确认触发: ${triggeredLevels.map(l => `${l.label}($${l.price})`).join('、')}`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/instant-analysis-stage1.md 执行数据获取\n2. 读取 tasks/daily-report-stage2.md 执行技术分析\n3. 读取 tasks/daily-report-stage3.md 执行仓位管理\n4. 读取 tasks/daily-report-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.coin.model || CONFIG.trigger.btc.model;
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

    console.log(`[警报触发] 已派发即时分析任务: ${jobName} | 触发价位: ${data.triggeredLevels.length}个`);

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
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
