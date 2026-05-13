/**
 * 布林带挤压突破警报
 * 监控BTC布林带带宽从挤压状态突破（带宽从<10%扩大至>12%）
 * 布林带挤压通常预示1-3日内出现方向性突破
 *
 * 来源：2026-05-13 21:00日报
 * 报告观点：布林带带宽9.4%处于挤压状态（<10%），挤压后通常出现方向性突破
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却（非价格警报不需要太频繁触发）
const SQUEEZE_THRESHOLD = 10;   // 挤压阈值：带宽 < 10%
const BREAKOUT_THRESHOLD = 12;  // 突破阈值：带宽 > 12%

module.exports = {
  name: '布林带挤压突破警报',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,
  
  // 追踪状态
  wasSqueezed: false,       // 是否曾处于挤压状态
  squeezeStartTime: null,   // 挤压开始时间
  minBandwidth: null,       // 挤压期间最小带宽

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取4H K线计算布林带
      const klines = await api.getOKXKlines('BTC', '4h', 25);
      
      if (klines.length < 20) {
        console.log(`[🔍警报检查] [API] OKX获取BTC 4H K线${klines.length}根(不足20根) | [进度] ${this.name} | 数据不足 | 触发: false`);
        return false;
      }
      
      // 计算布林带
      const closes = klines.map(k => k.close);
      const last20 = closes.slice(-20);
      const sma = last20.reduce((a, b) => a + b, 0) / 20;
      const variance = last20.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / 20;
      const stddev = Math.sqrt(variance);
      const upper = sma + 2 * stddev;
      const lower = sma - 2 * stddev;
      const bandwidth = ((upper - lower) / sma) * 100;
      
      const latestPrice = closes[closes.length - 1];
      
      // 检测挤压→突破
      if (bandwidth < SQUEEZE_THRESHOLD) {
        if (!this.wasSqueezed) {
          this.wasSqueezed = true;
          this.squeezeStartTime = Date.now();
          this.minBandwidth = bandwidth;
        }
        this.minBandwidth = Math.min(this.minBandwidth, bandwidth);
        
        const squeezeMins = Math.floor((Date.now() - this.squeezeStartTime) / 60000);
        console.log(`[🔍警报检查] [API] OKX获取BTC 4H K线25根 | [进度] ${this.name} | 布林带带宽: ${bandwidth.toFixed(1)}% | 状态: 挤压中(已${squeezeMins}分钟) | 最小带宽: ${this.minBandwidth.toFixed(1)}% | 触发: false | [来源] 05-13 21:00日报: "布林带挤压9.4%预示方向性突破"`);
        return false;
      }
      
      // 带宽已脱离挤压
      if (this.wasSqueezed && bandwidth >= BREAKOUT_THRESHOLD) {
        // 从挤压突破！
        const squeezeMins = Math.floor((Date.now() - this.squeezeStartTime) / 60000);
        console.log(`[🔍警报检查] [API] OKX获取BTC 4H K线25根 | [进度] ${this.name} | 布林带带宽: ${bandwidth.toFixed(1)}% | 状态: 挤压突破! (挤压${squeezeMins}分钟, 最小${this.minBandwidth?.toFixed(1)}%) | 触发: true | [来源] 05-13 21:00日报: "布林带挤压9.4%预示方向性突破"`);
        return true;
      }
      
      // 带宽在挤压和突破之间
      if (this.wasSqueezed) {
        const squeezeMins = Math.floor((Date.now() - this.squeezeStartTime) / 60000);
        console.log(`[🔍警报检查] [API] OKX获取BTC 4H K线25根 | [进度] ${this.name} | 布林带带宽: ${bandwidth.toFixed(1)}% | 状态: 挤压缓解中(已${squeezeMins}分钟) | 触发: false`);
      } else {
        console.log(`[🔍警报检查] [API] OKX获取BTC 4H K线25根 | [进度] ${this.name} | 布林带带宽: ${bandwidth.toFixed(1)}% | 状态: 未挤压 | 触发: false`);
      }
      
      // 带宽回到正常范围，重置挤压状态
      if (bandwidth > SQUEEZE_THRESHOLD + 2) {
        this.wasSqueezed = false;
        this.squeezeStartTime = null;
        this.minBandwidth = null;
      }
      
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines4h = await api.getOKXKlines('BTC', '4h', 25);
      const klines1h = await api.getKlines('BTC', '1h', 6);
      
      // 计算当前布林带
      const closes = klines4h.map(k => k.close);
      const last20 = closes.slice(-20);
      const sma = last20.reduce((a, b) => a + b, 0) / 20;
      const variance = last20.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / 20;
      const stddev = Math.sqrt(variance);
      const bandwidth = ((4 * stddev) / sma) * 100;
      
      let oiData = null;
      try { oiData = await api.getOKXOpenInterest(); } catch (e) {}

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        bollingerBands: {
          middle: sma,
          upper: sma + 2 * stddev,
          lower: sma - 2 * stddev,
          bandwidth: bandwidth.toFixed(2),
          squeezeMinBandwidth: this.minBandwidth?.toFixed(2),
          squeezeDurationMs: this.squeezeStartTime ? Date.now() - this.squeezeStartTime : null
        },
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        openInterest: oiData?.currentOI,
        klines1h: klines1h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close
        })),
        alertType: '布林带挤压突破',
        significance: `布林带从挤压状态(最小带宽${this.minBandwidth?.toFixed(1)}%)突破至${bandwidth.toFixed(1)}%，方向性突破可能正在发生`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-bb-squeeze-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/instant-analysis-stage1.md 执行数据获取\n2. 读取 tasks/daily-report-stage2.md 执行技术分析\n3. 读取 tasks/daily-report-stage3.md 执行仓位管理\n4. 读取 tasks/daily-report-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[警报触发] 已派发即时分析任务: ${jobName} | 布林带挤压突破`);
    this.lastTriggered = Date.now();
    this.wasSqueezed = false;
    this.squeezeStartTime = null;
    this.minBandwidth = null;
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
