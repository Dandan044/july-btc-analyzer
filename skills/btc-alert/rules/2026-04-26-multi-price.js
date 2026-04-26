/**
 * 多价位监控警报
 * 监控多个关键价位，使用K线区间数据捕捉瞬时突破
 * 单次触发传递组合信息
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-26';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ⭐ 多价位配置（6个价位）
const PRICE_LEVELS = [
  { price: 77000, type: 'support', label: '止损位', action: '止损触发出局', priority: 'high' },
  { price: 78500, type: 'resistance', label: '第一止盈', action: '部分止盈0.18张', priority: 'high' },
  { price: 79500, type: 'resistance', label: '第二止盈', action: '全部止盈0.18张', priority: 'high' },
  { price: 77700, type: 'resistance', label: '阻力1', action: '突破测试', priority: 'medium' },
  { price: 77034, type: 'support', label: '支撑1', action: '支撑再次测试', priority: 'medium' },
  { price: 74984, type: 'support', label: '极端回调', action: '4H 50%斐波位', priority: 'medium' }
];

module.exports = {
  name: '多价位监控警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  currentTriggeredLevels: [],
  triggeredHistory: [],

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // ⭐ 获取K线片段（覆盖检查间隔）
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

      // ⭐ 组合触发
      if (triggeredLevels.length > 0) {
        this.currentTriggeredLevels = triggeredLevels;
        
        const levelStr = triggeredLevels.map(l => `$${l.price}(${l.label})`).join(', ');
        console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发价位: ${levelStr} | 触发: true | [来源] 04-26 01:11日报: "持仓风险边际上升，止损$77000关键边界，止盈$78500/$79500"`);
        
        return true;
      }

      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发: false | [来源] 04-26 01:11日报: "持仓风险边际上升，止损$77000关键边界"`);
      
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

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        // ⭐ 组合触发信息
        triggeredLevels: triggeredLevels.map(l => ({
          price: l.price,
          type: l.type,
          label: l.label,
          action: l.action,
          priority: l.priority
        })),
        
        periodRange: {
          high: Math.max(...klines15m.slice(-3).map(k => k.high)),
          low: Math.min(...klines15m.slice(-3).map(k => k.low))
        },
        
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        
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
    const today = api.getLocalDate();
    // 止盈止损警报与持仓周期绑定，周期归档时警报失效
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};