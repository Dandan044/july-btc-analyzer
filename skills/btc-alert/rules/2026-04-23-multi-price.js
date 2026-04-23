/**
 * 多价位监控警报
 * 监控多个关键价位，使用K线区间数据捕捉瞬时突破
 * 单次触发传递组合信息
 * 来源: 04-23 09:05日报 - 上升旗形关键位置 + 情景触发价位
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ⭐ 多价位配置（最多6个）
const PRICE_LEVELS = [
  // 上方阻力位
  { price: 79443, type: 'resistance', label: '旗形顶部', action: '做多B', priority: 'high', source: '04-23 09:05日报: "即时高点$79,443为4H 0%斐波那契，突破确认需4H收盘高于此位"' },
  { price: 80000, type: 'resistance', label: '整数关口', action: null, priority: 'low', source: '整数心理关口' },
  { price: 81500, type: 'resistance', label: '前高压力', action: '趋势反转', priority: 'medium', source: '04-23 09:05日报: "前高$81,500为趋势反转信号"' },
  // 下方支撑位
  { price: 77500, type: 'support', label: '关键支撑', action: '情景C', priority: 'high', source: '04-23 09:05日报: "今日低点$77,544为强支撑，跌破将破坏4H结构，触发情景C深度回踩"' },
  { price: 74980, type: 'support', label: '情景C目标', action: '止盈', priority: 'medium', source: '04-23 09:05日报: "情景C目标$74,980"' },
  { price: 73596, type: 'support', label: '深度支撑', action: null, priority: 'medium', source: '04-23 09:05日报: "深度支撑$73,596"' }
];

module.exports = {
  name: '多价位监控警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  // ⭐ 当前触发的价位组合（供 collect() 使用）
  currentTriggeredLevels: [],
  
  // 触发历史记录（可选，用于调试）
  triggeredHistory: [],

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // ⭐ 获取K线片段（而非瞬时价格）
      const klines = await api.getKlines('BTC', '1m', 3);
      
      // 计算区间高低价
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      // ⭐ 批量检查所有价位
      const triggeredLevels = [];
      
      for (const level of PRICE_LEVELS) {
        const wasTriggered = 
          (level.type === 'resistance' && periodHigh >= level.price) ||
          (level.type === 'support' && periodLow <= level.price);
        
        if (wasTriggered) {
          triggeredLevels.push(level);
        }
      }

      // ⭐ 组合触发：如果有任何价位被触发，返回true
      if (triggeredLevels.length > 0) {
        this.currentTriggeredLevels = triggeredLevels;
        
        const levelStr = triggeredLevels.map(l => `$${l.price}(${l.label})`).join(', ');
        console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发价位: ${levelStr} | 触发: true`);
        
        return true;
      }

      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发: false`);
      
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      
      const ticker = await api.getTicker('BTC');
      const klines15m = await api.getKlines('BTC', '15m', 8);
      
      let oiData = null;
      let takerData = null;
      try {
        oiData = await api.getOKXOpenInterest ? await api.getOKXOpenInterest() : null;
        takerData = await api.getOKXTakerRatio ? await api.getOKXTakerRatio() : null;
      } catch (e) {
        console.log('[数据收集] OKX数据获取失败，继续使用其他数据');
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        // ⭐ 组合触发信息
        triggeredLevels: triggeredLevels.map(l => ({
          price: l.price,
          type: l.type,
          label: l.label,
          action: l.action,
          priority: l.priority,
          source: l.source
        })),
        
        periodRange: {
          high: Math.max(...klines15m.slice(-3).map(k => k.high)),
          low: Math.min(...klines15m.slice(-3).map(k => k.low))
        },
        
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: oiData?.currentOI,
        openInterestChange24h: oiData?.change24h,
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        
        alertType: '多价位触发',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    
    const actions = levels.filter(l => l.action).map(l => l.action);
    const labels = levels.map(l => `${l.label}($${l.price})`);
    
    if (levels.length === 1) {
      const l = levels[0];
      return l.action 
        ? `价格触及${l.label}($${l.price})，触发动作: ${l.action}`
        : `价格触及${l.label}($${l.price})`;
    }
    
    const actionStr = actions.length > 0 ? `，触发动作: ${actions.join(' / ')}` : '';
    return `价格区间跨越多个关键位: ${labels.join('、')}${actionStr}`;
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-multi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    this.triggeredHistory.push({
      time: new Date().toISOString(),
      levels: data.triggeredLevels
    });
    
    console.log(`[警报触发] 已创建即时分析任务: ${jobName}，触发价位: ${data.triggeredLevels.length}个`);
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};