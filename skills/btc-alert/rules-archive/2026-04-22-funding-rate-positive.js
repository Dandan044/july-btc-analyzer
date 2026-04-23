/**
 * 资金费率转正警报
 * 触发条件：BTC 资金费率从当前负值转正超过 +0.005%
 * 触发后：执行即时分析，评估是否触发空头挤压做多机会
 * 
 * 依据：04-22 23:10即时分析报告判断"资金费率仍为负（-0.0038%），14日维持负值，
 *       多头优势未完全恢复。若资金费率重新转正，说明多头重新入场，
 *       可能开启新一轮上涨，需配合价格观察是否做多"。
 * 
 * 数据源：OKX 资金费率 API（需代理）
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const FUNDING_RATE_THRESHOLD = 0.00005; // +0.005%
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '资金费率转正警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const proxy = 'http://127.0.0.1:7890';
      // 获取当前资金费率（当前周期）
      const url = 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP';
      const result = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${url}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const data = JSON.parse(result);
      if (!data.data || !data.data[0]) return false;

      // fundingRate 是当前周期费率（负数表示空头主导）
      const fundingRate = parseFloat(data.data[0].fundingRate);
      
      if (isNaN(fundingRate)) return false;

      const triggered = fundingRate >= FUNDING_RATE_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取BTC资金费率 | [进度] ${this.name} | 资金费率: ${(fundingRate * 100).toFixed(4)}% | 阈值: +${(FUNDING_RATE_THRESHOLD * 100).toFixed(3)}% | 触发: ${triggered} | [来源] 04-22 21:51即时分析: "资金费率从+0.0011%转负至-0.0047%，若重新转正可能开启新一轮上涨"`);
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const proxy = 'http://127.0.0.1:7890';
      const api = require('../../btc-market-lite/scripts/api');
      const ticker = await api.getTicker('BTC');
      
      // 获取资金费率（当前周期）
      const fundingUrl = 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP';
      const fundingResult = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${fundingUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      // 获取上一周期结算资金费率（用于历史对比）
      const histUrl = 'https://www.okx.com/api/v5/rubik/stat/contracts/funding-rate?ccy=BTC&period=1D&limit=5';
      const histResult = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${histUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const currentData = JSON.parse(fundingResult);
      const histData = JSON.parse(histResult);
      
      const currentFundingRate = currentData.data?.[0]?.fundingRate 
        ? parseFloat(currentData.data[0].fundingRate) 
        : null;

      const histRows = histData.data || [];
      const fundingHistory = histRows.map(r => ({
        time: new Date(parseInt(r[0])).toISOString(),
        fundingRate: parseFloat(r[1])
      })).reverse();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        currentFundingRate: currentFundingRate,
        currentFundingRatePct: currentFundingRate !== null ? (currentFundingRate * 100).toFixed(4) + '%' : null,
        fundingHistory: fundingHistory.slice(0, 5).map(h => ({
          time: h.time,
          fundingRate: h.fundingRate !== null ? (h.fundingRate * 100).toFixed(4) + '%' : null
        })),
        threshold: `+${(FUNDING_RATE_THRESHOLD * 100).toFixed(3)}%`,
        alertType: '非价格警报（资金费率）',
        significance: `资金费率 ${currentFundingRate !== null ? (currentFundingRate * 100).toFixed(4) : '?'}%。${currentFundingRate >= FUNDING_RATE_THRESHOLD ? '已转正（+0.005%以上），多头重新入场，可能开启新一轮上涨，需配合价格观察是否做多。若资金费率转正且价格站稳 $79,000 → 做多信号' : '仍为负值或低于阈值，多头未完全恢复，继续观察'}。当前-0.0035%，转正说明空头被迫平仓，多头主导市场。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-funding-rate-positive-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

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

    console.log(`[⚡警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};