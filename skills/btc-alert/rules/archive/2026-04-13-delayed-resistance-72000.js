/**
 * 阻力突破延迟确认警报
 * 监控 BTC 价格突破 $72,000 后是否稳定维持
 * 突破后等待30分钟确认，避免假突破
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-13';
const TARGET_PRICE = 72000;
const DELAY_MS = 30 * 60 * 1000; // 突破后等待30分钟确认
const COOLDOWN_MS = 60 * 60 * 1000; // 触发后冷却1小时

module.exports = {
  name: '阻力突破延迟确认-72000',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  breakthroughTime: null, // 记录突破发生时间

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');

      if (ticker.price >= TARGET_PRICE) {
        // 突破发生
        if (!this.breakthroughTime) {
          this.breakthroughTime = Date.now();
          console.log(`[突破检测] 价格已突破 $${TARGET_PRICE}，当前 $${ticker.price}，开始计时...`);
        }

        // 检查是否已延迟足够时间
        if (Date.now() - this.breakthroughTime >= DELAY_MS) {
          console.log(`[延迟确认] 突破已稳定 ${DELAY_MS / 60000} 分钟，触发警报`);
          return true;
        }

        const elapsedMins = Math.floor((Date.now() - this.breakthroughTime) / 60000);
        console.log(`[等待确认] 突破已持续 ${elapsedMins} 分钟，等待 ${DELAY_MS / 60000} 分钟`);
      } else {
        // 价格回落，重置计时
        if (this.breakthroughTime) {
          console.log(`[突破失效] 价格回落至 $${ticker.price}，重置计时`);
          this.breakthroughTime = null;
        }
      }

      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 12);

      // 获取多空比数据
      const OKX_API = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D';
      const PROXY_URL = 'http://127.0.0.1:7890';
      const { execSync } = require('child_process');
      
      let longShortRatio = null;
      try {
        const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${OKX_API}"`, {
          encoding: 'utf8',
          timeout: 20000
        });
        const json = JSON.parse(result);
        if (json.code === '0' && json.data && json.data.length > 0) {
          longShortRatio = parseFloat(json.data[0][1]);
        }
      } catch (e) {
        console.log('[多空比获取失败]', e.message);
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggerPrice: TARGET_PRICE,
        breakthroughTime: this.breakthroughTime ? new Date(this.breakthroughTime).toISOString() : null,
        delayMinutes: DELAY_MS / 60000,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        longShortRatio: longShortRatio,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '阻力突破延迟确认',
        significance: '突破$72,000阻力后稳定维持30分钟，确认有效突破，可能迎来入场做多机会'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-delayed-resistance-${Date.now()}`;
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
    this.breakthroughTime = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};