/**
 * WCT OI 异动警报
 * 
 * 来源：alt-report-WCT-2026-05-12-1448.md
 * 报告观点：OI从5/5的906K增至983K但增速放缓，多空比从2.07降至1.34。
 *          关注OI大幅变化（增加或减少），可能预示资金方向性移动。
 *          WCT市值极小，OI变化对价格影响显著。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const COIN = 'WCT';

// OI变化阈值：WCT是小币，OI基数低，20%变化即为显著异动
const OI_CHANGE_THRESHOLD = 15; // 百分比（从20%降至15%，WCT OI基数约1M，15%变化即±150K）

module.exports = {
  name: 'WCT-OI异动',
  interval: 10 * 60 * 1000, // 10分钟检查
  lastTriggered: 0,
  
  // 记录上次OI值用于计算变化
  lastOI: null,
  lastOITime: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const currentOI = oiData.currentOI;
      const oiChange24h = oiData.change24h; // 24h变化百分比
      
      // 使用24h变化百分比作为主要判断
      // WCT OI基数约900K-1M，20%变化意味着±180K-200K合约量变化
      const isSignificant = Math.abs(oiChange24h) >= OI_CHANGE_THRESHOLD;
      
      // 也检查短期变化（对比上次记录）
      let shortTermChange = null;
      if (this.lastOI !== null) {
        shortTermChange = ((currentOI - this.lastOI) / this.lastOI) * 100;
      }
      
      this.lastOI = currentOI;
      this.lastOITime = Date.now();
      
      const status = isSignificant ? 
        `⚠️ OI异动! 24h变化=${oiChange24h.toFixed(1)}% (阈值=${OI_CHANGE_THRESHOLD}%)` :
        `正常 | OI=${currentOI.toFixed(0)} | 24h变化=${oiChange24h.toFixed(1)}%`;
      
      console.log(`[🔍警报检查] ${COIN} OI | ${status} | 短期变化: ${shortTermChange !== null ? shortTermChange.toFixed(1) + '%' : '首次记录'}`);
      
      return isSignificant;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      const oiData = await api.getOKXOpenInterest(COIN);
      
      let takerData = null;
      try {
        takerData = await api.getOKXTakerRatio(COIN);
      } catch (e) { /* 静默 */ }
      
      const klines1h = await api.getKlines(COIN, '1h', 6);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: 'OI异动',
        
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h,
          volume: oiData.volume,
          threshold: OI_CHANGE_THRESHOLD
        },
        
        takerBuyRatio: takerData?.currentRatio,
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        
        klines1h: klines1h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        significance: `WCT OI 24h变化 ${oiData.change24h.toFixed(1)}%（阈值${OI_CHANGE_THRESHOLD}%），OI=${oiData.currentOI.toFixed(0)}，可能预示资金方向性移动`
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

    console.log(`[${COIN}警报触发] OI异动 | 已派发即时分析任务: ${jobName} | OI变化: ${alertData.openInterest?.change24h}%`);
    
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // 不使用 completed 归档——OI异动警报应持续监控
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};