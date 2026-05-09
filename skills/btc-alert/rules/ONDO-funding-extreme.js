/**
 * ONDO 资金费率异常警报
 * 监控 ONDO-USDT-SWAP 资金费率极端值
 * 正值过高=多头过热，负值过低=空头恐慌/多单爆仓风险
 *
 * 来源：alt-ONDO-20260508-1904/reports/alt-report-ONDO-2026-05-08-1908.md
 * 报告观点：当前资金费率正常(${-0.00014})，需监控极端变化
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'ONDO';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000;

// 资金费率阈值（绝对值）
const FUNDING_HIGH_THRESHOLD = 0.001;   // 正值过高 — 多头过热信号
const FUNDING_LOW_THRESHOLD = -0.001;   // 负值过低 — 空头极端信号

module.exports = {
  name: 'ONDO-资金费率异常',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const fundingData = await api.getOKXFundingRate(COIN);
      const fundingRate = fundingData.fundingRate;
      const triggered = fundingRate >= FUNDING_HIGH_THRESHOLD || fundingRate <= FUNDING_LOW_THRESHOLD;
      
      const direction = fundingData.isLongPay ? '多头付费(多头过热)' : '空头付费(正常/偏空)';
      const severity = Math.abs(fundingRate) >= 0.005 ? '⚠️极端' : Math.abs(fundingRate) >= 0.001 ? '⚠️关注' : '正常';
      
      console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 当前费率: ${fundingRate.toFixed(8)}(${direction}) | 阈值: >${FUNDING_HIGH_THRESHOLD} / <${FUNDING_LOW_THRESHOLD} | 严重度: ${severity} | 触发: ${triggered} | [来源] 05-08 ONDO分析: "资金费率正常，监控极端变化"`);
      
      return triggered;
    } catch (error) {
      console.error('[❌ONDO资金费率检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      // 并行获取所有数据
      const [fundingData, ticker, klines, oiData] = await Promise.all([
        api.getOKXFundingRate(COIN),
        api.getOKXTicker(COIN, 'SWAP'),
        api.getOKXKlines(COIN, '15m', 4, 'SWAP'),
        api.getOKXOpenInterest(COIN).catch(() => null)
      ]);

      const fundingRate = fundingData.fundingRate;

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        fundingRate: fundingRate,
        fundingThresholds: {
          high: FUNDING_HIGH_THRESHOLD,
          low: FUNDING_LOW_THRESHOLD
        },
        fundingSignal: fundingRate >= FUNDING_HIGH_THRESHOLD 
          ? '多头过热，市场FOMO情绪，警惕回调' 
          : fundingRate <= FUNDING_LOW_THRESHOLD 
            ? '空头极端，可能存在多单爆仓压力' 
            : '正常范围',
        openInterest: oiData ? {
          current: oiData.currentOI,
          change24h: oiData.change24h
        } : null,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '资金费率异常'
      };
    } catch (error) {
      console.error('[❌ONDO资金费率收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-ONDO-funding-${Date.now()}`;
    const model = CONFIG.trigger.altcoin.model;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[ONDO资金费率警报] 已派发即时分析: ${jobName} | 费率: ${data.fundingRate}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
