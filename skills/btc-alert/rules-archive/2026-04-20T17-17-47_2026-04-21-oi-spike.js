/**
 * OI方向突变警报
 * 监控 BTC 持仓量（Open Interest）方向性突变
 *
 * 报告依据：当前核心矛盾是价格反弹但 OI 持续横向震荡（33.07-33.29亿），
 * 无新资金流入。若 OI 开始趋势性变化（回升或加速下降），代表市场格局可能改变。
 *
 * ========== 监控逻辑 ==========
 * 检测 OI 在1小时内的方向性变化：上升 > 1% 或下降 > 2%
 * OI 回升 + 价格上行 = 健康多头信号
 * OI 加速下降 + 价格下行 = 多头恐慌平仓，可能见底
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const OI_SPIKE_UP = 0.01;    // OI 回升阈值：1小时内上升 > 1%
const OI_SPIKE_DOWN = 0.02; // OI 加速下降阈值：1小时内下降 > 2%
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

let baselineOI = null;
let baselineTime = null;

module.exports = {
  name: 'OI方向突变警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      const currentOI = oiData.currentOI;

      console.log(`[警报检查] OI当前: ${(currentOI / 1e9).toFixed(2)}亿`);

      if (baselineOI === null) {
        baselineOI = currentOI;
        baselineTime = Date.now();
        console.log(`[OI基线设置] ${(baselineOI / 1e9).toFixed(2)}亿 @ ${new Date().toISOString()}`);
        return false;
      }

      const elapsedHours = (Date.now() - baselineTime) / (1000 * 60 * 60);
      console.log(`[OI基线] ${(baselineOI / 1e9).toFixed(2)}亿 @ ${elapsedHours.toFixed(2)}小时前`);

      const oiChange = (currentOI - baselineOI) / baselineOI;
      console.log(`[OI变化] ${(oiChange * 100).toFixed(2)}% (回升阈值: ${(OI_SPIKE_UP * 100).toFixed(0)}%, 下降阈值: ${(OI_SPIKE_DOWN * 100).toFixed(0)}%)`);

      // 检查是否触发
      if (oiChange >= OI_SPIKE_UP) {
        console.log(`[触发条件满足] OI 回升 ${(oiChange * 100).toFixed(2)}%`);
        return true;
      }
      if (oiChange <= -OI_SPIKE_DOWN) {
        console.log(`[触发条件满足] OI 加速下降 ${(oiChange * 100).toFixed(2)}%`);
        return true;
      }

      // 每小时重置基线
      if (elapsedHours >= 1) {
        console.log(`[OI基线重置] 已过1小时，更新基线`);
        baselineOI = currentOI;
        baselineTime = Date.now();
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
      const klines = await api.getKlines('BTC', '1h', 6);
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
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'OI方向突变',
        significance: 'OI 方向突变代表市场格局可能改变，需立即分析',
        recommendation: 'OI 回升 + 价格上行 = 健康多头，可考虑做多；OI 下降 + 价格下行 = 可能见底信号'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-spike-${Date.now()}`;
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
    baselineTime = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
