/**
 * OI持仓量反转监测警报
 * 基于 2026-04-28 12:09 日报分析设立
 * 
 * 背景：合约持仓量从 Apr 23 峰值 3.764B 下降 12.3% 至 3.338B
 * 日报判断：OI与价格同步下行 = 多头平仓/去杠杆，非空头加仓
 * 若OI止跌回升 → 信号去杠杆结束、新资金入场，是重要的方向确认信号
 * 
 * 触发条件：OI 从滚动最低点回升 ≥ 3%
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-28';
const COOLDOWN_MS = 60 * 60 * 1000;  // 1小时冷却
const REVERSAL_THRESHOLD = 1.03;      // OI从最低点回升3%

module.exports = {
  name: 'OI持仓量反转监测',
  interval: 5 * 60 * 1000,  // 5分钟检查一次（OI是日级数据，无需高频）
  lastTriggered: 0,
  
  // 追踪OI最低点
  lowestOI: Infinity,
  
  // OI历史（防抖：需连续2次确认回升趋势）
  oiHistory: [],

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      const currentOI = oiData.currentOI;
      
      // 更新最低OI
      if (currentOI < this.lowestOI) {
        this.lowestOI = currentOI;
      }
      
      // 添加到历史（保留最近6个数据点用于趋势判断）
      this.oiHistory.push({ time: Date.now(), oi: currentOI });
      if (this.oiHistory.length > 6) {
        this.oiHistory.shift();
      }
      
      // 计算从最低点的回升比例
      const reversalRatio = currentOI / this.lowestOI;
      
      // 判断是否有回升趋势（最近3次检查中有2次OI上升）
      let uptrendConfirmed = false;
      if (this.oiHistory.length >= 3) {
        const recent = this.oiHistory.slice(-3);
        const ups = recent.filter((p, i) => i > 0 && p.oi > recent[i-1].oi).length;
        uptrendConfirmed = ups >= 2;
      }
      
      const triggered = reversalRatio >= REVERSAL_THRESHOLD && uptrendConfirmed;
      
      const ratioPercent = ((reversalRatio - 1) * 100).toFixed(2);
      const lowestOIB = (this.lowestOI / 1e9).toFixed(2);
      const currentOIB = (currentOI / 1e9).toFixed(2);
      
      console.log(`[🔍警报检查] [API] OKX获取BTC持仓量 | [进度] ${this.name} | 当前OI: $${currentOIB}B | 最低OI: $${lowestOIB}B | 回升: ${ratioPercent}% | 趋势确认: ${uptrendConfirmed} | 触发: ${triggered} | [来源] 04-28 12:09日报: "OI从3.764B峰值下降12.3%后企稳，若止跌回升信号去杠杆结束、新资金入场"`);
      
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const oiData = await api.getOKXOpenInterest();
      const klines = await api.getKlines('BTC', '1h', 4);
      let lsRatio = null;
      let takerData = null;
      try {
        lsRatio = await api.getOKXLongShortRatio();
        takerData = await api.getOKXTakerRatio();
      } catch (e) {
        console.log('[数据收集] OKX扩展数据获取失败，继续使用基础数据');
      }
      
      const lowestOIB = (this.lowestOI / 1e9).toFixed(2);
      const currentOIB = (oiData.currentOI / 1e9).toFixed(2);
      const reversalPercent = ((oiData.currentOI / this.lowestOI - 1) * 100).toFixed(2);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        openInterest: {
          current: oiData.currentOI,
          currentB: currentOIB,
          lowest: this.lowestOI,
          lowestB: lowestOIB,
          dropFromPeak: ((1 - oiData.currentOI / 3764000000) * 100).toFixed(1) + '%',  // 相对于3.764B峰值
          reversalFromLow: reversalPercent + '%',
          change24h: oiData.change24h + '%'
        },
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        longShortRatio: lsRatio?.currentRatio,
        takerBuyRatio: takerData?.currentRatio,
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'OI反转',
        significance: `OI从最低${lowestOIB}B回升${reversalPercent}%至${currentOIB}B，去杠杆周期可能结束，新资金正在入场。需结合价格方向判断多空意图。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-${Date.now()}`;
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

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}，OI回升至 ${data.openInterest.currentB}B`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};
