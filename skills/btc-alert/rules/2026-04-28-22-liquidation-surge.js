/**
 * 清算爆发警报
 * 基于 2026-04-28 22:36 晚间日报分析设立
 * 
 * 背景：$75,000下方堆积15,027 BTC多头清算（最大集群）
 * 日报判断：若半小时内出现5,000+ BTC多头清算，说明清算螺旋启动
 * 清算螺旋一旦启动 → 价格加速下跌 → 需立即评估持仓
 * 
 * 触发条件：最近30分钟多头清算量 ≥ 5,000 BTC
 * 
 * 数据源：OKX /api/v5/public/liquidation-orders（需要代理）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-28';
const COOLDOWN_MS = 60 * 60 * 1000;  // 1小时冷却
const SURGE_THRESHOLD = 5000;         // 30分钟内多头清算 ≥ 5,000 BTC

module.exports = {
  name: '清算爆发警报-5000BTC',
  interval: 5 * 60 * 1000,  // 5分钟检查一次
  lastTriggered: 0,
  
  // 追踪历史清算数据（防抖）
  lastCheckLongLiq: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const liqData = await api.getOKXLiquidation();
      
      if (!liqData) {
        console.log('[🔍警报检查] [API] OKX获取BTC清算数据 | [进度] 清算爆发警报-5000BTC | 数据获取失败，跳过本次检查 | 触发: false');
        return false;
      }
      
      const recentLongLiq = liqData.recent30m.longLiquidation;
      const totalLongLiq = liqData.longLiquidation;
      const totalShortLiq = liqData.shortLiquidation;
      const longShortRatio = totalShortLiq > 0 ? (totalLongLiq / totalShortLiq).toFixed(1) : '∞';
      
      const triggered = recentLongLiq >= SURGE_THRESHOLD;
      
      console.log(`[🔍警报检查] [API] OKX获取BTC清算数据(1600笔) | [进度] ${this.name} | 30m多头清算: ${recentLongLiq.toFixed(0)} BTC | 阈值: ${SURGE_THRESHOLD} BTC | 总清算: 多${totalLongLiq.toFixed(0)}/空${totalShortLiq.toFixed(0)}(${longShortRatio}:1) | 触发: ${triggered} | [来源] 04-28 22:36晚间日报: "$75,000下方堆积15,027 BTC多头清算，若半小时内5,000+ BTC多头清算说明清算螺旋启动"`);
      
      // 更新基线
      this.lastCheckLongLiq = totalLongLiq;
      
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const liqData = await api.getOKXLiquidation();
      const klines15m = await api.getKlines('BTC', '15m', 8);
      
      let oiData = null;
      let takerData = null;
      try {
        oiData = await api.getOKXOpenInterest();
        takerData = await api.getOKXTakerRatio();
      } catch (e) {
        console.log('[数据收集] OKX扩展数据获取失败，继续使用基础数据');
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        liquidation: liqData ? {
          totalOrders: liqData.totalOrders,
          longLiquidation: liqData.longLiquidation,
          shortLiquidation: liqData.shortLiquidation,
          longShortRatio: liqData.shortLiquidation > 0 ? (liqData.longLiquidation / liqData.shortLiquidation).toFixed(1) : '∞',
          recent30m: {
            longLiquidation: liqData.recent30m.longLiquidation,
            shortLiquidation: liqData.recent30m.shortLiquidation
          },
          netLiquidation: liqData.netLiquidation
        } : null,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        threshold: SURGE_THRESHOLD,
        alertType: '清算爆发',
        significance: `最近30分钟多头清算量${liqData.recent30m.longLiquidation} BTC，超过阈值${SURGE_THRESHOLD} BTC，清算螺旋可能已启动。当前价格${ticker.price}，空头仓位需评估风险。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-liq-surge-${Date.now()}`;
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

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}，30m多头清算 ${data.liquidation.recent30m.longLiquidation} BTC`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired'; // 有效期7天（清算风险持续存在）
  }
};
