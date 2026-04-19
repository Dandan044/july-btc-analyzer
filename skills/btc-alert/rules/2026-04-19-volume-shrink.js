/**
 * 成交量萎缩警报 - 量能衰竭预警
 * 监控 BTC 成交量持续萎缩（当前成交量较峰值下降超过50%）
 * 当前判断：04-19成交量$4.31B，较04-17峰值$9.73B已萎缩56%，量能衰竭预警
 *
 * ========== 当前状态 ==========
 * 成交量: $4.31B | 04-17峰值: $9.73B | 萎缩幅度: -56%
 * 监控: 成交量 < $4.5B（量能持续萎缩，预示变盘风险）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-19';
const THRESHOLD_VOLUME = 4.5e9; // 触发阈值：成交量低于$4.5B
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '成交量萎缩警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次（成交量数据更新频率）
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const volume24h = ticker.volume24h; // 24小时成交量（美元）
      
      console.log(`[警报检查] 当前24h成交量: $${(volume24h/1e9).toFixed(2)}B, 阈值: $${(THRESHOLD_VOLUME/1e9).toFixed(1)}B`);
      
      // 触发条件：成交量持续低于$4.5B（量能萎缩）
      return volume24h <= THRESHOLD_VOLUME;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 12);
      const oiData = await api.getOKXOpenInterest();
      const takerData = await api.getOKXTakerRatio();

      // 计算最近12小时的成交量趋势
      const recentVolumes = klines.map(k => k.volume);
      const avgHourlyVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        thresholdVolume: THRESHOLD_VOLUME,
        shrinkagePercent: ((ticker.volume24h - 9.73e9) / 9.73e9 * 100).toFixed(1),
        hourlyVolumeTrend: recentVolumes.slice(-6).map((v, i) => ({
          time: klines[klines.length - 6 + i].datetime,
          volume: v
        })),
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        takerRatio: {
          current: takerData.currentRatio
        },
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '成交量萎缩预警',
        significance: '成交量较04-17峰值萎缩超过50%，量能衰竭预示变盘风险，若配合价格突破/跌破关键位，信号更可靠',
        recommendation: '观察成交量是否持续萎缩：若量能继续萎缩至$3.5B以下且OI下降，市场可能选择向下变盘；若突发放量突破$76,000，则警惕向上突破'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-volume-shrink-${Date.now()}`;
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
    // 有效期：最长3天
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
