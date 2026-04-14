/**
 * 持仓量异动警报
 * 监控 BTC 持仓量（OI）1小时内大幅变化
 * 大资金进出场信号，可能预示价格剧烈波动
 *
 * ========== 当前状态 ==========
 * 无持仓 | 观望等待回调入场
 * 监控: OI 1h变化 > 3%
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn, execSync } = require('child_process');

const CREATED_DATE = '2026-04-14';
const OI_THRESHOLD = 0.03; // 3%变化触发
const COOLDOWN_MS = 60 * 60 * 1000;
const PROXY_URL = 'http://127.0.0.1:7890';
const OKX_OI_API = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H';

function fetchOIChange() {
  try {
    const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${OKX_OI_API}"`, {
      encoding: 'utf8',
      timeout: 20000
    });
    const json = JSON.parse(result);
    if (json.code !== '0' || !json.data || json.data.length < 2) {
      throw new Error(`OKX API错误: ${json.msg || '数据不足'}`);
    }
    // data格式: [timestamp, oi, volume]
    const currentOI = parseFloat(json.data[0][1]);
    const prevOI = parseFloat(json.data[1][1]);
    const changeRatio = (currentOI - prevOI) / prevOI;
    return { currentOI, prevOI, changeRatio };
  } catch (error) {
    throw new Error(`获取持仓量失败: ${error.message}`);
  }
}

module.exports = {
  name: '持仓量异动警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const { changeRatio } = fetchOIChange();
      const absChange = Math.abs(changeRatio);
      console.log(`[OI监控] 持仓量1h变化: ${(changeRatio * 100).toFixed(2)}%, 阈值: ${OI_THRESHOLD * 100}%`);
      return absChange >= OI_THRESHOLD;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const { currentOI, prevOI, changeRatio } = fetchOIChange();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        entryPrice: 72000,
        pnl: ((ticker.price - 72000) / 72000 * 100).toFixed(2) + '%',
        openInterest: {
          current: currentOI,
          previous: prevOI,
          changeRatio: (changeRatio * 100).toFixed(2) + '%',
          direction: changeRatio > 0 ? '增加（多头加仓或空头开仓）' : '减少（多头平仓或空头止损）'
        },
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        alertType: '持仓量异动',
        significance: `OI 1h变化 ${(Math.abs(changeRatio) * 100).toFixed(2)}%，大资金可能正在进出场`,
        recommendation: '结合价格走势判断：OI增+价涨=多头加仓看涨，OI增+价跌=空头开仓看跌，OI减+价涨=空头止损看涨，OI减+价跌=多头平仓看跌'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-${Date.now()}`;
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