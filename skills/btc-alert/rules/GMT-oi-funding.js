/**
 * GMT 非价格警报：OI变化 + Taker买卖比监控
 * 监控持仓量变化和主动买卖倾向，作为做空仓位健康度指标
 *
 * 来源：alt-GMT-20260512-0705/reports/alt-report-GMT-2026-05-12-0817.md
 * 报告观点：逼空行情已结束，OI从611K降至553K（-9.5%）确认资金撤退。
 *           当前做空仓位，需监控：OI若回升至600K+则可能逼空重启；
 *           Taker买卖比若持续>1.5则主动买盘回归，做空风险增大。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'GMT';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000;

// 基准OI（从最新报告获取，开仓时OI约553K）
const BASELINE_OI = 553000;
const OI_INCREASE_THRESHOLD = 0.10; // OI回升10%触发（约608K）
const TAKER_BUY_THRESHOLD = 1.5; // Taker买卖比>1.5触发（主动买盘回归）

module.exports = {
  name: 'GMT-OI回升与Taker买卖比异常',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取1H K线数据（含OI和Taker比）
      const klines = await api.getOKXKlines(COIN + '-USDT-SWAP', '1H', 3, 'SWAP');
      if (!klines || klines.length < 1) return false;

      const latest = klines[0];
      const currentOi = parseFloat(latest.openInterest || latest.oi || 0);
      const takerRatio = parseFloat(latest.takerBuyVol ? 
        (parseFloat(latest.takerBuyVol) / parseFloat(latest.takerSellVol || 1)) : 0);

      // 检查OI回升
      if (currentOi > 0 && BASELINE_OI > 0) {
        const oiChange = (currentOi - BASELINE_OI) / BASELINE_OI;
        if (oiChange > OI_INCREASE_THRESHOLD) {
          return true;
        }
      }

      // 检查Taker买卖比
      if (takerRatio > TAKER_BUY_THRESHOLD) {
        return true;
      }

    } catch (e) {
      console.error(`[${COIN}-oi-funding] check error:`, e.message);
    }
    return false;
  },

  async collect() {
    const klines = await api.getOKXKlines(COIN + '-USDT-SWAP', '1H', 3, 'SWAP');
    const ticker = await api.getOKXTicker(COIN, 'SWAP');

    const latest = klines[0];
    const currentOi = parseFloat(latest.openInterest || latest.oi || 0);
    const takerRatio = parseFloat(latest.takerBuyVol ? 
      (parseFloat(latest.takerBuyVol) / parseFloat(latest.takerSellVol || 1)) : 0);

    const oiChange = currentOi > 0 && BASELINE_OI > 0 
      ? ((currentOi - BASELINE_OI) / BASELINE_OI * 100).toFixed(1) : 'N/A';

    const triggers = [];
    if (currentOi > BASELINE_OI * (1 + OI_INCREASE_THRESHOLD)) {
      triggers.push(`OI回升至${currentOi.toFixed(0)}（+${oiChange}%），可能逼空重启`);
    }
    if (takerRatio > TAKER_BUY_THRESHOLD) {
      triggers.push(`Taker买卖比${takerRatio.toFixed(2)}，主动买盘回归`);
    }

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      currentPrice: ticker ? parseFloat(ticker.last) : 0,
      currentOi,
      baselineOi: BASELINE_OI,
      oiChangePercent: oiChange,
      takerRatio: takerRatio.toFixed(2),
      alertType: '非价格触发',
      significance: triggers.join('；')
    };
  },

  async trigger(alert) {
    const alertJson = JSON.stringify(alert);
    const taskMessage = `[SPAWN_INSTANT_ANALYSIS]${alertJson}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const child = spawn('openclaw', [
      'sessions', 'spawn',
      '--agent', 'july',
      '--mode', 'run',
      '--task', taskMessage
    ], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    console.log(`[${COIN}-oi-funding] 🚀 已触发即时分析: ${alert.significance}`);
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
