/**
 * 延迟确认多价位监控警报
 * 每个价位有独立的确认策略和延迟时间
 * 价格触及价位后等待确认，避免假突破误触发
 *
 * 来源：active/cycle-20260507-001/reports/btc-report-2026-05-07-0900.md
 * 报告观点：趋势结构偏多但参与者行为偏空（多空比、大户比、Taker比全线背离），
 *   关键观察位：$80,500支撑能否守住（决定回调深度 vs 延续上行），
 *   上方 $81,545（周线61.8%斐波）和 $82,800（前高）为阻力确认位。
 *   入场条件：$80,500支撑确认后做多，或跌破$80,500反抽无力后做空。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'BTC';  // ← BTC 使用 trigger.btc.model

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000; // 整体冷却 1小时

// ============================================================
// 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 82800, type: 'resistance', label: '前高压力',
    action: '触及前高，评估突破强度', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },
    
  { price: 81545, type: 'resistance', label: '周线61.8%斐波',
    action: '站上则回调结束偏多', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  
  // 下方价位
  { price: 80500, type: 'support', label: '关键支撑/多头入场触发',
    action: '支撑确认后评估做多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },
    
  { price: 80000, type: 'support', label: '整数关口心理支撑',
    action: '整数关口参考位', priority: 'low',
    confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000 },
    
  { price: 79000, type: 'support', label: '日线38.2%斐波/次级支撑',
    action: '跌破则回调深化，评估做空', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 77800, type: 'support', label: '布林中轨/趋势支撑',
    action: '趋势支撑位观察', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000 }
];

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.1,     // 最大回穿幅度 %
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: '延迟确认多价位监控',
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
      const allLogs = [];

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
            const isAboveLevel = (level.type === 'resistance' && latestPrice < level.price) ||
                                 (level.type === 'support' && latestPrice > level.price);
            if (isAboveLevel) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 假突破，回穿${retrace.toFixed(2)}%，重置`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，开始${level.confirmMs/60000}分钟确认...`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        }
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          if (!state.confirmed) {
            state.confirmed = true;
            confirmedLevels.push(level);
            const elapsedMins = Math.floor(elapsed / 60000);
            allLogs.push(`${level.label}: 确认完成(${elapsedMins}分钟)`);
          }
        } else {
          const elapsedMins = Math.floor(elapsed / 60000);
          const targetMins = Math.floor(level.confirmMs / 60000);
          allLogs.push(`${level.label}: 确认中(${elapsedMins}/${targetMins}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-07 09:00日报: "趋势偏多但参与者背离，关键观察$80,500支撑及$81,545阻力"`);

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
      
      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest();
        takerData = await api.getOKXTakerRatio();
      } catch (e) { /* 静默 */ }

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
        openInterest: oiData?.currentOI,
        openInterestChange24h: oiData?.change24h,
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: '多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
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

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-confirmed-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/instant-analysis-stage1.md 执行数据获取\n2. 读取 tasks/daily-report-stage2.md 执行技术分析\n3. 读取 tasks/daily-report-stage3.md 执行仓位管理\n4. 读取 tasks/daily-report-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    // 模型从 global-config.json 读取：BTC → trigger.btc.model (pro)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,  // ← 来自 tasks/global-config.json trigger.btc.model
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[警报触发] 已派发即时分析全四阶段任务: ${jobName} | 确认触发价位: ${data.triggeredLevels.length}个 | 确认策略: ${data.triggeredLevels.map(l=>l.confirmPolicy).join(',')}`);
    
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
