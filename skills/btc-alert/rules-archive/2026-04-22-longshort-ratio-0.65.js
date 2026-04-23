/**
 * 多空比恶化警报
 * 触发条件：BTC longShortRatio 从当前0.67恶化至 0.65 以下（空头完全主导）
 * 触发后：执行即时分析，评估是否触发空头挤压做多机会
 * 
 * 依据：04-22 21:00日报判断"longShortRatio从15:09的0.71逐级恶化至0.67，
 *       顶级交易员持续4小时加空（4个周期空头占比均超过59%）。
 *       若继续恶化至0.65以下且价格仍守 $78,000 → 空头挤压加速，强烈做多信号"。
 *       0.65是历史极端值（04-18 14日最低0.65），跌破后空头挤压大概率爆发。
 * 
 * 数据源：OKX 多空比 API（需代理）
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const LONG_SHORT_RATIO_THRESHOLD = 0.65;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '多空比恶化警报-0.65',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const proxy = 'http://127.0.0.1:7890';
      // 使用1H周期追踪短期恶化趋势
      const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H&limit=1';
      const result = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${url}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const data = JSON.parse(result);
      if (!data.data || !data.data[0]) return false;

      // 数据格式：[timestamp, long_ratio, short_ratio, ...]
      const row = data.data[0];
      const longShortRatio = parseFloat(row[1]);

      if (isNaN(longShortRatio)) return false;

      const triggered = longShortRatio < LONG_SHORT_RATIO_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取1H多空比数据 | [进度] ${this.name} | longShortRatio: ${longShortRatio.toFixed(3)} | 阈值: ${LONG_SHORT_RATIO_THRESHOLD} | 触发: ${triggered} | [来源] 04-22 21:00日报: "longShortRatio从0.71恶化至0.67，若继续恶化至0.65以下且价格守$78,000则空头挤压加速"`);
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const proxy = 'http://127.0.0.1:7890';
      
      // 获取多空比历史（1H）
      const ratioUrl = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H&limit=6';
      const ratioResult = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${ratioUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      // 获取持仓量
      const oiUrl = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H&limit=6';
      const oiResult = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${oiUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const api = require('../../btc-market-lite/scripts/api');
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 6);

      const ratioData = JSON.parse(ratioResult);
      const oiData = JSON.parse(oiResult);

      const ratioRows = ratioData.data || [];
      const oiRows = oiData.data || [];

      const ratioHistory = ratioRows.map((r, i) => ({
        time: new Date(parseInt(r[0])).toISOString(),
        longShortRatio: parseFloat(r[1]),
        shortRatio: parseFloat(r[2]),
        oi: oiRows[i] ? parseFloat(oiRows[i][2]) : null
      })).reverse();

      const latest = ratioHistory[0] || {};
      const prev = ratioHistory[1] || {};

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        latestLongShortRatio: latest.longShortRatio,
        prevLongShortRatio: prev.longShortRatio,
        shortRatio: latest.shortRatio,
        ratioHistory: ratioHistory.map(r => ({
          time: r.time,
          longShortRatio: r.longShortRatio ? r.longShortRatio.toFixed(3) : null,
          shortRatio: r.shortRatio ? (r.shortRatio * 100).toFixed(1) + '%' : null,
          oi: r.oi ? `${(r.oi / 1e9).toFixed(2)}B` : null
        })),
        threshold: LONG_SHORT_RATIO_THRESHOLD,
        alertType: '多空比恶化（非价格）',
        significance: `longShortRatio已降至 ${latest.longShortRatio ? latest.longShortRatio.toFixed(3) : '?'}（阈值${LONG_SHORT_RATIO_THRESHOLD}）。${latest.longShortRatio < 0.65 ? '空头彻底主导，空头挤压大概率爆发，强烈做多信号' : '接近0.65临界值，密切关注'}。配合价格守 $78,000，是最佳做多窗口。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-longshort-ratio-0.65-${Date.now()}`;
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