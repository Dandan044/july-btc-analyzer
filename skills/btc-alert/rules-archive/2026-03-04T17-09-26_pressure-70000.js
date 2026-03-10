/**
 * 压力位触及警报
 * 监控 BTC 价格，当触碰到 70000 时触发警报调试报告
 */

const api = require('../../btc-market-lite/scripts/api');

// 警报创建日期
const CREATED_DATE = '2026-03-04';
const TARGET_PRICE = 70000;

module.exports = {
  name: '压力位触及警报-70000',
  interval: 5 * 60 * 1000, // 每5分钟检查一次

  /**
   * 检测条件
   * 返回 true 表示条件满足，应触发警报
   */
  async check() {
    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;
      
      console.log(`[警报检查] 当前价格: ${currentPrice}, 目标价格: ${TARGET_PRICE}`);
      
      // 价格触碰或突破 70000
      return currentPrice >= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      return false;
    }
  },

  /**
   * 收集数据
   * 获取最近5根15分钟K线数据
   */
  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 5);
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        volume24h: ticker.volume24h,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        alertType: '压力位触及'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return {
        alertTime: new Date().toISOString(),
        error: error.message
      };
    }
  },

  /**
   * 触发动作
   * 执行警报调试报告任务
   */
  async trigger(data) {
    const { execSync } = require('child_process');
    
    const message = `执行任务：警报调试报告

警报名称：压力位触及警报-70000
触发时间：${data.alertTime}
当前价格：${data.currentPrice}
目标价格：${data.triggerPrice}
警报类型：${data.alertType}

收集数据：
${JSON.stringify(data, null, 2)}

请按照 tasks/alert-debug.md 的指引执行调试报告。`;

    try {
      execSync(`openclaw agent --agent july --message "${message.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
        encoding: 'utf-8',
        timeout: 30000
      });
      console.log('[警报触发] 已发送警报调试报告任务');
    } catch (error) {
      console.error('[警报触发错误]', error.message);
    }
  },

  /**
   * 生命周期管理
   * 返回 'active' / 'expired' / 'completed'
   */
  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    
    // 今天有效
    if (today === CREATED_DATE) {
      return 'active';
    }
    
    // 过期
    return 'expired';
  }
};