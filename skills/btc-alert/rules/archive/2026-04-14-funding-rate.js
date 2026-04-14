/**
 * 资金费率异常警报
 * 监控 BTC 永续合约资金费率异常
 * 多空付费压力信号，极端费率可能预示反转
 *
 * ========== 持仓状态 ==========
 * 入场: $72,000 | 1x 全仓多仓
 * 监控: 费率 > 0.01% (多头拥挤) 或 < -0.01% (空头拥挤)
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn, execSync } = require('child_process');

const CREATED_DATE = '2026-04-14';
const FUNDING_THRESHOLD_POS = 0.0001; // 0.01%
const FUNDING_THRESHOLD_NEG = -0.0001; // -0.01%
const COOLDOWN_MS = 60 * 60 * 1000;
const PROXY_URL = 'http://127.0.0.1:7890';
const OKX_FUNDING_API = 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP';

function fetchFundingRate() {
  try {
    const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${OKX_FUNDING_API}"`, {
      encoding: 'utf8',
      timeout: 20000
    });
    const json = JSON.parse(result);
    if (json.code !== '0' || !json.data || json.data.length === 0) {
      throw new Error(`OKX API错误: ${json.msg || '无数据'}`);
    }
    // fundingRate 是字符串，如 "0.00005"
    const fundingRate = parseFloat(json.data[0].fundingRate);
    const nextFundingTime = json.data[0].nextFundingTime;
    return { fundingRate, nextFundingTime };
  } catch (error) {
    throw new Error(`获取资金费率失败: ${error.message}`);
  }
}

module.exports = {
  name: '资金费率异常警报',
  interval: 30 * 60 * 1000, // 30分钟检查一次（费率8小时结算一次）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const { fundingRate } = fetchFundingRate();
      console.log(`[费率监控] 当前资金费率: ${(fundingRate * 100).toFixed(4)}%, 阈值: ±0.01%`);
      
      // 多头拥挤（费率过高）或空头拥挤（费率过低）
      return fundingRate >= FUNDING_THRESHOLD_POS || fundingRate <= FUNDING_THRESHOLD_NEG;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const { fundingRate, nextFundingTime } = fetchFundingRate();

      let interpretation = '';
      if (fundingRate >= FUNDING_THRESHOLD_POS) {
        interpretation = '多头拥挤，多头付费给空头，可能预示回调风险';
      } else if (fundingRate <= FUNDING_THRESHOLD_NEG) {
        interpretation = '空头拥挤，空头付费给多头，可能预示反弹机会';
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        entryPrice: 72000,
        pnl: ((ticker.price - 72000) / 72000 * 100).toFixed(2) + '%',
        fundingRate: {
          value: (fundingRate * 100).toFixed(4) + '%',
          nextFundingTime: nextFundingTime,
          interpretation: interpretation
        },
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        alertType: '资金费率异常',
        significance: `资金费率 ${(fundingRate * 100).toFixed(4)}% 达到异常阈值，${interpretation}`,
        recommendation: '持有多仓时，高费率可能预示回调，考虑锁定利润或调整仓位'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-funding-${Date.now()}`;
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

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};