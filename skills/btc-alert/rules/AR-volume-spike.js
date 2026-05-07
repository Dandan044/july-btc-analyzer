/**
 * AR 成交量异动警报
 * 
 * 监控 AR-USDT-SWAP 4H 成交量，当单根4H K线成交量异常放大时触发即时分析。
 * 
 * 来源：active/alt-AR-20260506-2103/reports/alt-report-AR-2026-05-06-2110.md
 * 创建日期：2026-05-06
 * 
 * 触发条件：最新完成的4H K线成交量 > $8M（约为日均成交量的2-3倍）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'AR';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-06';
const COOLDOWN_MS = 60 * 60 * 1000; // 整体冷却 1小时

module.exports = {
  name: 'AR成交量异动监控',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  // 上次检测到的最高成交量（用于避免同一根K线重复触发）
  lastHighVolume: 0,
  lastHighVolumeTime: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getOKXKlines('AR', '4H', 2);
      if (!klines || klines.length < 2) {
        console.log('[AR成交量警报] 获取K线失败，跳过');
        return false;
      }

      // 使用倒数第二根（已完成的4H K线）
      const completedCandle = klines[klines.length - 2];
      const volume = completedCandle.volume || 0;
      const candleTime = completedCandle.time || 0;
      
      // 成交量阈值：$8M（单根4H K线）
      const VOLUME_THRESHOLD = 8_000_000;
      
      console.log(`[AR成交量警报] 4H K线 ${completedCandle.datetime || candleTime} | 成交量: $${(volume/1e6).toFixed(2)}M | 阈值: $8M | O:$${completedCandle.open} H:$${completedCandle.high} L:$${completedCandle.low} C:$${completedCandle.close}`);

      // 避免同一根K线重复触发
      if (candleTime <= this.lastHighVolumeTime) {
        return false;
      }

      if (volume >= VOLUME_THRESHOLD) {
        this.lastHighVolume = volume;
        this.lastHighVolumeTime = candleTime;
        console.log(`[AR成交量警报] ⚡ 触发！4H成交量 $${(volume/1e6).toFixed(2)}M 超过阈值`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[AR成交量警报错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('AR');
      const klines4h = await api.getOKXKlines('AR', '4H', 4);
      const klines15m = await api.getOKXKlines('AR', '15m', 8);
      
      // OI
      let oiData = null;
      try {
        const { execSync } = require('child_process');
        const PROXY = 'http://127.0.0.1:7890';
        const oiRaw = execSync(`curl -s --max-time 10 --proxy "${PROXY}" "https://www.okx.com/api/v5/public/open-interest?instId=AR-USDT-SWAP"`, { encoding: 'utf8', timeout: 15000 });
        const oiJson = JSON.parse(oiRaw);
        if (oiJson.data && oiJson.data.length > 0) {
          oiData = { oi: oiJson.data[0].oi, oiUsd: oiJson.data[0].oiUsd };
        }
      } catch (e) { /* 静默 */ }

      const volCandle = klines4h[klines4h.length - 2] || klines4h[0];
      
      return {
        coin: 'AR',
        alertTime: new Date().toISOString(),
        alertName: 'AR成交量异动',
        alertType: 'volume_spike',
        currentPrice: ticker.price,
        
        volumeSignal: {
          candleTime: volCandle.datetime || volCandle.time,
          volume: this.lastHighVolume,
          volumeFormatted: `$${(this.lastHighVolume / 1e6).toFixed(2)}M`,
          threshold: '$8M',
          open: volCandle.open,
          high: volCandle.high,
          low: volCandle.low,
          close: volCandle.close
        },
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        openInterest: oiData,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        significance: `AR 4H成交量异动: ${volCandle.datetime}, $${(this.lastHighVolume/1e6).toFixed(2)}M (阈值$8M), 价格区间 $${volCandle.low}-$${volCandle.high}, 收盘 $${volCandle.close}`
      };
    } catch (error) {
      console.error('[AR成交量数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-ar-vol-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行技术分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [