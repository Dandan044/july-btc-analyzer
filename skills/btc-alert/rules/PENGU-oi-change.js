/**
 * PENGU 持仓量(OI)快速下降警报
 * 
 * 来源: alt-report-PENGU-2026-05-13-2020.md
 * 报告观点: "OI从8.71M降至5.70M，下降34.5%，5月17日解锁前后OI可能剧烈波动"
 * 用途: 监控OI快速变化，解锁前后可能出现空头回补或多头平仓潮
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// OI日降幅阈值（%）
const OI_DROP_THRESHOLD = 30;  // 日降幅超过30%触发
const OI_SPIKE_THRESHOLD = 50; // 日增幅超过50%也触发（可能预示变盘）

module.exports = {
  name: 'PENGU-OI快速变化监控',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,
  prevOI: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取OI历史数据（日线）
      const oiData = await api.getOKXOpenInterest('PENGU');
      if (!oiData || !oiData.currentOI) {
        console.log(`[🔍警报检查] [API] OKX获取PENGU OI数据失败 | [进度] ${this.name} | 数据不可用 | 触发: false | [来源] 05-13 山寨报告: "OI下降34.5%，解锁前后可能剧烈波动"`);
        return false;
      }

      const currentOI = parseFloat(oiData.currentOI);
      
      // 用K线获取更精确的OI变化
      const klines = await api.getKlines('PENGU', '1d', 2, 'SWAP');
      
      let oiChangePct = null;
      if (klines && klines.length >= 2) {
        const latestOI = klines[klines.length - 1].openInterest;
        const prevDayOI = klines[klines.length - 2].openInterest;
        if (latestOI && prevDayOI && prevDayOI > 0) {
          oiChangePct = ((latestOI - prevDayOI) / prevDayOI * 100);
        }
      }

      const triggered = oiChangePct !== null && 
        (Math.abs(oiChangePct) >= OI_DROP_THRESHOLD || oiChangePct >= OI_SPIKE_THRESHOLD);

      this.prevOI = currentOI;

      console.log(`[🔍警报检查] [API] OKX获取PENGU OI数据 | [进度] ${this.name} | OI变化: ${oiChangePct !== null ? oiChangePct.toFixed(1) + '%' : 'N/A'} | 阈值: 降幅>${OI_DROP_THRESHOLD}% 或 增幅>${OI_SPIKE_THRESHOLD}% | 触发: ${triggered} | [来源] 05-13 山寨报告: "OI下降34.5%，解锁前后可能剧烈波动"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('PENGU', 'SWAP');
      const klines4h = await api.getKlines('PENGU', '4h', 6, 'SWAP');
      const klines1d = await api.getKlines('PENGU', '1d', 3, 'SWAP');
      
      let takerData = null;
      try {
        takerData = await api.getOKXTakerRatio('PENGU');
      } catch (e) { /* 静默 */ }

      return {
        coin: 'PENGU',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: 'OI快速变化',
        
        oiData: klines1d.map(k => ({
          date: k.datetime,
          openInterest: k.openInterest,
          close: k.close,
          volume: k.volume
        })),
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        takerBuyRatio: takerData?.currentRatio,
        
        klines4h: klines4h.map(k => ({
          time: k.datetime, close: k.close, volume: k.volume,
          openInterest: k.openInterest
        }))
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-PENGU-oi-${Date.now()}`;
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[PENGU-OI警报触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
