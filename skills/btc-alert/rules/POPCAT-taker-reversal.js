/**
 * POPCAT Taker买卖比反转警报
 * 监控做空仓位期间Taker买卖比从卖出主导转为买入主导
 * 反转可能预示反弹再起，需要重新评估做空逻辑
 *
 * 来源：alt-report-POPCAT-2026-05-11-0810.md
 * 报告观点：4H Taker买卖比从1.37翻转为0.68，卖出主导。若反转回到>1.2，反弹可能再起
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-11';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TAKER_THRESHOLD = 1.2; // Taker买卖比反转阈值（从<1回到>1.2）

module.exports = {
  name: 'POPCAT-Taker买卖比反转',
  interval: 5 * 60 * 1000, // 5分钟检查（Taker比更新频率较低）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取4H K线数据中的Taker买卖比
      const klines4h = await api.getOKXKlines('POPCAT', '4h', 3, 'SWAP');
      const latestKline = klines4h[klines4h.length - 1];

      // 从K线数据中获取takerRatio
      const takerRatio = latestKline.takerRatio || latestKline.takerBuyRatio;

      if (takerRatio && takerRatio >= TAKER_THRESHOLD) {
        console.log(`[🔍警报检查] [API] OKX获取POPCAT 4H K线+Taker比 | [进度] ${this.name} | 当前Taker比: ${takerRatio.toFixed(3)} | 阈值: ${TAKER_THRESHOLD} | 触发: true | [来源] 05-11 08:10报告: "4H Taker买卖比从1.37翻转为0.68，卖出主导。若反转回到>1.2，反弹可能再起"`);
        return true;
      }

      console.log(`[🔍警报检查] [API] OKX获取POPCAT 4H K线+Taker比 | [进度] ${this.name} | 当前Taker比: ${takerRatio ? takerRatio.toFixed(3) : 'N/A'} | 阈值: ${TAKER_THRESHOLD} | 触发: false | [来源] 05-11 08:10报告: "4H Taker买卖比从1.37翻转为0.68，卖出主导"`);
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('POPCAT', 'SWAP');
      const klines4h = await api.getOKXKlines('POPCAT', '4h', 6, 'SWAP');
      const klines1h = await api.getOKXKlines('POPCAT', '1h', 8, 'SWAP');

      let oiData = null;
      try {
        if (api.getOKXOpenInterest) oiData = await api.getOKXOpenInterest();
      } catch (e) {
        console.log('[数据收集] OKX OI数据获取失败');
      }

      return {
        coin: 'POPCAT',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: 'Taker买卖比反转',
        triggerCondition: `4H Taker买卖比 >= ${TAKER_THRESHOLD}`,
        takerRatioHistory: klines4h.map(k => ({
          time: k.datetime,
          takerRatio: k.takerRatio || k.takerBuyRatio || null,
          close: k.close
        })),
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: oiData?.currentOI,
        klines1h: klines1h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        significance: 'Taker买卖比从卖出主导反转至买入主导，做空逻辑可能需要重新评估'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-POPCAT-taker-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[POPCAT警报触发] Taker买卖比反转，已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // ⭐ 触发后即归档（引擎自动移动到 rules-archive/，不会删除文件）
    if (this.lastTriggered > 0) return 'completed';

    // 保底：超过 3 天未触发也归档（过期）
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};