/**
 * SSV 持仓量(OI)变化警报
 * 来源: alt-report-SSV-2026-05-13-0250.md
 * 报告观点: OI下降表明多头投降，OI企稳回升是趋势反转的前兆。监控OI变化捕捉趋势转折信号。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'SSV';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000;

// OI 变化阈值：15分钟内OI变化超过15%
const OI_CHANGE_THRESHOLD = 15; // 百分比

module.exports = {
  name: 'SSV-OI变化监控',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,
  lastOI: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      if (!oiData || !oiData.currentOI) {
        console.log(`[🔍警报检查] SSV OI | 数据获取失败，跳过`);
        return false;
      }

      const currentOI = parseFloat(oiData.currentOI);

      if (this.lastOI === null) {
        this.lastOI = currentOI;
        console.log(`[🔍警报检查] SSV OI | 初始化: ${currentOI.toFixed(0)} | 无对比基准`);
        return false;
      }

      const changePct = Math.abs((currentOI - this.lastOI) / this.lastOI * 100);
      const direction = currentOI > this.lastOI ? '增加' : '减少';

      console.log(`[🔍警报检查] SSV OI | 当前: ${currentOI.toFixed(0)} | 上次: ${this.lastOI.toFixed(0)} | 变化: ${changePct.toFixed(1)}% ${direction} | 阈值: ${OI_CHANGE_THRESHOLD}%`);

      this.lastOI = currentOI;

      if (changePct >= OI_CHANGE_THRESHOLD) {
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const oiData = await api.getOKXOpenInterest(COIN);
      const lsData = await api.getOKXLongShortRatio(COIN);
      const takerData = await api.getOKXTakerRatio(COIN);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        openInterest: oiData?.currentOI,
        oiChangePercent: this.lastOI ? Math.abs((parseFloat(oiData.currentOI) - this.lastOI) / this.lastOI * 100).toFixed(2) : null,
        oiDirection: parseFloat(oiData.currentOI) > this.lastOI ? '增加' : '减少',
        longShortRatio: lsData?.currentRatio,
        takerBuyRatio: takerData?.currentRatio,
        alertType: 'OI异动',
        significance: `SSV持仓量${parseFloat(oiData.currentOI) > this.lastOI ? '大幅增加' : '大幅减少'}，可能预示趋势转折`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-oi-${Date.now()}`;
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
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN} OI警报触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};