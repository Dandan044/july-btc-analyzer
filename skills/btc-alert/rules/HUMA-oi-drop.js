/**
 * HUMA 持仓量异动警报
 * 监控OI大幅下降（多头恐慌平仓信号）
 *
 * 来源：alt-report-HUMA-2026-05-13-0138.md
 * 报告观点：OI未减是核心积极信号，若OI大幅下降则回调可能加速
 * 触发条件：4H OI较前4H下降超过5%
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const OI_DROP_THRESHOLD = 0.05; // OI下降5%触发

module.exports = {
  name: 'HUMA-OI异动警报',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取OI历史数据（4H级别，取2个数据点比较）
      const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=HUMA&period=1D';
      const data = await api.fetch(url);

      if (!data || !data.data || data.data.length < 2) {
        console.log(`[🔍警报检查] [API] OKX获取HUMA OI数据 | [进度] ${this.name} | 数据不足，跳过`);
        return false;
      }

      // 取最近两个4H数据点
      const latest = data.data[0];
      const previous = data.data[1];

      const latestOI = parseFloat(latest[1]); // OI
      const previousOI = parseFloat(previous[1]);

      const oiChange = (latestOI - previousOI) / previousOI;

      console.log(`[🔍警报检查] [API] OKX获取HUMA OI数据 | [进度] ${this.name} | 当前OI: ${latestOI.toFixed(0)} | 前值OI: ${previousOI.toFixed(0)} | 变化: ${(oiChange * 100).toFixed(2)}% | 触发: ${oiChange <= -OI_DROP_THRESHOLD}`);

      // OI大幅下降触发
      return oiChange <= -OI_DROP_THRESHOLD;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('HUMA', 'SWAP');
      const klines1h = await api.getOKXKlines('HUMA', '1h', 4, 'SWAP');

      let oiData = null, takerData = null, lsData = null;
      try {
        oiData = await api.getOKXOpenInterest('HUMA');
        takerData = await api.getOKXTakerRatio('HUMA');
        lsData = await api.getOKXLongShortRatio('HUMA');
      } catch (e) { /* 静默 */ }

      const currentPrice = parseFloat(ticker.last);

      return {
        coin: 'HUMA',
        alertTime: new Date().toISOString(),
        currentPrice: currentPrice,
        openInterest: oiData,
        takerRatio: takerData,
        longShortRatio: lsData,
        klines1h: klines1h.map(k => ({
          time: new Date(parseFloat(k[0])).toISOString(),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        })),
        alertType: 'OI异动',
        thresholds: { oiDropPct: OI_DROP_THRESHOLD * 100 },
        significance: 'OI大幅下降，多头可能恐慌平仓，回调可能加速'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-HUMA-oi-${Date.now()}`;
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

    console.log(`[HUMA OI警报触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};