/**
 * ORDI 持仓量(OI)异动警报
 * 监控 OI 快速增加或减少，捕捉资金进出信号
 *
 * 来源: alt-report-ORDI-2026-05-13-2050.md
 * 报告观点: "OI从$33.8M降至$33.4M，加速下降，市场在加速去杠杆。
 *           如果OI从下降转为增加+价格站回$4.956，说明新资金入场，可能预示反转"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ORDI';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// OI 基准值（从报告数据获取，当前约 $33.4M）
const OI_BASELINE = 33400000;
// OI 增加 30% 以上触发（说明新资金大量入场）
const OI_SURGE_THRESHOLD = 1.30;
// OI 减少 30% 以上触发（说明资金大量撤离）
const OI_DRAIN_THRESHOLD = 0.70;

module.exports = {
  name: 'ORDI-OI异动监控',
  interval: 5 * 60 * 1000, // 5分钟检查一次（OI变化较慢）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const currentOI = oiData.currentOI;
      // OI 值需要乘以价格得到 USDT 价值
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const oiValue = currentOI * ticker.price;
      const oiRatio = oiValue / OI_BASELINE;

      const isSurge = oiRatio >= OI_SURGE_THRESHOLD;
      const isDrain = oiRatio <= OI_DRAIN_THRESHOLD;
      const triggered = isSurge || isDrain;

      const direction = isSurge ? '激增' : (isDrain ? '骤降' : '正常');
      const changePct = ((oiRatio - 1) * 100).toFixed(1);

      console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量数据 | [进度] ${this.name} | OI: $${(oiValue/1e6).toFixed(1)}M | 基准: $${(OI_BASELINE/1e6).toFixed(1)}M | 变化: ${changePct}% | 方向: ${direction} | 触发: ${triggered} | [来源] 05-12 ORDI报告: "OI下降33%投机资金撤退，OI增加是新资金入场信号"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const oiData = await api.getOKXOpenInterest(COIN);
      const klines4h = await api.getOKXKlines(COIN, '4h', 6, 'SWAP');

      let takerData = null, lsData = null, frData = null;
      try { takerData = await api.getOKXTakerRatio(COIN); } catch (e) { /* 静默 */ }
      try { lsData = await api.getOKXLongShortRatio(COIN); } catch (e) { /* 静默 */ }
      try { frData = await api.getOKXFundingRate(COIN); } catch (e) { /* 静默 */ }

      const oiValue = oiData.currentOI * ticker.price;
      const oiRatio = oiValue / OI_BASELINE;
      const direction = oiRatio >= OI_SURGE_THRESHOLD ? 'surge' : 'drain';

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: `OI${direction === 'surge' ? '激增' : '骤降'}`,
        oiValue: oiValue,
        oiBaseline: OI_BASELINE,
        oiChangePct: ((oiRatio - 1) * 100).toFixed(1),
        oiDirection: direction,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        takerBuyRatio: takerData?.currentRatio,
        longShortRatio: lsData?.currentRatio,
        fundingRate: frData?.fundingRate,
        significance: direction === 'surge'
          ? `OI激增${((oiRatio-1)*100).toFixed(0)}%至$${(oiValue/1e6).toFixed(1)}M，新资金大量入场`
          : `OI骤降${((1-oiRatio)*100).toFixed(0)}%至$${(oiValue/1e6).toFixed(1)}M，资金大量撤离`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-oi-${Date.now()}`;
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

    console.log(`[${COIN}警报触发] OI异动警报已派发即时分析任务: ${jobName} | 方向: ${alertData.oiDirection} | 变化: ${alertData.oiChangePct}%`);

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
