const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'EIGEN';
const CREATED_DATE = '2026-05-11';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// OI变化警报：监控持仓量快速变化（4H布林带极窄变盘在即）
// 更新于 2026-05-12 14:39 即时分析：4H 23.6%Fib$0.2195被触及
// OI从5/9的149.4万降至当前128万(-14.2%)，但1H OI在反弹中增加3.2%
// 4H布林带带宽7.86%(极窄)——变盘在即，方向未定
// 1H OI增加=新资金入场做多(假突破风险)，OI大幅反转=方向选择加速
// 偏空回测概率55%，假突破概率45%——$0.22是生死线
// TP1 $0.210距$0.2194仅4.3%
const OI_INCREASE_THRESHOLD = 0.15; // OI增加15%触发
const OI_DECREASE_THRESHOLD = 0.20; // OI减少20%触发

let lastOI = null;

module.exports = {
  name: 'EIGEN-oi-change',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      if (!ticker || !ticker.price) return false;

      const oiUrl = `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=1D`;
      const oiData = await api.fetch(oiUrl);
      if (!oiData || oiData.code !== '0' || !oiData.data || oiData.data.length === 0) return false;

      const currentOI = parseFloat(oiData.data[0][1]);
      const currentPrice = ticker.price;

      if (lastOI !== null) {
        const oiChange = (currentOI - lastOI) / lastOI;

        if (Math.abs(oiChange) >= OI_INCREASE_THRESHOLD) {
          this._triggerInfo = oiChange > 0
            ? [`📈 OI大幅增加 ${(oiChange * 100).toFixed(1)}% (新资金入场，收敛三角形可能向上突破)`, `当前OI: ${currentOI}`, `价格: $${currentPrice}`]
            : [`📉 OI大幅减少 ${(Math.abs(oiChange) * 100).toFixed(1)}% (大规模平仓，方向选择加速)`, `当前OI: ${currentOI}`, `价格: $${currentPrice}`];
          lastOI = currentOI;
          return true;
        }
      }

      lastOI = currentOI;

      console.log(`[🔍警报检查] [API] OKX Rubik OI | [进度] EIGEN OI监控 | 当前OI: ${currentOI} | 价格: $${currentPrice} | 触发: false | [来源] 05-12 14:39即时分析: "4H BB极窄7.86%变盘在即,1H OI增加3.2%(新资金入场),偏空回测55%/假突破45%,$0.22生死线"`);
      return false;
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
        alertType: 'oi-change',
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
    const jobName = `alert-EIGEN-oi-${Date.now()}`;
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