/**
 * 布林带带宽扩张警报（波动率突破）
 * 基于 2026-04-29 11:50 日报设立
 * 
 * 背景：布林带带宽（$8,147）为14日最小值，价格在$75,600-$77,100区间收敛震荡3日
 * 带宽压缩至极值后往往伴随方向性扩张，提前预警即可在突破初期获得信号
 * 
 * 触发逻辑：监控BB带宽（20日标准差×2），当带宽从压缩区扩张超过阈值时触发
 * 采用连续K线确认机制，避免单根K线噪音
 * 
 * 来源：active/cycle-20260429-001/reports/btc-report-2026-04-29-1150.md
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-29';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却（波动率突破不频繁）

// BB带宽扩张阈值：超过压缩期带宽120%视为突破
const BB_EXPANSION_RATIO = 1.20;
// 压缩期参考带宽（14日最小值）
const COMPRESSED_BANDWIDTH = 8147;

module.exports = {
  name: '布林带带宽扩张警报（波动率突破）',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取最近20根1小时K线计算BB带宽
      const klines = await api.getKlines('BTC', '1h', 20);
      
      if (klines.length < 20) {
        console.log('[🔍警报检查] [API] CryptoCompare获取BTC 1小时K线 | 数据不足，跳过');
        return false;
      }

      const closes = klines.map(k => k.close);
      
      // 计算20周期均值
      const sum = closes.reduce((a, b) => a + b, 0);
      const mean = sum / closes.length;
      
      // 计算20周期标准差
      const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / closes.length;
      const stdDev = Math.sqrt(variance);
      
      // 布林带宽度 = 2 × 标准差（上下轨距离的一半）
      const bbWidth = Math.round(2 * stdDev);
      
      // 扩张比率
      const expansionRatio = bbWidth / COMPRESSED_BANDWIDTH;
      
      // 检查最近3根K线是否连续扩张（避免单根噪音）
      const recentWidths = [];
      for (let i = 17; i >= 15; i--) {
        const subset = closes.slice(i, i + 5);
        const s = subset.reduce((a, b) => a + b, 0) / subset.length;
        const v = subset.reduce((sum, c) => sum + Math.pow(c - s, 2), 0) / subset.length;
        recentWidths.push(2 * Math.sqrt(v));
      }
      const expanding = recentWidths[0] < recentWidths[1] && recentWidths[1] < recentWidths[2];

      const currentPrice = closes[closes.length - 1];
      const triggered = expansionRatio >= BB_EXPANSION_RATIO && expanding;

      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 20根1H K线 | [进度] ${this.name} | BB带宽: $${bbWidth.toLocaleString()} | 压缩基准: $${COMPRESSED_BANDWIDTH.toLocaleString()} | 扩张率: ${(expansionRatio*100).toFixed(1)}% | 连续扩张: ${expanding} | 当前价: $${currentPrice.toFixed(0)} | 触发: ${triggered} | [来源] 04-29 11:50日报: "布林带带宽$8,147为14日最小值，带宽压缩至极值后往往伴随方向性扩张"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines1h = await api.getKlines('BTC', '1h', 20);
      const klines15m = await api.getKlines('BTC', '15m', 8);
      
      // 计算当前BB带宽
      const closes = klines1h.map(k => k.close);
      const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
      const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / closes.length;
      const stdDev = Math.sqrt(variance);
      const currentBandwidth = Math.round(2 * stdDev);
      const bandwidthChange = ((currentBandwidth / COMPRESSED_BANDWIDTH - 1) * 100).toFixed(1);
      
      // 判断突破方向
      const recentClose = closes[closes.length - 1];
      const prevClose = closes[closes.length - 2];
      const direction = recentClose > mean ? '向上突破' : (recentClose < mean ? '向下突破' : '震荡');
      
      let oiData = null;
      let takerData = null;
      try {
        oiData = await api.getOKXOpenInterest();
        takerData = await api.getOKXTakerRatio();
      } catch (e) {
        console.log('[数据收集] OKX扩展数据获取失败');
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        bbSignal: {
          currentBandwidth: currentBandwidth,
          compressedBaseline: COMPRESSED_BANDWIDTH,
          expansionRatio: `${bandwidthChange}%`,
          mean: Math.round(mean),
          stdDev: Math.round(stdDev),
          upperBand: Math.round(mean + 2 * stdDev),
          lowerBand: Math.round(mean - 2 * stdDev),
          breakoutDirection: direction
        },
        
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines1h: klines1h.slice(-6).map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close
        })),
        
        alertType: '波动率突破',
        significance: `布林带带宽从压缩区扩张${bandwidthChange}%（基准$COMPRESSED_BANDWIDTH），突破方向: ${direction}，可能启动方向性行情`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-bb-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}

以上为布林带波动率突破警报数据。请按顺序完成即时分析全四阶段：
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

    console.log(`[警报触发] 已派发布林带突破即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired'; // 有效期5天（波动率突破周期较长）
  }
};
