/**
 * W (Wormhole) 持仓量异动警报
 * 
 * 来源: alt-report-W-2026-05-12-0643.md（即时分析）
 * 报告观点: OI从$24K降至$20.6K(降幅14%)，空头回补驱动反弹。OI反转增加可能预示新趋势力量
 * 当前持仓: 做空1910张
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'W';
const INST_ID = 'W-USDT-SWAP';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 冷却2小时（OI变化较慢）

// OI 24h变化阈值（百分比）
const OI_CHANGE_THRESHOLD = 30; // 24h内OI变化超过30%视为异常（降低阈值，因为当前OI在下降）

module.exports = {
  name: 'W-OI异动监控',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,
  baselineOI: null, // 基准OI值
  baselineTime: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      if (!oiData || !oiData.currentOI) {
        console.log(`[🔍警报检查] [API] OKX获取W持仓量 | 数据不可用 | 触发: false`);
        return false;
      }

      const currentOI = parseFloat(oiData.currentOI);

      // 设置基准
      if (!this.baselineOI) {
        this.baselineOI = currentOI;
        this.baselineTime = Date.now();
        console.log(`[🔍警报检查] [API] OKX获取W持仓量 | [进度] ${this.name} | 当前OI: $${(currentOI/1000).toFixed(1)}K | 基准已设置 | 触发: false | [来源] alt-report-W-2026-05-12: "OI降幅14%，反转增加预示新趋势力量"`);
        return false;
      }

      // 24小时后重置基准
      if (Date.now() - this.baselineTime > 24 * 60 * 60 * 1000) {
        this.baselineOI = currentOI;
        this.baselineTime = Date.now();
      }

      const changePercent = Math.abs((currentOI - this.baselineOI) / this.baselineOI * 100);
      const triggered = changePercent >= OI_CHANGE_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取W持仓量 | [进度] ${this.name} | 当前OI: $${(currentOI/1000).toFixed(1)}K | 基准: $${(this.baselineOI/1000).toFixed(1)}K | 变化: ${changePercent.toFixed(1)}% | 阈值: ${OI_CHANGE_THRESHOLD}% | 触发: ${triggered} | [来源] alt-report-W-2026-05-12: "OI反转增加预示新趋势力量"`);

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
      const klines = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        openInterest: {
          current: oiData?.currentOI,
          baseline: this.baselineOI,
          changePercent: this.baselineOI ? Math.abs((parseFloat(oiData?.currentOI || 0) - this.baselineOI) / this.baselineOI * 100).toFixed(1) : null
        },
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        recentKlines: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close
        })),
        alertType: 'OI异动警报',
        significance: `W持仓量24h变化超过${OI_CHANGE_THRESHOLD}%，可能预示逼空或趋势加速`
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

    console.log(`[${COIN}警报触发] OI异动 → 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
    this.baselineOI = null; // 重置基准
    this.baselineTime = null;
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