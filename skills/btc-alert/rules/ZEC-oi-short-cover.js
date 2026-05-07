/**
 * ZEC 持仓量(OI)空头回补监控警报
 * 监控 OI 从高位 66M 大幅回落，信号短期空头回补风险
 *
 * 来源: alt-report-ZEC-2026-05-07-0946.md
 * 报告观点: 当前OI=66.3M(周期最高)，OI在01:00-02:00暴增37%伴随价格下跌。
 *           OI高位维持意味着空头主导。若OI从66M大幅回落(>15%)，说明空头开始
 *           平仓回补，是空仓的风险信号。
 *           做空逻辑失效条件: OI降至55M以下且价格>550
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'ZEC';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取
const api = require('../../btc-market-lite/scripts/api');

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却（OI变化慢）
const PROXY_URL = 'http://127.0.0.1:7890';

const OI_PEAK = 66300000;        // OI峰值参考（~66.3M）
const OI_DROP_THRESHOLD = 55000000; // OI降至55M以下触发（-17%）
const PRICE_RECOVERY = 555;       // 同时价格回升至$555以上确认风险

module.exports = {
  name: 'ZEC持仓量空头回补监控警报',
  interval: 30 * 60 * 1000,  // 30分钟检查
  lastTriggered: 0,
  lastOiValue: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const result = execSync(
        `curl -s --max-time 15 --proxy "${PROXY_URL}" "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D"`,
        { encoding: 'utf8', timeout: 20000 }
      );
      const oiJson = JSON.parse(result);
      const oiArr = (oiJson.data || []).reverse();
      const currentOI = oiArr.length > 0 ? parseFloat(oiArr[0].oi) : null;
      const prevOI = oiArr.length > 1 ? parseFloat(oiArr[1].oi) : null;

      if (!currentOI) {
        console.log(`[🔍警报检查] [API] OKX获取ZEC持仓量 | [进度] ${this.name} | ⚠️ 数据获取失败 | 触发: false`);
        return false;
      }

      const ticker = await api.getTicker('ZEC');
      const currentPrice = ticker.price;

      // OI大幅下降信号
      const oiDropPct = prevOI ? ((currentOI - prevOI) / prevOI * 100).toFixed(1) : 'N/A';
      const oiFromPeak = ((OI_PEAK - currentOI) / OI_PEAK * 100).toFixed(1);
      const oiBelowThreshold = currentOI < OI_DROP_THRESHOLD;
      const priceAboveRecovery = currentPrice > PRICE_RECOVERY;

      // 触发条件: OI降至55M以下 OR (OI单日降幅>10% 且 价格回升>550)
      const triggered = oiBelowThreshold ||
                       (prevOI && currentOI < prevOI * 0.9 && currentPrice > 550);

      this.lastOiValue = currentOI;

      console.log(`[🔍警报检查] [API] OKX获取ZEC持仓量 | [进度] ${this.name} | OI: ${(currentOI/1e6).toFixed(1)}M (日变${oiDropPct}%, 距峰值-${oiFromPeak}%) | 价格: $${currentPrice.toFixed(0)} | OI<55M: ${oiBelowThreshold} | 触发: ${triggered} | [来源] 05-07 09:46即时分析: "OI暴增至66.3M(周期最高)伴随价格下跌=空头主导。若OI大幅回落至55M以下则空头在回补，是空仓风险信号"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('ZEC');
      const klines = await api.getKlines('ZEC', '15m', 8);

      let oiData = null;
      try {
        const result = execSync(
          `curl -s --max-time 15 --proxy "${PROXY_URL}" "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D"`,
          { encoding: 'utf8', timeout: 20000 }
        );
        const oiJson = JSON.parse(result);
        const oiArr = (oiJson.data || []).reverse();
        oiData = {
          currentOI: oiArr.length > 0 ? parseFloat(oiArr[0].oi) : null,
          prevOI: oiArr.length > 1 ? parseFloat(oiArr[1].oi) : null,
          oiPeak: OI_PEAK
        };
      } catch (e) { /* 静默 */ }

      return {
        coin: 'ZEC',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertName: this.name,
        alertType: '持仓量异动',
        openInterest: oiData,
        oiDropThreshold: OI_DROP_THRESHOLD,
        klines15m: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        significance: oiData && oiData.currentOI < OI_DROP_THRESHOLD
          ? `空头回补风险: OI从${(OI_PEAK/1e6).toFixed(1)}M峰值降至${(oiData.currentOI/1e6).toFixed(1)}M(-${((OI_PEAK-oiData.currentOI)/OI_PEAK*100).toFixed(0)}%)`
          : '空头仍在控盘，OI维持高位'
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