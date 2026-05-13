/**
 * MOVE OI 快速增长警报
 * 监控 OI 短时间内大幅增长（空头增仓信号）
 * 当前 OI 已从 1.40M 暴增至 2.23M（+59.47%），若继续增长或再次暴增，确认空头加码
 *
 * 来源：alt-report-MOVE-2026-05-13-0006.md
 * 报告观点："OI 24H暴增59%是本轮最重要的信号——大量新资金在主动建立空头头寸"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'MOVE';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// OI 增长阈值：24H内增长超过50%视为空头快速增仓
const OI_GROWTH_THRESHOLD = 0.50;

module.exports = {
  name: 'MOVE-OI快速增长',
  interval: 5 * 60 * 1000, // 5分钟
  lastTriggered: 0,
  lastOI: null,
  baselineOI: null, // 基准OI（首次记录时设置）

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const oi = await api.getOKXOpenInterest(COIN);
      if (!oi || !oi.currentOI) return false;

      const currentOI = oi.currentOI;

      // 设置基准OI
      if (this.baselineOI === null) {
        this.baselineOI = currentOI;
        this.lastOI = currentOI;
        console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量数据 | [进度] ${this.name} | 基准OI设置: ${currentOI.toFixed(0)}张 | 触发: false | [来源] 05-13 MOVE即时分析: "OI暴增59%说明空头在主动增仓"`);
        return false;
      }

      // 计算24H增长（从基准到当前）
      const growthFromBaseline = (currentOI - this.baselineOI) / this.baselineOI;
      const triggered = growthFromBaseline >= OI_GROWTH_THRESHOLD;

      // 更新lastOI
      this.lastOI = currentOI;

      console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量数据 | [进度] ${this.name} | 当前OI: ${currentOI.toFixed(0)}张 | 基准OI: ${this.baselineOI.toFixed(0)}张 | 增长: ${(growthFromBaseline * 100).toFixed(1)}% | 阈值: 50% | 触发: ${triggered} | [来源] 05-13 MOVE即时分析: "OI暴增59%说明空头在主动增仓，若继续增长确认偏空加速"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const oi = await api.getOKXOpenInterest(COIN);
      const klines1h = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'oi-rapid-growth',
        currentPrice: ticker.price,
        currentOI: oi.currentOI,
        baselineOI: this.baselineOI,
        growthFromBaseline: ((oi.currentOI - this.baselineOI) / this.baselineOI).toFixed(4),
        klines1h: klines1h ? klines1h.slice(0, 3) : null
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-MOVE-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}
以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    this.lastTriggered = Date.now();
    console.log(`[🔔警报触发] ${this.name} | 当前OI: ${data.currentOI}张 | 增长: ${(data.growthFromBaseline * 100).toFixed(1)}% | 当前价: $${data.currentPrice}`);
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