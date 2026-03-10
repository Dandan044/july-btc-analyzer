/**
 * 价格监控警报
 * 定时获取 BTC 价格并发送报告
 */

const api = require('../../btc-market-lite/scripts/api');

// 警报创建日期
const CREATED_DATE = '2026-03-04';

module.exports = {
  name: '价格监控警报',
  interval: 5 * 60 * 1000, // 每5分钟检查一次

  /**
   * 检测条件
   * 无条件触发，始终返回 true
   */
  async check() {
    console.log('[价格监控] 检测执行中...');
    return true;
  },

  /**
   * 收集数据
   * 获取当前 BTC 价格
   */
  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        high: ticker.high,
        low: ticker.low,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        volume24h: ticker.volume24h,
        alertType: '价格监控'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return {
        alertTime: new Date().toISOString(),
        error: error.message,
        alertType: '价格监控'
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

警报名称：价格监控警报
触发时间：${data.alertTime}
警报类型：${data.alertType}

收集数据：
${JSON.stringify(data, null, 2)}

请按照 tasks/alert-debug.md 的指引执行调试报告。`;

    try {
      execSync(`openclaw agent --agent july --message "${message.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
        encoding: 'utf-8',
        timeout: 30000
      });
      console.log('[价格监控] 已发送警报调试报告任务');
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