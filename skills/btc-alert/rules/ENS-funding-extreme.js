/**
 * ENS 资金费率极端警报
 * 监控资金费率飙升至+0.15%以上（极端多头拥挤后反转信号）
 *
 * 来源: alt-report-ENS-2026-05-13-0049.md
 * 报告观点: "空头格局持续确认，但盈亏比不达标。观察条件之一：
 *           资金费率飙升至+0.15%以上（极端多头拥挤后反转）可考虑做空入场。"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ENS';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const FUNDING_THRESHOLD = 0.0015;    // +0.15% 资金费率阈值

module.exports = {
  name: 'ENS-资金费率极端',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 直接调用 OKX 资金费率 API
      const { execSync } = require('child_process');
      const PROXY_URL = 'http://127.0.0.1:7890';
      const url = `https://www.okx.com/api/v5/public/funding-rate?instId=${COIN}-USDT-SWAP`;
      const result = execSync(`curl -s --max-time 10 --proxy "${PROXY_URL}" "${url}"`, {
        encoding: 'utf8',
        timeout: 15000
      });
      const data = JSON.parse(result);

      if (data.code !== '0' || !data.data || data.data.length === 0) {
        console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率失败: ${data.msg || '无数据'}`);
        return false;
      }

      const fundingRate = parseFloat(data.data[0].fundingRate);
      const triggered = fundingRate >= FUNDING_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 当前费率: ${(fundingRate * 100).toFixed(4)}% | 阈值: ≥${(FUNDING_THRESHOLD * 100).toFixed(2)}% | 触发: ${triggered} | [来源] 05-13 00:49山寨报告: "资金费率飙升至+0.15%以上可考虑做空入场"`);

      this._fundingRate = fundingRate;
      this._fundingTime = data.data[0].fundingTime;

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      let oiData = null, lsData = null, takerData = null;
      try { oiData = await api.getOKXOpenInterest(COIN); } catch (e) { /* 静默 */ }
      try { lsData = await api.getOKXLongShortRatio(COIN); } catch (e) { /* 静默 */ }
      try { takerData = await api.getOKXTakerRatio(COIN); } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        fundingRate: this._fundingRate,
        fundingThreshold: FUNDING_THRESHOLD,
        openInterest: oiData?.currentOI,
        longShortRatio: lsData?.currentRatio,
        takerBuyRatio: takerData?.currentRatio,
        alertType: '资金费率极端',
        significance: `ENS资金费率${(this._fundingRate * 100).toFixed(4)}%超过阈值${(FUNDING_THRESHOLD * 100).toFixed(2)}%，极端多头拥挤，反转风险加大，可考虑做空入场`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-funding-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${COIN}警报触发] 资金费率极端，已派发即时分析任务: ${jobName}`);

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
