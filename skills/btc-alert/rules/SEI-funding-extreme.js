/**
 * SEI 资金费率极端警报
 * 
 * 来源: alt-report-SEI-2026-05-12-0319.md (即时分析)
 * 报告观点: "资金费率持续为负→空头占据主动。但若费率极端负值（<-0.05%），
 *           说明空头过度拥挤，可能触发短挤，做空持仓面临风险。"
 * 
 * 监控逻辑: 资金费率连续2个4H周期低于-0.05%，说明空头过度，短挤风险上升
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'SEI';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却（非价格警报）
const FUNDING_THRESHOLD = -0.0005; // -0.05%
const CONSECUTIVE_REQUIRED = 2; // 连续2个4H周期

module.exports = {
  name: 'SEI-资金费率极端',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,
  
  consecutiveCount: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const fundingData = await api.getOKXFundingRate(COIN);
      if (!fundingData || fundingData.current === undefined) {
        console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 费率数据不可用 | 触发: false | [来源] 05-12 SEI即时分析: "费率持续为负，若极端负值则短挤风险"`);
        return false;
      }

      const currentFunding = parseFloat(fundingData.current);
      const isExtreme = currentFunding < FUNDING_THRESHOLD;

      if (isExtreme) {
        this.consecutiveCount++;
      } else {
        this.consecutiveCount = 0;
      }

      const triggered = this.consecutiveCount >= CONSECUTIVE_REQUIRED;

      console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 当前费率: ${currentFunding.toFixed(6)} | 阈值: ${FUNDING_THRESHOLD} | 连续极端: ${this.consecutiveCount}/${CONSECUTIVE_REQUIRED} | 触发: ${triggered} | [来源] 05-12 SEI即时分析: "费率持续为负，若极端负值(<-0.05%)则空头过度，短挤风险上升"`);

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
      
      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
        takerData = await api.getOKXTakerRatio(COIN);
      } catch (e) { /* 静默 */ }

      const fundingData = await api.getOKXFundingRate(COIN);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: '资金费率极端',
        fundingData: {
          current: fundingData?.current,
          nextFundingTime: fundingData?.nextFundingTime,
          consecutiveExtreme: this.consecutiveCount,
          threshold: FUNDING_THRESHOLD
        },
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        significance: `资金费率连续${this.consecutiveCount}个4H周期低于${(FUNDING_THRESHOLD*100).toFixed(2)}%，空头过度拥挤，短挤风险上升`
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[${COIN}警报触发] 资金费率极端警报已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
    this.consecutiveCount = 0;
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