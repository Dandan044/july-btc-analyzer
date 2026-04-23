/**
 * 非价格警报：持仓量变化警报
 * 监控 BTC 持仓量（OI）24h变化超过2%
 * 数据来源：OKX open-interest-volume API（需要代理）
 * 适用场景：OI快速变化反映多空博弈加剧，可能预示方向选择
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn, execSync } = require('child_process');

const CREATED_DATE = '2026-04-22';
const OI_CHANGE_THRESHOLD = 2.0; // 触发阈值：24h OI变化超过2%
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const PROXY_URL = 'http://127.0.0.1:7890';

module.exports = {
  name: '持仓量变化警报',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D';
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, {
        encoding: 'utf8',
        timeout: 20000
      });

      const data = JSON.parse(result);
      if (data.code !== '0' || !data.data || data.data.length < 2) {
        console.log(`[警报检查] OI API返回异常`);
        return false;
      }

      const latest = data.data[0];
      const prev = data.data[1];

      const oiLatest = parseFloat(latest[1]) || 0;
      const oiPrev = parseFloat(prev[1]) || 0;

      if (!oiLatest || !oiPrev) {
        console.log(`[警报检查] OI数据异常`);
        return false;
      }

      const oiChangePct = Math.abs((oiLatest - oiPrev) / oiPrev * 100);

      console.log(`[警报检查] 最新OI: ${(oiLatest/1e6).toFixed(2)}M, 前日: ${(oiPrev/1e6).toFixed(2)}M, 变化: ${oiChangePct.toFixed(2)}%`);

      return oiChangePct >= OI_CHANGE_THRESHOLD;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('BTC');

      const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D';
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, {
        encoding: 'utf8',
        timeout: 20000
      });

      const data = JSON.parse(result);
      let oiLatest = 0, oiPrev = 0, oiChangePct = 'N/A';

      if (data.data && data.data.length >= 2) {
        oiLatest = parseFloat(data.data[0][1]) || 0;
        oiPrev = parseFloat(data.data[1][1]) || 0;
        oiChangePct = oiPrev ? ((oiLatest - oiPrev) / oiPrev * 100).toFixed(2) : 'N/A';
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentOI: oiLatest,
        previousOI: oiPrev,
        oiChangePct: oiChangePct,
        alertType: '持仓量变化',
        significance: `24h OI变化 ${oiChangePct}%，需结合价格方向判断多空意图`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const spawnMessage = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;
    const now = new Date().toISOString();
    const jobName = `alert-oi-${Date.now()}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', spawnMessage,
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
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
