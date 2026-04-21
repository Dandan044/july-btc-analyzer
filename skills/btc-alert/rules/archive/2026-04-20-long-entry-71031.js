/**
 * 备用做多入场警报 - $71,031（延迟触发：先跌到再反弹确认）
 * 
 * 触发逻辑（两步确认）：
 * 1. 第一步：检测价格是否跌到 $71,031 区域（4h收盘价 <= 71200，给一点缓冲）
 * 2. 第二步：等下一根4h K线收盘，确认价格反弹并企稳在 $71,031 上方
 * 
 * 报告依据：方案B - 若$73,500失守下探$71,031，企稳后布局多单
 * 
 * ========== 当前状态 ==========
 * 当前价格: ~$74,253 | $71,031距当前价约-$3,222(-4.3%)
 * 监控: 价格若跌破$73,500，下一目标为$71,031
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const TARGET_PRICE = 71031;        // 目标入场区域
const DIP_ZONE = 71200;            // 跌入目标区域的缓冲（略高于71031）
const CONFIRM_BARS = 2;            // 确认需要的K线数量
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '备用做多入场-71031',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,
  
  // 延迟触发状态
  dipConfirmed: false,       // 是否已确认价格跌入目标区域
  dipKlineIndex: 0,          // 确认跌入时的K线索引
  confirmingCount: 0,        // 连续确认计数

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取最近3根4小时K线
      const klines = await api.getKlines('BTC', '4h', 3);
      if (!klines || klines.length < CONFIRM_BARS) {
        return false;
      }

      // 取最新的完整K线（已收盘的）
      const lastClosed = klines[klines.length - 1];
      const price = lastClosed.close;
      
      console.log(`[警报检查] 状态=${this.dipConfirmed ? '待确认' : '监控中'}, 4h收盘价=${price}, 目标=${TARGET_PRICE}`);

      if (!this.dipConfirmed) {
        // ====== 阶段1：检测价格是否跌入目标区域 ======
        // 条件：4h收盘价 <= DIP_ZONE（给一点缓冲空间）
        if (price <= DIP_ZONE) {
          this.dipConfirmed = true;
          this.dipKlineIndex = klines.length - 1;
          this.confirmingCount = 0;
          console.log(`[警报检查] ✅ 价格已跌入目标区域！当前=${price}, 目标=${TARGET_PRICE}`);
          console.log(`[警报检查] 开始等待反弹确认...`);
          return false; // 还没触发，继续监控
        }
        return false;
        
      } else {
        // ====== 阶段2：等待价格反弹并企稳 ======
        // 需要价格连续2根4h K线收盘在 $71,031 上方
        
        if (price >= TARGET_PRICE) {
          this.confirmingCount++;
          console.log(`[警报检查] 反弹确认中... 第${this.confirmingCount}/${CONFIRM_BARS}根K线收于${price}`);
          
          if (this.confirmingCount >= CONFIRM_BARS) {
            // 满足连续2根K线收盘 >= 71031，触发！
            console.log(`[警报检查] ✅ 反弹确认完成！连续${CONFIRM_BARS}根K线收盘于目标上方`);
            this.dipConfirmed = false; // 重置状态
            this.confirmingCount = 0;
            return true;
          }
          return false;
        } else {
          // 价格再次跌破目标区域，重置
          console.log(`[警报检查] ⚠️ 价格回落至${price}，低于${TARGET_PRICE}，重置确认状态`);
          this.dipConfirmed = false;
          this.confirmingCount = 0;
          return false;
        }
      }
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '4h', 6);
      const takerData = await api.getOKXTakerRatio();
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        triggerPrice: TARGET_PRICE,
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        alertType: '备用做多入场触发',
        significance: `价格先跌至$71,031区域，随后连续2根4h K线收盘于$71,031上方企稳，方案B做多条件满足`,
        recommendation: '入场$71,100，止损$70,300（风险1.1%），目标$76,500（若形成双底结构）'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-long-backup-${Date.now()}`;
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
    // 有效期至下一个日报周期（下次分析时重新评估）
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 1 ? 'active' : 'expired';
  }
};
