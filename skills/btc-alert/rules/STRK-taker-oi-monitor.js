/**
 * STRK Taker买卖比 + OI 非价格监控警报
 * 监控Taker买卖比过低（卖出加剧）和OI稳定（企稳信号）
 * 
 * 来源：alt-report-STRK-2026-05-08-2135.md
 * 当前状态：挤压结束后冷却期，Taker振荡<1.0，OI从4.92M↓4.24M持续下降
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'STRK';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: 'STRK Taker-OI非价格监控',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,
  triggerData: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 并行获取 Taker、OI、Ticker 数据
      const [takerData, oiData, ticker] = await Promise.all([
        api.getOKXTakerRatio(COIN),
        api.getOKXOpenInterest(COIN),
        api.getOKXTicker(COIN, 'SWAP')
      ]);

      const takerRatio = takerData.currentRatio;
      const openInterest = oiData.currentOI;
      const oiChangePercent = oiData.change24h;
      const lastPrice = ticker.price;

      let triggered = false;

      console.log(`[🔍非价格检查] [API] OKX获取${COIN} Taker/OI数据 | ${this.name} | Taker: ${takerRatio.toFixed(4)} | OI: ${openInterest.toFixed(0)} | 24h变化: ${oiChangePercent.toFixed(2)}%`);

      // 条件1: Taker 买卖比过低 (< 0.85) = 卖出加剧
      if (takerRatio > 0 && takerRatio < 0.85) {
        this.triggerData = {
          coin: COIN,
          alertType: 'Taker极端卖出',
          type: 'taker_extreme_low',
          currentValue: takerRatio,
          threshold: 0.85,
          description: `Taker买卖比 ${takerRatio.toFixed(4)} < 0.85，卖出极端加剧，可能出现加速下跌`,
          currentPrice: lastPrice
        };
        triggered = true;
      }

      // 条件2: OI 企稳在 4M+（降幅 < 5%）
      if (!triggered && openInterest > 0 && openInterest >= 4000000 &&
          oiChangePercent > -5 && oiChangePercent < 5) {
        this.triggerData = {
          coin: COIN,
          alertType: 'OI企稳信号',
          type: 'oi_stabilizing',
          currentValue: openInterest,
          oiChangePercent: oiChangePercent,
          description: `OI 稳定在 ${openInterest.toFixed(0)} 附近（24h变化 ${oiChangePercent.toFixed(2)}%），资金流出企稳，可能形成底部`,
          currentPrice: lastPrice
        };
        triggered = true;
      }

      if (triggered) {
        return true;
      }

      this.triggerData = null;
      return false;
    } catch (error) {
      console.error('[❌非价格警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const [takerData, oiData, ticker] = await Promise.all([
        api.getOKXTakerRatio(COIN),
        api.getOKXOpenInterest(COIN),
        api.getOKXTicker(COIN, 'SWAP')
      ]);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        ...this.triggerData,
        takerBuySellRatio: takerData.currentRatio,
        openInterest: oiData.currentOI,
        oiChangePercent: oiData.change24h,
        currentPrice: ticker.price
      };
    } catch (error) {
      console.error('[❌非价格数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-STRK-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[STRK非价格警报触发] 已派发即时分析任务: ${jobName} | 类型: ${data.type} | 值: ${data.currentValue}`);

    this.lastTriggered = Date.now();
    this.triggerData = null;
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 4 ? 'active' : 'expired';
  }
};
