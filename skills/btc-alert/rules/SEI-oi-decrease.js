/**
 * SEI 持仓量(OI)减少警报
 * 
 * 来源: alt-report-SEI-2026-05-13-0142.md (即时分析)
 * 报告观点: "OI持续增加+价格下跌=空头加仓推跌。但报告观察条件指出：
 *           OI从2.33M开始减少+价格下跌→空头获利了结，趋势可能接近尾声。
 *           监控OI减少是判断空头趋势是否即将结束的关键信号。"
 * 
 * 监控逻辑: OI从近期峰值下降超过15%，说明空头正在获利离场，
 *           趋势可能接近尾声，需要评估止盈或调整策略
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'SEI';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却（非价格警报）
const OI_DROP_THRESHOLD = 15; // OI从峰值下降15%触发

module.exports = {
  name: 'SEI-OI减少',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,
  peakOI: null, // 记录OI峰值

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      if (!oiData || !oiData.currentOI) {
        console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | OI数据不可用 | 触发: false`);
        return false;
      }

      const currentOI = oiData.currentOI;

      // 更新峰值
      if (this.peakOI === null || currentOI > this.peakOI) {
        this.peakOI = currentOI;
      }

      // 计算从峰值的下降百分比
      const dropPct = ((this.peakOI - currentOI) / this.peakOI * 100);
      const triggered = dropPct >= OI_DROP_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | 当前OI: ${currentOI.toFixed(0)} | 峰值OI: ${this.peakOI.toFixed(0)} | 下降: ${dropPct.toFixed(1)}% | 阈值: ${OI_DROP_THRESHOLD}% | 触发: ${triggered} | [来源] 05-13 SEI即时分析: "OI减少+价格下跌→空头获利了结信号"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 6, 'SWAP');
      const oiData = await api.getOKXOpenInterest(COIN);
      
      let takerData = null, fundingData = null;
      try {
        takerData = await api.getOKXTakerRatio(COIN);
        fundingData = await api.getOKXFundingRate(COIN);
      } catch (e) { /* 静默 */ }

      const currentOI = oiData.currentOI;
      const dropPct = ((this.peakOI - currentOI) / this.peakOI * 100);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: '持仓量减少',
        oiData: {
          currentOI: currentOI,
          peakOI: this.peakOI,
          dropPct: dropPct.toFixed(1),
          threshold: OI_DROP_THRESHOLD,
          change24h: oiData.change24h
        },
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        takerBuyRatio: takerData?.currentRatio,
        fundingRate: fundingData?.current,
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        significance: `OI从峰值${this.peakOI.toFixed(0)}降至${currentOI.toFixed(0)}（-${dropPct.toFixed(1)}%），空头获利了结信号，趋势可能接近尾声`
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

    console.log(`[${COIN}警报触发] OI减少警报已派发即时分析任务: ${jobName}`);
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