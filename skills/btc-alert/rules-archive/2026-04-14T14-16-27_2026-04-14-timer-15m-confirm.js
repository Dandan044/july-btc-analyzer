/**
 * 定时器警报 - 15分钟后入场确认
 * 突破$75K后等待15分钟，检查是否站稳确认入场
 *
 * ========== 当前状态 ==========
 * pending_entry建议: sug-001
 * 入场条件: 22:00检查15分钟收盘价 > $75K
 * ==============================
 *
 * 创建原因: 价格突破$75K（最高$75,372），等待15分钟确认站稳
 * 建议: 做多，入场$75,000，止损$74,500，止盈$76,500/$78,000
 */

const { spawn, execSync } = require('child_process');

const CREATED_DATE = '2026-04-14';
const CREATED_TIME = Date.now();              // 21:48创建
const TRIGGER_DELAY_MS = 15 * 60 * 1000;      // 15分钟后触发（22:03）
const ENTRY_PRICE = 75000;

function fetchPrice() {
  try {
    const result = execSync(`curl -s --max-time 10 "https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC&tsyms=USD"`, {
      encoding: 'utf8',
      timeout: 15000
    });
    const json = JSON.parse(result);
    return json.RAW?.BTC?.USD?.PRICE || 0;
  } catch (error) {
    throw new Error(`获取价格失败: ${error.message}`);
  }
}

module.exports = {
  name: '定时器-15分钟后入场确认-75K',
  interval: 5 * 60 * 1000, // 5分钟检查一次（定时器不需要高频）
  lastTriggered: 0,

  async check() {
    const now = Date.now();
    const triggerTime = CREATED_TIME + TRIGGER_DELAY_MS;

    if (now >= triggerTime && now < triggerTime + 5 * 60 * 1000) {
      // 到达触发时间窗口（允许5分钟误差）
      console.log(`[定时器检查] 已到达触发时间: ${new Date(triggerTime).toISOString()}`);
      return true;
    }

    if (now < triggerTime) {
      const remainingMs = triggerTime - now;
      const remainingMins = Math.floor(remainingMs / 60000);
      console.log(`[定时器检查] 距触发时间还有 ${remainingMins} 分钟`);
    }

    return false;
  },

  async collect() {
    try {
      const currentPrice = fetchPrice();
      const klinesCmd = `curl -s --max-time 10 "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=5&aggregate=15"`;
      const klinesResult = execSync(klinesCmd, { encoding: 'utf8', timeout: 15000 });
      const klinesJson = JSON.parse(klinesResult);
      const klines = klinesJson.Data?.Data || [];

      // 检查最近的15分钟K线收盘价
      const lastKline = klines[klines.length - 1] || {};
      const lastClose = lastKline.close || currentPrice;

      return {
        alertTime: new Date().toISOString(),
        currentPrice: currentPrice,
        last15mClose: lastClose,
        entryPrice: ENTRY_PRICE,
        confirmed: lastClose >= ENTRY_PRICE,
        klines15m: klines.slice(-3).map(k => ({
          time: new Date(k.time * 1000).toISOString(),
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volumeto
        })),
        alertType: '定时器-入场确认',
        suggestionId: 'sug-001',
        message: lastClose >= ENTRY_PRICE 
          ? `确认站稳$75K，收盘价$${lastClose.toFixed(0)} > $${ENTRY_PRICE}，建议入场`
          : `突破失败，收盘价$${lastClose.toFixed(0)} ≤ $${ENTRY_PRICE}，建议观望`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `timer-confirm-75k-${Date.now()}`;
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

    console.log(`[定时器触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const now = Date.now();
    // 定时器是一次性的，触发窗口（5分钟）后即完成
    const triggerTime = CREATED_TIME + TRIGGER_DELAY_MS;
    if (now >= triggerTime + 5 * 60 * 1000) {
      return 'completed';
    }
    return 'active';
  }
};