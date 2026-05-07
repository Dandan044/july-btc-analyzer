/**
 * NEAR 持仓量(OI)异动警报（非价格类）
 * 监控 OI 在4小时内的变化幅度，捕捉资金大幅撤离或涌入信号
 *
 * 来源：active/alt-NEAR-20260507-0204/reports/alt-report-NEAR-2026-05-07-0943.md
 * 报告背景：OI从14.3M→18.1M伴随价格上涨，若OI骤降则趋势可能反转
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'NEAR';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// 阈值配置
const THRESHOLDS = {
  oiDropPercent4h: 15,   // 4小时OI降幅超过15%触发
  oiSurgePercent4h: 30   // 4小时OI涨幅超过30%触发（异常涌入）
};

module.exports = {
  name: 'NEAR-持仓量异动监控',
  interval: 10 * 60 * 1000, // 10分钟
  lastTriggered: 0,
  lastOiValue: null,
  oiHistory: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest('NEAR');
      const currentOI = oiData?.currentOI;
      
      if (!currentOI || currentOI <= 0) {
        return false;
      }

      // 记录OI历史（保留4小时窗口）
      const now = Date.now();
      this.oiHistory.push({ time: now, oi: currentOI });
      this.oiHistory = this.oiHistory.filter(h => now - h.time < 4 * 60 * 60 * 1000);

      if (this.oiHistory.length < 2) {
        console.log(`[🔍NEAR OI监控] 初始OI: ${(currentOI/1e6).toFixed(2)}M | 积累历史数据中...`);
        return false;
      }

      const oldestOI = this.oiHistory[0].oi;
      const spanHours = (now - this.oiHistory[0].time) / (1000 * 60 * 60);
      const changePercent = ((currentOI - oldestOI) / oldestOI) * 100;
      const absChange = Math.abs(changePercent);

      const ticker = await api.getTicker('NEAR');
      
      console.log(`[🔍NEAR OI监控] OI: ${(oldestOI/1e6).toFixed(2)}M → ${(currentOI/1e6).toFixed(2)}M (${changePercent.toFixed(1)}%) | 时间跨度: ${spanHours.toFixed(1)}h | 当前价: $${ticker.price}`);

      // 只在历史数据足够时检查（至少1小时数据）
      if (spanHours < 1) {
        return false;
      }

      // OI大幅下降
      if (changePercent <= -THRESHOLDS.oiDropPercent4h) {
        this.triggerType = 'oi_drop';
        this.triggerDetail = `OI在${spanHours.toFixed(1)}小时内下降${absChange.toFixed(1)}%，持仓大幅撤离`;
        return true;
      }

      // OI异常涌入
      if (changePercent >= THRESHOLDS.oiSurgePercent4h) {
        this.triggerType = 'oi_surge';
        this.triggerDetail = `OI在${spanHours.toFixed(1)}小时内暴增${absChange.toFixed(1)}%，异常涌入`;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌NEAR OI监控错误]', error.message);
      return false; // 非关键，静默失败
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('NEAR');
      const klines15m = await api.getKlines('NEAR', '15m', 8);
      const oiData = await api.getOKXOpenInterest('NEAR');
      let takerData = null;
      try { takerData = await api.getOKXTakerRatio('NEAR'); } catch (e) {}

      const now = Date.now();
      const oldestOI = this.oiHistory[0]?.oi || oiData?.currentOI;
      const currentOI = oiData?.currentOI || 0;
      const spanHours = this.oiHistory.length > 1 ? 
        (now - this.oiHistory[0].time) / (1000 * 60 * 60) : 0;
      const changePercent = oldestOI > 0 ? ((currentOI - oldestOI) / oldestOI * 100) : 0;

      return {
        coin: 'NEAR',
        alertTime: new Date().toISOString(),
        alertType: '持仓量异动',
        alertSubtype: this.triggerType,
        
        currentPrice: ticker.price,
        oiData: {
          currentOI,
          oldestOI,
          spanHours: spanHours.toFixed(1),
          changePercent: changePercent.toFixed(2),
          detail: this.triggerDetail
        },
        
        takerBuyRatio: takerData?.currentRatio,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        significance: `NEAR OI${this.triggerType === 'oi_drop' ? '大幅下降' : '异常暴增'}: ${changePercent.toFixed(1)}% (${spanHours.toFixed(1)}h) → 需评估持仓是否需要调整`
      };
    } catch (error) {
      console.error('[❌NEAR OI数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-NEAR-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [