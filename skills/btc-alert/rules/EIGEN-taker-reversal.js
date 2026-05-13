const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'EIGEN';
const CREATED_DATE = '2026-05-11';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Taker买卖比反转警报
// 更新于 2026-05-12 14:39 即时分析：4H 23.6%Fib$0.2195被触及
// 4H Taker比0.661(卖压占优)，1H Taker比1.633(强买方)
// 4H布林带带宽7.86%(极窄)——变盘在即
// 偏空回测概率55%，假突破概率45%——$0.22是生死线
// Taker极端买压>1.5=做空风险(空头回补潮)，极端卖压<0.5=偏空加速确认
// Premium Index -0.185%(合约折价)，偏空信号持续
// TP1 $0.210距$0.2194仅4.3%
const TAKER_BUY_THRESHOLD = 1.5;   // Taker比>1.5 = 强买压回归（做空风险）
const TAKER_SELL_THRESHOLD = 0.5;  // Taker比<0.5 = 极端卖压（可能超卖反弹）

module.exports = {
  name: 'EIGEN-taker-reversal',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const takerUrl = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1D`;
      const takerData = await api.fetch(takerUrl);
      if (!takerData || takerData.code !== '0' || !takerData.data || takerData.data.length === 0) return false;

      const buyVol = parseFloat(takerData.data[0][1]);
      const sellVol = parseFloat(takerData.data[0][2]);
      const takerRatio = buyVol / sellVol;

      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const currentPrice = ticker?.price || 0;

      let triggered = false;
      let triggerInfo = [];

      if (takerRatio >= TAKER_BUY_THRESHOLD) {
        triggered = true;
        triggerInfo.push(`🔄 Taker买卖比反转至买压: ${takerRatio.toFixed(2)} (阈值>${TAKER_BUY_THRESHOLD})`, `买量: ${buyVol.toFixed(0)}, 卖量: ${sellVol.toFixed(0)}`, `价格: $${currentPrice}`);
      } else if (takerRatio <= TAKER_SELL_THRESHOLD) {
        triggered = true;
        triggerInfo.push(`⚠️ Taker买卖比极端卖压: ${takerRatio.toFixed(2)} (阈值<${TAKER_SELL_THRESHOLD})`, `买量: ${buyVol.toFixed(0)}, 卖量: ${sellVol.toFixed(0)}`, `价格: $${currentPrice}`);
      }

      if (!triggered) {
        console.log(`[🔍警报检查] [API] OKX Rubik Taker | [进度] EIGEN Taker比监控 | 当前Taker比: ${takerRatio.toFixed(2)} | 买: ${buyVol.toFixed(0)} 卖: ${sellVol.toFixed(0)} | 价格: $${currentPrice} | 触发: false | [来源] 05-12 14:39即时分析: "4H Taker比0.661(卖压),1H Taker比1.633(买方),4H BB极窄7.86%变盘在即,$0.22生死线"`);
      }

      if (triggered) {
        this._triggerInfo = triggerInfo;
      }
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      return false;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'taker-reversal',
        triggerInfo: this._triggerInfo || [],
        currentPrice: ticker?.price || 0,
        klines4h: klines4h?.slice(-3) || [],
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-EIGEN-taker-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}
以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理`;

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