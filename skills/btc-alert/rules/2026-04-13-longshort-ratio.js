/**
 * 多空比反转警报
 * 监控多空比高于1.2（多头强势确认）
 * 做空持仓风险警报：多头强势时建议关注止盈决策
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn, execSync } = require('child_process');

const CREATED_DATE = '2026-04-13';
const TARGET_RATIO = 1.2;  // 多头强势阈值
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const PROXY_URL = 'http://127.0.0.1:7890';
const OKX_API = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D';

// 使用代理获取OKX多空比数据
function fetchLongShortRatio() {
  try {
    const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${OKX_API}"`, {
      encoding: 'utf8',
      timeout: 20000
    });
    const json = JSON.parse(result);
    if (json.code !== '0' || !json.data || json.data.length === 0) {
      throw new Error(`OKX API错误: ${json.msg || '无数据'}`);
    }
    // data[0] 是最新数据：[timestamp, ratio]
    return parseFloat(json.data[0][1]);
  } catch (error) {
    throw new Error(`获取多空比失败: ${error.message}`);
  }
}

module.exports = {
  name: '多空比反转警报（多头强势）',
  interval: 30 * 60 * 1000,  // 30分钟检查一次（日级别数据）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ratio = fetchLongShortRatio();
      console.log(`[多空比警报检查] 当前多空比: ${ratio.toFixed(2)}, 目标: ${TARGET_RATIO}`);
      return ratio >= TARGET_RATIO;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 10);

      // 获取多空比历史趋势（7天）
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${OKX_API}"`, {
        encoding: 'utf8',
        timeout: 20000
      });
      const json = JSON.parse(result);
      const ratioHistory = json.data.slice(0, 7).map(d => ({
        timestamp: parseInt(d[0]),
        ratio: parseFloat(d[1])
      }));
      const currentRatio = ratioHistory[0]?.ratio || 0;

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentRatio: currentRatio,
        ratioHistory: ratioHistory,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close
        })),
        alertType: '多空比反转',
        significance: '多空比≥1.2确认多头强势，做空持仓风险增加，建议评估手动止盈'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-longshort-${Date.now()}`;
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
    return daysDiff <= 2 ? 'active' : 'expired';
  }
};