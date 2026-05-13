/**
 * WCT 延迟确认多价位监控警报
 * 
 * 来源：alt-report-WCT-2026-05-13-2120.md
 * 报告观点：4H Fib50% $0.06796跌破确认，偏空趋势深度回调持续。4H低点$0.06727。
 *          1H RSI 29.3/15M RSI 23.1极端超卖，OI从1,027K降至1,014K（空头获利平仓）。
 *          4H Taker比1.775连续三根4H K线维持异常高值。
 *          继续观望——盈亏比0.50严重不达标。需价格反弹至$0.0720以上才可做空入场。
 *          做多条件：站上$0.07126(4H布林带中轨) + OI回升至1,040K + 4H MACD转正。
 * 
 * 上一版规则已触发（$0.06796 4H Fib50%跌破），本规则更新价位列表。
 * 变更：$0.06796从support→resistance（已跌破变阻力），新增$0.06606(4H Fib61.8%)下方支撑，
 *       4H布林带中轨从$0.07128→$0.07126，更新来源报告。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const COIN = 'WCT';

// ============================================================
// ⭐ 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（偏空结构下的反弹位/阻力位）
  { price: 0.06796, type: 'resistance', label: '4H Fib50%/原支撑变阻力',
    action: '反弹至原支撑位，评估是否假跌破回抽', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 0.07126, type: 'resistance', label: '4H布林带中轨/做多确认位',
    action: '站上则偏空结构弱化，评估做多条件', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 0.0720, type: 'resistance', label: '做空入场区下沿',
    action: '反弹至做空入场区，评估做空入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  
  // 下方价位
  { price: 0.06606, type: 'support', label: '4H Fib61.8%/下一关键支撑',
    action: '跌破则深度回调加速，偏空趋势进入极端区', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },
    
  { price: 0.06538, type: 'support', label: '日线Fib38.2%/深度目标',
    action: '触及日线级支撑，趋势可能反转', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 }
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,     // WCT波动大，允许稍大回穿
  resetOnCrossback: true
};

module.exports = {
  name: 'WCT-延迟确认多价位监控',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,
  
  // ⭐ 每个价位的独立确认状态
  levelStates: {},
  
  // 本次触发的价位列表
  currentTriggeredLevels: [],
  
  // 突破深度追踪
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines(COIN, '1m', 5);
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

        // 检测是否触及
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

        // Instant: 直接触发
        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT触发`);
          continue;
        }

        // 延迟确认
        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，开始${level.confirmMs/60000}分钟确认`);
          continue;
        }

        // 追踪突破深度
        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        }
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        // 检查确认时间
        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          if (!state.confirmed) {
            state.confirmed = true;
            confirmedLevels.push(level);
            allLogs.push(`${level.label}: 确认完成(${Math.floor(elapsed/60000)}分钟)`);
          }
        } else {
          allLogs.push(`${level.label}: 确认中(${Math.floor(elapsed/60000)}/${Math.floor(level.confirmMs/60000)}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} 5根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(5)}-$${periodHigh.toFixed(5)} | 当前: $${latestPrice.toFixed(5)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] alt-report-WCT-2026-05-13-2050: "4H Fib50%跌破确认，深度回调，观望等反弹"`);

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
      
      const ticker = await api.getOKXTicker(COIN);
      const klines4h = await api.getKlines(COIN, '4h', 6);
      
      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
        takerData = await api.getOKXTakerRatio(COIN);
      } catch (e) { /* 静默 */ }

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
              maxRetracePct: l.confirmPolicy === 'instant' ? null : 
                Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),
        
        periodRange: {
          high: Math.max(...klines4h.slice(-3).map(k => k.high)),
          low: Math.min(...klines4h.slice(-3).map(k => k.low))
        },
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        openInterest: oiData?.currentOI,
        oiChange24h: oiData?.change24h,
        takerBuyRatio: takerData?.currentRatio,
        klines4h: klines4h.map(k => ({
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

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-price-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN}警报触发] 多价位确认 | 已派发即时分析任务: ${jobName} | 确认触发价位: ${alertData.triggeredLevels?.length}个`);
    
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
