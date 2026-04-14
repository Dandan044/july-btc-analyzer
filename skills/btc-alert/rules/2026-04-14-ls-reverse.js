/**
 * 多空比反转警报
 * 监控多空比从低位反转，捕捉空头撤退信号
 * 当前多空比0.77，若回升至>1.2，可能预示空头退场
 *
 * ========== 当前状态 ==========
 * 无持仓 | 观望等待方向确认
 * 监控: 多空比从<0.9反转为>1.2
 * ==============================
 */

const { spawn, execSync } = require('child_process');

const CREATED_DATE = '2026-04-14';
const LOW_THRESHOLD = 0.9;   // 当前空头占优阈值
const HIGH_THRESHOLD = 1.2;  // 多头反转阈值
const COOLDOWN_MS = 60 * 60 * 1000;
const PROXY_URL = 'http://127.0.0.1:7890';
const OKX_LS_API = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H';

let previousRatio = null;

function fetchLongShortRatio() {
  try {
    const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${OKX_LS_API}"`, {
      encoding: 'utf8',
      timeout: 20000
    });
    const json = JSON.parse(result);
    if (json.code !== '0' || !json.data || json.data.length < 1) {
      throw new Error(`OKX API错误: ${json.msg || '数据不足'}`);
    }
    // data格式: [timestamp, longRatio, shortRatio, longShortRatio]
    const ratio = parseFloat(json.data[0][3]);
    return ratio;
  } catch (error) {
    throw new Error(`获取多空比失败: ${error.message}`);
  }
}

module.exports = {
  name: '多空比反转警报',
  interval: 15 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const currentRatio = fetchLongShortRatio();
      console.log(`[多空比监控] 当前比值: ${currentRatio.toFixed(2)}, 上次值: ${previousRatio?.toFixed(2) || '无'}`);
      
      // 检查反转条件：从低位(<0.9)反转到高位(>1.2)
      if (previousRatio !== null && previousRatio < LOW_THRESHOLD && currentRatio > HIGH_THRESHOLD) {
        previousRatio = currentRatio;
        return true;
      }
      
      previousRatio = currentRatio;
      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const currentRatio = fetchLongShortRatio();
      
      // 获取简单价格数据
      const tickerCmd = `curl -s --max-time 10 "https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC&tsyms=USD"`;
      const tickerResult = execSync(tickerCmd, { encoding: 'utf8', timeout: 15000 });
      const tickerJson = JSON.parse(tickerResult);
      const ticker = tickerJson.RAW?.BTC?.USD || {};
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.PRICE || 0,
        longShortRatio: {
          current: currentRatio.toFixed(2),
          previous: previousRatio?.toFixed(2) || '无记录',
          change: ((currentRatio - (previousRatio || currentRatio)) / (previousRatio || currentRatio) * 100).toFixed(1) + '%',
          status: '空头撤退，多头回归'
        },
        priceChange: {
          '1h': ticker.CHANGEPCTHOUR || 0,
          '24h': ticker.CHANGEPCT24HOUR || 0
        },
        alertType: '多空比反转',
        significance: `多空比从${previousRatio?.toFixed(2) || '低位'}反转为${currentRatio.toFixed(2)}，空头可能正在退场`,
        recommendation: '若多空比回升至>1.2并稳定，价格企稳$74,487上方，可考虑入场做多。止损$72,000，止盈$75,500/$77,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-ls-reverse-${Date.now()}`;
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