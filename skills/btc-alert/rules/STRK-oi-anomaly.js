/**
 * STRK 持仓量异动警报
 * 监控OI剧烈变化，预警趋势加速或反转
 *
 * 来源：alt-report-STRK-2026-05-11-1218.md
 * 报告观点："OI从$263.9K峰值降至$168.9K(-36%)，多头清算$3.7M vs 空头清算$378K，多头被大量清洗"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-11';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

const COIN = 'STRK';

// OI变化阈值：1小时内变化超过30%
const OI_CHANGE_THRESHOLD = 0.30;

module.exports = {
  name: 'STRK-OI异动警报',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  // 上次OI值记录
  lastOIValue: null,
  lastOITime: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 使用OKX公开API获取OI数据
      const data = await api.fetch('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=STRK-USDT-SWAP');
      if (!data || !data.data || data.data.length === 0) return false;

      const currentOI = parseFloat(data.data[0].oiUsd || 0);
      if (currentOI === 0) return false;

      // 与上次记录的OI比较
      if (!this.lastOIValue || !this.lastOITime) {
        this.lastOIValue = currentOI;
        this.lastOITime = Date.now();
        console.log(`[🔍警报检查] [API] OKX获取STRK持仓量 | [进度] ${this.name} | 当前OI: $${(currentOI/1000).toFixed(1)}K | 基准已设置 | 触发: false | [来源] 05-11 STRK分析: "OI从$263.9K降至$168.9K(-36%)，若OI异动可能预示新趋势"`);
        return false;
      }

      const oiChange = Math.abs((currentOI - this.lastOIValue) / this.lastOIValue);
      const triggered = oiChange >= OI_CHANGE_THRESHOLD;

      const direction = currentOI > this.lastOIValue ? '增加' : '减少';
      console.log(`[🔍警报检查] [API] OKX获取STRK持仓量 | [进度] ${this.name} | 当前OI: $${(currentOI/1000).toFixed(1)}K | 基准: $${(this.lastOIValue/1000).toFixed(1)}K | 变化: ${(oiChange*100).toFixed(1)}% ${direction} | 阈值: ${(OI_CHANGE_THRESHOLD*100).toFixed(0)}% | 触发: ${triggered} | [来源] 05-11 STRK分析: "OI从$263.9K降至$168.9K(-36%)，若OI异动可能预示新趋势"`);

      // 更新基准（每次检查都更新，追踪渐进变化）
      this.lastOIValue = currentOI;
      this.lastOITime = Date.now();

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker(COIN);
      const klines1h = await api.getKlines(COIN, '1H', 6);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        oiChange: this.lastOIValue ? {
          currentOI: this.lastOIValue,
          threshold: OI_CHANGE_THRESHOLD
        } : null,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines1h: klines1h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: 'OI异动警报',
        significance: 'STRK持仓量1小时内变化超过30%，可能预示趋势加速或反转'
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

    console.log(`[${COIN}警报触发] OI异动警报已派发即时分析任务: ${jobName}`);
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
