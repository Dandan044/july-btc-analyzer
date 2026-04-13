/**
 * 多空比下跌警报 - 监控多头信心减弱
 * 来源：btc-report-2026-04-08-0900
 * 分析发现：多空比从1.39骤降至1.03，预示上涨动能衰竭
 */

const { spawn } = require('child_process');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 从环境变量获取代理配置
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || null;
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

// Helper function for HTTPS requests (支持代理)
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = proxyAgent ? { agent: proxyAgent } : {};
    const timeout = 10000;
    
    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON解析失败: ' + data.substring(0, 100)));
        }
      });
      res.on('error', reject);
    });
    
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

const CREATED_DATE = '2026-04-08';
const EXPIRY_DATE = '2026-04-11';
const TARGET_RATIO = 1.0;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '多空比下跌警报-跌破1.0',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      console.log(`[警报检查] ${proxyAgent ? '使用代理' : '直连'}请求多空比数据...`);
      const data = await httpsGet('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1');

      if (data && data.length > 0) {
        const ratio = parseFloat(data[0].longShortRatio);
        console.log(`[警报检查] 当前多空比: ${ratio.toFixed(4)}, 阈值: ${TARGET_RATIO}`);
        return ratio < TARGET_RATIO;
      }

      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      // 获取多空比数据
      const lsData = await httpsGet('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=12');

      // 获取价格数据
      const ticker = await httpsGet('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');

      return {
        alertTime: new Date().toISOString(),
        currentPrice: parseFloat(ticker.lastPrice),
        priceChange: {
          '24h': parseFloat(ticker.priceChangePercent)
        },
        volume24h: parseFloat(ticker.quoteVolume),
        longShortRatio: {
          current: parseFloat(lsData[0]?.longShortRatio || 0),
          history: lsData.map(d => ({
            time: d.timestamp,
            ratio: parseFloat(d.longShortRatio)
          }))
        },
        triggerRatio: TARGET_RATIO,
        alertType: '多空比跌破',
        significance: '多空比跌破1.0，空头开始占优，回调风险增加',
        analysisContext: {
          reportId: 'btc-report-2026-04-08-0900',
          previousRatio: 1.03,
          direction: 'bearish',
          recommendation: '谨慎持仓，关注支撑位'
        }
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-longshort-fall-${Date.now()}`;
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
    const expiry = new Date(EXPIRY_DATE);
    const now = new Date();
    // 在有效期内返回 active
    if (now < expiry) {
      return 'active';
    }
    return 'expired';
  }
};