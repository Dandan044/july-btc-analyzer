/**
 * 多价位监控警报
 * 基于 2026-04-29 11:50 日报设立
 * 监控6个关键价位，使用K线区间数据捕捉瞬时突破
 * 单次触发传递组合信息
 * 
 * 背景：BTC在$75,600-$77,100区间收敛震荡3日，布林带14日最窄
 * 多空信号矛盾（MACD死叉 vs Taker买盘持续），方向待选择
 * 操作：观望，等待区间突破确认
 * 
 * 来源：active/cycle-20260429-001/reports/btc-report-2026-04-29-1150.md
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-29';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// 多价位配置（6个，来自日报 四、行情推断-关键位置表 + 五、触发条件）
const PRICE_LEVELS = [
  // ⬆️ 上方阻力（3个）
  { price: 77100, type: 'resistance', label: '区间上沿/做多入场触发', action: '突破确认做多，需Taker>1.0+量能回升', priority: 'high' },
  { price: 77444, type: 'resistance', label: '04-28高点/突破确认', action: '第二道确认，上行空间打开', priority: 'medium' },
  { price: 79490, type: 'resistance', label: '14d次高/反弹遇阻做空位', action: '反弹至此处遇阻可做空', priority: 'medium' },
  // ⬇️ 下方支撑（3个）
  { price: 75855, type: 'support', label: '今日低点/第一支撑', action: '短期支撑测试，需观察是否守住', priority: 'high' },
  { price: 75600, type: 'support', label: '区间下沿/做空入场触发', action: '跌破确认做空，需Taker<0.9', priority: 'high' },
  { price: 74660, type: 'support', label: '14d最低点/深度支撑', action: '深度支撑，此处有大量多头清算聚集', priority: 'medium' }
];

module.exports = {
  name: '多价位监控警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  currentTriggeredLevels: [],
  triggeredHistory: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('BTC', '1m', 3);
      
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

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
        console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发价位: ${levelStr} | 触发: true | [来源] 04-29 11:50日报: "价格在$75,600-$77,100区间收敛震荡3日，布林带14日最窄，方向待选择，等待突破确认"`);
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
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}

以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/instant-analysis-stage1.md 执行数据获取
2. 读取 tasks/daily-report-stage2.md 执行技术分析
3. 读取 tasks/daily-report-stage3.md 执行仓位管理
4. 读取 tasks/daily-report-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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
    
    console.log(`[警报触发] 已派发即时分析全四阶段任务: ${jobName}，触发价位: ${data.triggeredLevels.length}个`);
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};
