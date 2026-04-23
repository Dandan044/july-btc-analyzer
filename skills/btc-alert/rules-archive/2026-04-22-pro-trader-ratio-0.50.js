/**
 * 顶级交易员多空比下破0.50警报
 * 触发条件：BTC 顶级交易员多空比从当前0.519下降并跌破 0.50（1H）
 * 触发后：执行即时分析，评估是否做空或止损
 * 
 * 依据：04-22 14:07报告判断"顶级交易员多空比从08:00的0.614骤降至12:00的0.519，
 *       是14日内最大背离幅度，意味着聪明钱在价格创新高时大幅降低多仓"。
 *       0.50是明确偏空的临界值，跌破后反弹大概率已结束或接近结束。
 *       配合4H长上影线、量价背离，是最强预警信号。
 * 
 * 数据源：OKX 多空比 API（需代理）
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const LONG_SHORT_RATIO_THRESHOLD = 0.50;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '顶级交易员多空比下破0.50',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const proxy = 'http://127.0.0.1:7890';
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

      console.log(`[警报检查] ${this.name} | 顶级交易员多空比: ${longShortRatio.toFixed(3)} | 阈值: ${LONG_SHORT_RATIO_THRESHOLD} | 触发: ${triggered}`);
      return triggered;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const proxy = 'http://127.0.0.1:7890';
      
      // 获取多空比历史
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
        ratioHistory: ratioHistory.map(r => ({
          time: r.time,
          longShortRatio: r.longShortRatio ? r.longShortRatio.toFixed(3) : null,
          oi: r.oi ? `${(r.oi / 1e9).toFixed(2)}B` : null
        })),
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        threshold: LONG_SHORT_RATIO_THRESHOLD,
        alertType: '顶级交易员多空比（非价格）',
        significance: `顶级交易员多空比已降至 ${latest.longShortRatio ? latest.longShortRatio.toFixed(3) : '?'}（阈值${LONG_SHORT_RATIO_THRESHOLD}）。${latest.longShortRatio < 0.50 ? '跌破0.50确认偏空，聪明钱正在撤退，反弹大概率已结束' : '接近0.50临界值，密切关注'}`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-pro-trader-ratio-${Date.now()}`;
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

    console.log(`[警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
