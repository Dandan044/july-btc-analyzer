/**
 * JTO Taker买卖比警报
 * 监控JTO-USDT-SWAP的主动买卖力量对比
 * 触发条件：Taker买卖比持续 < 0.85（空头主导）或 > 1.5（多头激进）
 *
 * 来源：active/alt-JTO-20260507-0104/reports/alt-report-JTO-2026-05-07-0110.md
 * 报告观点：Taker比持续<0.85 → 买方乏力，趋势转弱信号
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'JTO';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000;
const COIN = 'JTO';
const PROXY_URL = 'http://127.0.0.1:7890';

const THRESHOLD_BEARISH = 0.85;  // Taker比 < 0.85 → 空头主导
const THRESHOLD_BULLISH = 1.5;   // Taker比 > 1.5 → 多头激进
const SUSTAINED_PERIODS = 3;     // 连续3个1H周期确认

module.exports = {
  name: 'JTO-Taker买卖比',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,
  sustainedCount: 0,
  sustainedDirection: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const url = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1H&limit=6`;
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, {
        encoding: 'utf8', timeout: 20000
      });
      const data = JSON.parse(result);

      if (data.code !== '0' || !data.data || data.data.length < SUSTAINED_PERIODS) {
        console.log(`[🔍JTO-Taker] 数据不足，跳过`);
        return false;
      }

      // 计算最近N个周期的Taker比
      const recentRatios = data.data.slice(0, SUSTAINED_PERIODS).map(d => {
        const buyVol = parseFloat(d[1]);
        const sellVol = parseFloat(d[2]);
        if (sellVol === 0) return 1;
        return buyVol / sellVol;
      });

      const avgRatio = recentRatios.reduce((a, b) => a + b, 0) / recentRatios.length;
      const latestRatio = recentRatios[0];

      console.log(`[🔍JTO-Taker] 最近${SUSTAINED_PERIODS}H Taker均比: ${avgRatio.toFixed(3)} | 最新: ${latestRatio.toFixed(3)} | 阈值: <${THRESHOLD_BEARISH}(空头) >${THRESHOLD_BULLISH}(多头)`);

      // 检查是否持续低于阈值
      const allBearish = recentRatios.every(r => r < THRESHOLD_BEARISH);
      const allBullish = recentRatios.every(r => r > THRESHOLD_BULLISH);

      if (allBearish) {
        this.sustainedDirection = 'bearish';
        this.sustainedCount = SUSTAINED_PERIODS;
        return true;
      }
      if (allBullish) {
        this.sustainedDirection = 'bullish';
        this.sustainedCount = SUSTAINED_PERIODS;
        return true;
      }

      this.sustainedDirection = null;
      this.sustainedCount = 0;
      return false;
    } catch (error) {
      console.error('[❌JTO-Taker错误]', error.message);
      return false;
    }
  },

  async collect() {
    try {
      const url = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1H&limit=6`;
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, {
        encoding: 'utf8', timeout: 20000
      });
      const data = JSON.parse(result);

      const ratios = data.data.slice(0, 6).map(d => ({
        time: new Date(parseInt(d[0])).toISOString(),
        buyVol: parseFloat(d[1]),
        sellVol: parseFloat(d[2]),
        ratio: parseFloat((parseFloat(d[1]) / parseFloat(d[2])).toFixed(3))
      }));

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        direction: this.sustainedDirection,
        sustainedPeriods: this.sustainedCount,
        threshold: this.sustainedDirection === 'bearish' ? THRESHOLD_BEARISH : THRESHOLD_BULLISH,
        latestRatio: ratios[0].ratio,
        avgRatio: parseFloat((ratios.slice(0, SUSTAINED_PERIODS).reduce((a, r) => a + r.ratio, 0) / SUSTAINED_PERIODS).toFixed(3)),
        ratios: ratios,
        signal: this.sustainedDirection === 'bearish' ? '持续主动卖出，买方乏力，趋势转弱风险' : '持续主动买入，多头激进，趋势加速信号',
        alertType: 'JTO-Taker买卖比异动'
      };
    } catch (error) {
      console.error('[❌JTO-Taker数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${data.coin}-taker-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [