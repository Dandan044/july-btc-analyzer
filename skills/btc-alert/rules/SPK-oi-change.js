const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'SPK';
const CREATED_DATE = '2026-05-11';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// OI 急剧变化警报：OI 从近期高点下降超过30% 或 上升超过30%
const OI_CHANGE_THRESHOLD = 0.30; // 30% 变化
const OI_BASELINE = 2281053; // 当前OI（2026-05-11即时分析数据）

module.exports = {
  name: 'SPK-OI持仓量异动',
  interval: 15 * 60 * 1000, // 15分钟
  lastTriggered: 0,
  prevOI: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const PROXY = 'http://127.0.0.1:7890';
      const oiResp = await api.fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=1D`);

      if (!oiResp || !oiResp.data || oiResp.data.length === 0) {
        console.log(`[🔍警报检查] [API] OKX获取${COIN} OI数据(SWAP) | [进度] ${this.name} | 数据为空 | 触发: false | [来源] 05-11 SPK首分析: "OI从3.21M持续下降至2.28M，降幅29%，资金在撤离"`);
        return false;
      }

      // 获取最新OI值
      const latestOI = parseFloat(oiResp.data[0][1]); // [timestamp, oi, volume]
      const oiChange = (latestOI - OI_BASELINE) / OI_BASELINE;
      const triggered = Math.abs(oiChange) >= OI_CHANGE_THRESHOLD;
      const direction = oiChange > 0 ? '增加' : '减少';

      console.log(`[🔍警报检查] [API] OKX获取${COIN} OI数据(SWAP) | [进度] ${this.name} | 当前OI: ${latestOI.toFixed(0)} | 基线: ${OI_BASELINE} | 变化: ${(oiChange * 100).toFixed(1)}% | 阈值: ±${OI_CHANGE_THRESHOLD * 100}% | 触发: ${triggered} | [来源] 05-11 SPK首分析: "OI持续下降是资金撤离信号，若OI反弹则可能形成底部"`);

      if (triggered) {
        this.prevOI = latestOI;
        return true;
      }

      this.prevOI = latestOI;
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4H', 3, 'SWAP');

      let lsData = null, takerData = null;
      try {
        lsData = await api.fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${COIN}&period=1D`);
        takerData = await api.fetch(`https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1D`);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker?.price || null,
        oiBaseline: OI_BASELINE,
        currentOI: this.prevOI,
        oiChangePct: this.prevOI ? ((this.prevOI - OI_BASELINE) / OI_BASELINE * 100).toFixed(1) : null,
        longShortRatio: lsData,
        takerRatio: takerData,
        klines4h: klines4h?.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: 'OI持仓量异动',
        significance: `OI较基线${this.prevOI > OI_BASELINE ? '增加' : '减少'}${Math.abs((this.prevOI - OI_BASELINE) / OI_BASELINE * 100).toFixed(1)}%`
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

    console.log(`[${COIN}警报触发] OI异动 | 已派发即时分析任务: ${jobName}`);
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
