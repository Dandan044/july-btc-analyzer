/**
 * ZEC Taker主动买入比飙升警报（空头挤压预警）
 * 监控 Taker 买卖比是否持续 > 1.2，信号空头挤压风险
 *
 * 来源: alt-report-ZEC-2026-05-07-0946.md
 * 报告观点: 当前空头主导(Taker 0.92-1.04区间)。若Taker比连续3小时>1.2，
 *           说明主动买盘大幅回归，可能出现轧空，是空仓的重大风险信号。
 *           多空比0.37极端偏空更增加了轧空概率。
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'ZEC';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取
const api = require('../../btc-market-lite/scripts/api');

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却
const PROXY_URL = 'http://127.0.0.1:7890';

const TAKER_THRESHOLD = 1.2;        // Taker买卖比阈值
const MIN_CONSECUTIVE = 3;          // 连续K线数

module.exports = {
  name: 'ZEC Taker买入比飙升警报',
  interval: 10 * 60 * 1000,
  lastTriggered: 0,
  consecutiveCount: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const result = execSync(
        `curl -s --max-time 15 --proxy "${PROXY_URL}" "https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=ZEC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1H&limit=10"`,
        { encoding: 'utf8', timeout: 20000 }
      );
      const json = JSON.parse(result);
      const data = (json.data || []).reverse();

      if (data.length < MIN_CONSECUTIVE) {
        console.log(`[🔍警报检查] [API] OKX获取ZEC Taker买卖比 | [进度] ${this.name} | ⚠️ 数据不足(${data.length}<${MIN_CONSECUTIVE}) | 触发: false`);
        return false;
      }

      // 检查最近N根K线是否连续 > 阈值
      const recentRatios = data.slice(-MIN_CONSECUTIVE).map(d => parseFloat(d.takerVolRatio || d[0] || 1));
      const allAbove = recentRatios.every(r => r > TAKER_THRESHOLD);
      const avgRatio = (recentRatios.reduce((a, b) => a + b, 0) / recentRatios.length).toFixed(3);

      const ticker = await api.getTicker('ZEC');

      console.log(`[🔍警报检查] [API] OKX获取ZEC Taker买卖比(${MIN_CONSECUTIVE}H) | [进度] ${this.name} | 最近${MIN_CONSECUTIVE}H: [${recentRatios.map(r=>r.toFixed(3)).join(', ')}] | 均值: ${avgRatio} | 阈值: ${TAKER_THRESHOLD} | 价格: $${ticker.price.toFixed(0)} | 触发: ${allAbove} | [来源] 05-07 09:46即时分析: "空头主导下多空比0.37极端偏空，若Taker买盘突然飙升>1.2连续3H，轧空风险骤增"`);

      return allAbove;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('ZEC');
      const klines = await api.getKlines('ZEC', '15m', 8);

      let takerData = null;
      try {
        const result = execSync(
          `curl -s --max-time 15 --proxy "${PROXY_URL}" "https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=ZEC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1H&limit=10"`,
          { encoding: 'utf8', timeout: 20000 }
        );
        const json = JSON.parse(result);
        const data = (json.data || []).reverse();
        const recentRatios = data.slice(-MIN_CONSECUTIVE).map(d => parseFloat(d.takerVolRatio || d[0] || 1));
        takerData = {
          recentRatios,
          avgRatio: recentRatios.reduce((a, b) => a + b, 0) / recentRatios.length,
          threshold: TAKER_THRESHOLD
        };
      } catch (e) { /* 静默 */ }

      return {
        coin: 'ZEC',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertName: this.name,
        alertType: 'Taker买卖比异动',
        takerData,
        klines15m: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        significance: '主动买盘连续飙升，空头面临轧空风险，需评估是否减仓/止损'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${alertData.coin}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [