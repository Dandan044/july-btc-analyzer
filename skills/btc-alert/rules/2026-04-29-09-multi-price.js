/**
 * 多价位监控警报（早间更新 #3）
 * 基于 2026-04-29 09:30 早间日报关键位置设立
 * 监控6个关键价位，使用K线区间数据捕捉瞬时突破
 * 单次触发传递组合信息
 * 
 * 背景：压缩三角形形成，波动率+成交量双压缩至极端水平
 * MACD柱从-134.7加速恶化至-333.1（-147%），空头动能暗中积累
 * 操作：建议重新做空（止损$76,650），止盈$74,997/$73,937
 * 路径A(55%): 压缩向下突破 / 路径B(30%): 假突破后回落 / 路径C(15%): 突破$77,000反转
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-29';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// 多价位配置（6个，来自早间日报#3 四、行情推断-关键位置表 + 五、仓位操作建议）
// 来源：active/cycle-20260428-001/reports/btc-report-2026-04-29-0930.md
const PRICE_LEVELS = [
  // ⬆️ 上方阻力（3个）
  { price: 76947, type: 'resistance', label: '昨日16:00 4H高点/阻力₂', action: '强阻力被触及，路径B假突破风险上升', priority: 'medium' },
  { price: 76650, type: 'resistance', label: '空头止损线/压缩区上沿+缓冲', action: '空头逻辑失效，需评估平仓', priority: 'high' },
  { price: 76525, type: 'resistance', label: '压缩区间上沿/今日4H高点', action: '压缩区间被突破，空头结构松动', priority: 'high' },
  // ⬇️ 下方支撑（3个）
  { price: 75854, type: 'support', label: '压缩区间下沿/今日低点', action: '压缩向下突破确认，空头趋势延续', priority: 'high' },
  { price: 74997, type: 'support', label: '止盈1/4H 50%斐波/$75K心理位', action: '止盈1到达，建议平仓50%', priority: 'high' },
  { price: 73937, type: 'support', label: '止盈2/4H 61.8%黄金分割', action: '止盈2到达，建议平仓剩余50%', priority: 'high' }
];

module.exports = {
  name: '多价位监控警报（早间更新#3）',
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
      // 获取K线片段（覆盖3分钟检查间隔）
      const klines = await api.getKlines('BTC', '1m', 3);
      
      // 计算区间高低价
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      // 批量检查所有价位
      const triggeredLevels = [];
      
      for (const level of PRICE_LEVELS) {
        const wasTriggered = 
          (level.type === 'resistance' && periodHigh >= level.price) ||
          (level.type === 'support' && periodLow <= level.price);
        
        if (wasTriggered) {
          triggeredLevels.push(level);
        }
      }

      if (triggeredLevels.length > 0) {
        this.currentTriggeredLevels = triggeredLevels;
        const levelStr = triggeredLevels.map(l => `$${l.price}(${l.label})`).join(', ');
        console.log(`[🔍警报检查] [API] OKX获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发价位: ${levelStr} | 触发: true | [来源] 04-29 09:30早间日报#3: "压缩三角形即将突破，MACD柱加速恶化至-333。止损$76,650，止盈$74,997/$73,937"`);
        return true;
      }

      console.log(`[🔍警报检查] [API] OKX获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发: false`);
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
      let lsRatio = null;
      let takerData = null;
      try {
        oiData = await api.getOKXOpenInterest();
        lsRatio = await api.getOKXLongShortRatio();
        takerData = await api.getOKXTakerRatio();
      } catch (e) {
        console.log('[数据收集] OKX扩展数据获取失败，继续使用基础数据');
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
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
        openInterest: oiData?.currentOI,
        oiChange24h: oiData?.change24h,
        longShortRatio: lsRatio?.currentRatio,
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
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天（跨日报周期）
  }
};
