/**
 * W (Wormhole) 资金费率异常警报
 * 
 * 来源: alt-report-W-2026-05-12-0643.md（即时分析）
 * 报告观点: 资金费率微正(+0.00005)，多空分歧仍在。极端资金费率预示方向性压力
 * 当前持仓: 做空1910张
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'W';
const INST_ID = 'W-USDT-SWAP';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 冷却2小时

// 资金费率阈值
const FUNDING_THRESHOLD = 0.001; // |funding rate| >= 0.1% 视为异常

module.exports = {
  name: 'W-资金费率异常监控',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const fundingData = await api.getOKXFundingRate(COIN);
      const fundingRate = parseFloat(fundingData?.fundingRate || '0');

      const isExtreme = Math.abs(fundingRate) >= FUNDING_THRESHOLD;
      const direction = fundingRate > 0 ? '多头付费' : '空头付费';

      console.log(`[🔍警报检查] [API] OKX获取W资金费率 | [进度] ${this.name} | 当前费率: ${fundingRate.toFixed(6)} (${direction}) | 阈值: ±${FUNDING_THRESHOLD} | 触发: ${isExtreme} | [来源] alt-report-W-2026-05-12: "资金费率微正，极端值预示方向性压力"`);

      return isExtreme;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines = await api.getOKXKlines(COIN, '4h', 6, 'SWAP');
      const fundingData = await api.getOKXFundingRate(COIN);
      const fundingRate = parseFloat(fundingData?.fundingRate || '0');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        fundingRate: fundingRate,
        fundingDirection: fundingRate > 0 ? '多头付费给空头' : '空头付费给多头',
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        recentKlines: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close
        })),
        alertType: '资金费率异常警报',
        significance: `W资金费率${fundingRate > 0 ? '正' : '负'}值极端(${fundingRate.toFixed(6)})，${fundingRate > 0 ? '多头压力过大可能逼空' : '空头压力过大可能反弹'}`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-funding-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${COIN}警报触发] 资金费率异常 → 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // ⭐ 触发后即归档（引擎自动移动到 rules-archive/，不会删除文件）
    if (this.lastTriggered > 0) return 'completed';

    // 保底：超过 3 天未触发也归档（过期）
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};