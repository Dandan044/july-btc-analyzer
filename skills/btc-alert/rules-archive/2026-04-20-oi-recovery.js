/**
 * OI回升确认警报
 * 监控持仓量(OI)从当前水平开始回升，确认突破有效性
 * 
 * 报告依据：当前最大矛盾是价格涨但OI持续下降。
 * 价格突破 $75,500，但只有OI也开始回升，才能确认这是真实的多头趋势。
 * OI回升意味着有新资金入场，是趋势延续的关键信号。
 * 
 * ========== 监控逻辑 ==========
 * 当OI在24小时内从当前水平（~33.86亿）回升超过1%，视为多头确认
 * 同时要求价格维持在 $75,000 以上
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const OI_RECOVERY_THRESHOLD = 0.01; // OI回升阈值：1%
const CURRENT_OI_APPROX = 33860000000; // 约33.86亿美元
const MIN_PRICE = 75000; // 价格需维持在 $75,000 以上
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

let baselineOI = null;
let baselineSetTime = null;

module.exports = {
  name: 'OI回升确认警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      const ticker = await api.getTicker('BTC');
      
      const currentOI = oiData.currentOI;
      const currentPrice = ticker.price;
      
      // 设置基线（每小时只设置一次）
      if (baselineOI === null) {
        baselineOI = currentOI;
        baselineSetTime = Date.now();
        console.log(`[OI基线设置] ${(currentOI / 1e9).toFixed(2)}亿美元 @ ${new Date().toISOString()}`);
      }
      
      console.log(`[警报检查] OI: ${(currentOI / 1e9).toFixed(2)}亿, 基线: ${(baselineOI / 1e9).toFixed(2)}亿, 价格: ${currentPrice}`);
      
      // 检查价格条件：需维持在 $75,000 以上
      if (currentPrice < MIN_PRICE) {
        console.log(`[条件不满足] 价格 ${currentPrice} < ${MIN_PRICE}，等待价格回升`);
        return false;
      }
      
      // 计算OI变化
      if (baselineOI !== null) {
        const oiChange = (currentOI - baselineOI) / baselineOI;
        console.log(`[OI变化] ${(oiChange * 100).toFixed(2)}% (阈值: ${(OI_RECOVERY_THRESHOLD * 100).toFixed(0)}%)`);
        
        if (oiChange >= OI_RECOVERY_THRESHOLD) {
          console.log(`[触发条件满足] OI从基线回升 ${(oiChange * 100).toFixed(2)}%`);
          return true;
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
      const klines = await api.getKlines('BTC', '4h', 6);
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h,
          baseline: baselineOI
        },
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'OI回升确认',
        message: '持仓量开始回升，确认突破有效性',
        significance: 'OI回升意味着新资金入场，是趋势延续的关键信号，可考虑做多'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-recovery-${Date.now()}`;
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
    baselineOI = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
